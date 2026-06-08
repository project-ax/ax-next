import { describe, it, expect } from 'vitest';
import { checkDraftPath, draftPrefix } from '../draft-paths.js';

// The draft root is now dynamic (filestore-user-files Phase 3, design §7): drafts
// stage under `<root>/.skill-draft/<id>/` where `root` = AX_USERFILES_ROOT (durable
// per-agent mount, e.g. `/workspace`) ?? the ephemeral scratch root (fallback). The
// executor passes the active root; checkDraftPath validates the model path against it.

const WORKSPACE = '/workspace';
const EPHEMERAL = '/ephemeral';

describe('draftPrefix', () => {
  it('builds the dotted `.skill-draft/` prefix under the active root', () => {
    expect(draftPrefix(WORKSPACE)).toBe('/workspace/.skill-draft/');
    expect(draftPrefix(EPHEMERAL)).toBe('/ephemeral/.skill-draft/');
  });

  it('normalizes a trailing slash on the root', () => {
    expect(draftPrefix('/workspace/')).toBe('/workspace/.skill-draft/');
  });
});

describe('checkDraftPath', () => {
  // Run the full battery under BOTH a durable (/workspace) and ephemeral
  // (/ephemeral) root so the parameterized prefix is exercised on each.
  for (const root of [WORKSPACE, EPHEMERAL]) {
    describe(`under root ${root}`, () => {
      const prefix = draftPrefix(root);

      it('accepts a valid draft dir and returns the skill id + relative dir', () => {
        const r = checkDraftPath(`${prefix}linear`, root);
        expect(r).toEqual({ ok: true, skillId: 'linear', relativeDir: '.skill-draft/linear' });
      });

      it('accepts a trailing slash', () => {
        const r = checkDraftPath(`${prefix}commit-style/`, root);
        expect(r).toEqual({
          ok: true,
          skillId: 'commit-style',
          relativeDir: '.skill-draft/commit-style',
        });
      });

      it('rejects an empty path', () => {
        expect(checkDraftPath('', root).ok).toBe(false);
      });

      it('rejects a path outside the active prefix', () => {
        expect(checkDraftPath(`${root}/artifacts/x`, root).ok).toBe(false);
        expect(checkDraftPath('/agent/.ax/draft-skills/linear', root).ok).toBe(false);
        expect(checkDraftPath('/etc/passwd', root).ok).toBe(false);
      });

      it('rejects a bare prefix with no id', () => {
        expect(checkDraftPath(prefix, root).ok).toBe(false);
        expect(checkDraftPath(prefix.slice(0, -1), root).ok).toBe(false);
      });

      it('rejects a nested path (only the <id> directory segment is allowed)', () => {
        expect(checkDraftPath(`${prefix}linear/SKILL.md`, root).ok).toBe(false);
        expect(checkDraftPath(`${prefix}linear/scripts/run.py`, root).ok).toBe(false);
      });

      it('rejects traversal', () => {
        expect(checkDraftPath(`${prefix}..`, root).ok).toBe(false);
        expect(checkDraftPath(`${prefix}../../etc`, root).ok).toBe(false);
      });

      it('rejects an id that fails the strict skill grammar', () => {
        expect(checkDraftPath(`${prefix}Linear`, root).ok).toBe(false);
        expect(checkDraftPath(`${prefix}1up`, root).ok).toBe(false);
        expect(checkDraftPath(`${prefix}my.skill`, root).ok).toBe(false);
        expect(checkDraftPath(`${prefix}my_skill`, root).ok).toBe(false);
        expect(checkDraftPath(`${prefix}${'a'.repeat(65)}`, root).ok).toBe(false);
      });
    });
  }

  it('rejects a /workspace draft path when the active root is /ephemeral (and vice versa)', () => {
    // A draft validated against the wrong root must be rejected — the executor
    // always validates against the root it will read from, so a path under a
    // DIFFERENT root never resolves.
    expect(checkDraftPath('/workspace/.skill-draft/linear', EPHEMERAL).ok).toBe(false);
    expect(checkDraftPath('/ephemeral/.skill-draft/linear', WORKSPACE).ok).toBe(false);
  });
});
