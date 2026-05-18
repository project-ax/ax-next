import { describe, it, expect } from 'vitest';
import { validateNewAttachments } from '../skill-attachments-validation.js';

// Minimal resolved-skill shapes used across test cases.
function makeSkill(
  id: string,
  slots: Array<{ slot: string; kind?: 'api-key' }>,
) {
  return {
    id,
    capabilities: {
      allowedHosts: [`api.${id}.example.com`],
      credentials: slots.map(({ slot, kind = 'api-key' as const }) => ({
        slot,
        kind,
      })),
    },
    bodyMd: `## ${id}`,
    manifestYaml: `name: ${id}\n`,
  };
}

describe('validateNewAttachments', () => {
  it('1. empty attachments + empty skills + empty reservedSlots → ok with empty array', () => {
    const result = validateNewAttachments([], [], []);
    expect(result).toEqual({ ok: true, validated: [] });
  });

  it('2. valid attachment with one skill + matching bindings → ok', () => {
    const result = validateNewAttachments(
      [{ skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'cred-ref-abc' } }],
      [makeSkill('github', [{ slot: 'GITHUB_TOKEN' }])],
      [],
    );
    expect(result).toEqual({
      ok: true,
      validated: [{ skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'cred-ref-abc' } }],
    });
  });

  it('3. attachment referencing unresolved skillId → skill-not-found', () => {
    const result = validateNewAttachments(
      [{ skillId: 'nonexistent', credentialBindings: {} }],
      [], // no resolved skills
      [],
    );
    expect(result).toEqual({
      ok: false,
      code: 'skill-not-found',
      message: expect.stringContaining('nonexistent'),
    });
  });

  it('4. attachment with binding for slot not declared by skill → binding-orphan', () => {
    const result = validateNewAttachments(
      [{ skillId: 'github', credentialBindings: { UNKNOWN_SLOT: 'ref' } }],
      [makeSkill('github', [{ slot: 'GITHUB_TOKEN' }])],
      [],
    );
    expect(result).toEqual({
      ok: false,
      code: 'binding-orphan',
      message: expect.stringContaining('UNKNOWN_SLOT'),
    });
  });

  it('5. attachment missing binding for a declared slot → binding-missing', () => {
    const result = validateNewAttachments(
      [{ skillId: 'github', credentialBindings: {} }], // GITHUB_TOKEN not provided
      [makeSkill('github', [{ slot: 'GITHUB_TOKEN' }])],
      [],
    );
    expect(result).toEqual({
      ok: false,
      code: 'binding-missing',
      message: expect.stringContaining('GITHUB_TOKEN'),
    });
  });

  it('6. two attachments declaring the same slot → slot-collision with second skill named', () => {
    const result = validateNewAttachments(
      [
        { skillId: 'github', credentialBindings: { SHARED_TOKEN: 'ref1' } },
        { skillId: 'other', credentialBindings: { SHARED_TOKEN: 'ref2' } },
      ],
      [
        makeSkill('github', [{ slot: 'SHARED_TOKEN' }]),
        makeSkill('other', [{ slot: 'SHARED_TOKEN' }]),
      ],
      [],
    );
    expect(result).toEqual({
      ok: false,
      code: 'slot-collision',
      message: expect.stringContaining('SHARED_TOKEN'),
    });
    expect((result as { message: string }).message).toContain('other');
  });

  it('7. attachment declaring a slot that is in reservedAgentSlots → slot-collision with <agent.requiredCredentials>', () => {
    const result = validateNewAttachments(
      [{ skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref1' } }],
      [makeSkill('github', [{ slot: 'GITHUB_TOKEN' }])],
      ['GITHUB_TOKEN'], // reserved by the agent itself
    );
    expect(result).toEqual({
      ok: false,
      code: 'slot-collision',
      message: expect.stringContaining('<agent.requiredCredentials>'),
    });
  });

  it('multiple skills with disjoint slots → ok', () => {
    const result = validateNewAttachments(
      [
        { skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref1' } },
        { skillId: 'openai', credentialBindings: { OPENAI_API_KEY: 'ref2' } },
      ],
      [
        makeSkill('github', [{ slot: 'GITHUB_TOKEN' }]),
        makeSkill('openai', [{ slot: 'OPENAI_API_KEY' }]),
      ],
      [],
    );
    expect(result).toEqual({
      ok: true,
      validated: [
        { skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref1' } },
        { skillId: 'openai', credentialBindings: { OPENAI_API_KEY: 'ref2' } },
      ],
    });
  });
});
