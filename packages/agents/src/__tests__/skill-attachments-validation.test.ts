import { describe, it, expect } from 'vitest';
import { validateNewAttachments } from '../skill-attachments-validation.js';

// TASK-100 — a skill manifest declares NO credential slots (its reach is the
// connectors it references), so the validator's job narrows to: the skill must
// exist, and the attachment must carry NO credential bindings (any binding is a
// `binding-orphan`). There is no per-skill slot set, so binding-missing /
// invalid-slot / slot-collision no longer apply.

// Minimal resolved-skill shape (cap-free, matching ResolvedSkillShape).
function makeSkill(id: string) {
  return {
    id,
    bodyMd: `## ${id}`,
    manifestYaml: `name: ${id}\n`,
  };
}

describe('validateNewAttachments', () => {
  it('1. empty attachments + empty skills → ok with empty array', () => {
    const result = validateNewAttachments([], [], []);
    expect(result).toEqual({ ok: true, validated: [] });
  });

  it('2. valid attachment with no bindings → ok', () => {
    const result = validateNewAttachments(
      [{ skillId: 'github', credentialBindings: {} }],
      [makeSkill('github')],
      [],
    );
    expect(result).toEqual({
      ok: true,
      validated: [{ skillId: 'github', credentialBindings: {} }],
    });
  });

  it('3. attachment referencing an unresolved skillId → skill-not-found', () => {
    const result = validateNewAttachments(
      [{ skillId: 'nonexistent', credentialBindings: {} }],
      [],
      [],
    );
    expect(result).toEqual({
      ok: false,
      code: 'skill-not-found',
      message: expect.stringContaining('nonexistent'),
    });
  });

  it('4. ANY credential binding → binding-orphan (a skill declares no slots)', () => {
    const result = validateNewAttachments(
      [{ skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref' } }],
      [makeSkill('github')],
      [],
    );
    expect(result).toEqual({
      ok: false,
      code: 'binding-orphan',
      message: expect.stringContaining('GITHUB_TOKEN'),
    });
  });

  it('multiple cap-free skills → ok', () => {
    const result = validateNewAttachments(
      [
        { skillId: 'github', credentialBindings: {} },
        { skillId: 'openai', credentialBindings: {} },
      ],
      [makeSkill('github'), makeSkill('openai')],
      [],
    );
    expect(result).toEqual({
      ok: true,
      validated: [
        { skillId: 'github', credentialBindings: {} },
        { skillId: 'openai', credentialBindings: {} },
      ],
    });
  });
});
