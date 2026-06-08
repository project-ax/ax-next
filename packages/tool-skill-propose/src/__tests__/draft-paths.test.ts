import { describe, it, expect } from 'vitest';
import { checkDraftPath } from '../draft-paths.js';

describe('checkDraftPath', () => {
  it('accepts a valid draft dir and returns the skill id + relative dir', () => {
    const r = checkDraftPath('/ephemeral/skill-draft/linear');
    expect(r).toEqual({ ok: true, skillId: 'linear', relativeDir: 'skill-draft/linear' });
  });

  it('accepts a trailing slash', () => {
    const r = checkDraftPath('/ephemeral/skill-draft/commit-style/');
    expect(r).toEqual({
      ok: true,
      skillId: 'commit-style',
      relativeDir: 'skill-draft/commit-style',
    });
  });

  it('rejects an empty path', () => {
    expect(checkDraftPath('').ok).toBe(false);
  });

  it('rejects a path outside /ephemeral/skill-draft/', () => {
    expect(checkDraftPath('/ephemeral/artifacts/x').ok).toBe(false);
    expect(checkDraftPath('/agent/.ax/draft-skills/linear').ok).toBe(false);
    expect(checkDraftPath('/etc/passwd').ok).toBe(false);
  });

  it('rejects a bare prefix with no id', () => {
    expect(checkDraftPath('/ephemeral/skill-draft/').ok).toBe(false);
    expect(checkDraftPath('/ephemeral/skill-draft').ok).toBe(false);
  });

  it('rejects a nested path (only the <id> directory segment is allowed)', () => {
    expect(checkDraftPath('/ephemeral/skill-draft/linear/SKILL.md').ok).toBe(false);
    expect(checkDraftPath('/ephemeral/skill-draft/linear/scripts/run.py').ok).toBe(false);
  });

  it('rejects traversal', () => {
    expect(checkDraftPath('/ephemeral/skill-draft/..').ok).toBe(false);
    expect(checkDraftPath('/ephemeral/skill-draft/../../etc').ok).toBe(false);
  });

  it('rejects an id that fails the strict skill grammar', () => {
    // uppercase
    expect(checkDraftPath('/ephemeral/skill-draft/Linear').ok).toBe(false);
    // leading digit
    expect(checkDraftPath('/ephemeral/skill-draft/1up').ok).toBe(false);
    // dot/underscore not allowed in the installable grammar
    expect(checkDraftPath('/ephemeral/skill-draft/my.skill').ok).toBe(false);
    expect(checkDraftPath('/ephemeral/skill-draft/my_skill').ok).toBe(false);
    // too long (>64)
    expect(checkDraftPath(`/ephemeral/skill-draft/${'a'.repeat(65)}`).ok).toBe(false);
  });
});
