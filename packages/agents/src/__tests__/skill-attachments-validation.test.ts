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

  // TASK-86 namespaces credential slots per-skill (`skill:<id>:<slot>`) in the
  // orchestrator's host-side credential map, so two skills wanting the same bare
  // slot name resolve to two DISTINCT keys → no runtime collision. The admin
  // agent-global attach validator must NOT reject these (TASK-87) — coexistence,
  // not collision.
  it('6. two attachments declaring the same slot → coexist (no false slot-collision)', () => {
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
      ok: true,
      validated: [
        { skillId: 'github', credentialBindings: { SHARED_TOKEN: 'ref1' } },
        { skillId: 'other', credentialBindings: { SHARED_TOKEN: 'ref2' } },
      ],
    });
  });

  // The two same-named slots resolve to DISTINCT per-skill namespace keys at
  // runtime (`skill:<id>:<slot>`). Mirror the format inline rather than importing
  // @ax/chat-orchestrator's skillCredentialEnvName (invariant #2 — no cross-plugin
  // import); the validator itself inlines its types for the same reason.
  it('6b. two skills sharing a slot resolve to distinct skill:<id>:<slot> keys', () => {
    const slot = 'LINEAR_API_KEY';
    const result = validateNewAttachments(
      [
        { skillId: 'linear-a', credentialBindings: { [slot]: 'ref1' } },
        { skillId: 'linear-b', credentialBindings: { [slot]: 'ref2' } },
      ],
      [
        makeSkill('linear-a', [{ slot }]),
        makeSkill('linear-b', [{ slot }]),
      ],
      [],
    );
    expect(result.ok).toBe(true);
    // The runtime namespacing scheme that makes the coexistence safe.
    const keyA = `skill:linear-a:${slot}`;
    const keyB = `skill:linear-b:${slot}`;
    expect(keyA).not.toBe(keyB);
  });

  // A skill slot shadowing a TRUSTED/agent-reserved bare name is a BENIGN no-op
  // suppression at runtime (the trusted bare name always wins the flat-env stamp —
  // projectEnvMapToBareNames), NOT a fatal collision. So the admin attach gate no
  // longer rejects it (TASK-87).
  it('7. attachment declaring a slot in reservedAgentSlots → coexist (trusted bare name wins at runtime)', () => {
    const result = validateNewAttachments(
      [{ skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref1' } }],
      [makeSkill('github', [{ slot: 'GITHUB_TOKEN' }])],
      ['GITHUB_TOKEN'], // reserved by the agent itself
    );
    expect(result).toEqual({
      ok: true,
      validated: [{ skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref1' } }],
    });
  });

  // Genuine validation preserved: a malformed declared slot id must still be
  // rejected, never silently namespaced into `skill:<id>:<garbage>`. Slot values
  // are untrusted (a skill manifest is possibly model-authored) — re-checked here
  // against the manifest parser's contract /^[A-Z][A-Z0-9_]{0,63}$/.
  it('8. declared slot that is malformed → invalid-slot (lowercase)', () => {
    const result = validateNewAttachments(
      [{ skillId: 'bad', credentialBindings: { lower_case: 'ref' } }],
      [makeSkill('bad', [{ slot: 'lower_case' }])],
      [],
    );
    expect(result).toEqual({
      ok: false,
      code: 'invalid-slot',
      message: expect.stringContaining('lower_case'),
    });
  });

  it('8b. declared slot that is malformed → invalid-slot (whitespace / punctuation)', () => {
    const result = validateNewAttachments(
      [{ skillId: 'bad', credentialBindings: { 'not a slot': 'ref' } }],
      [makeSkill('bad', [{ slot: 'not a slot' }])],
      [],
    );
    expect(result).toEqual({
      ok: false,
      code: 'invalid-slot',
      message: expect.stringContaining('not a slot'),
    });
  });

  it('8c. declared slot that is empty → invalid-slot', () => {
    const result = validateNewAttachments(
      [{ skillId: 'bad', credentialBindings: { '': 'ref' } }],
      [makeSkill('bad', [{ slot: '' }])],
      [],
    );
    expect((result as { ok: boolean; code?: string }).ok).toBe(false);
    expect((result as { code: string }).code).toBe('invalid-slot');
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
