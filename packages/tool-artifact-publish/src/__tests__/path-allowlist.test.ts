import { describe, it, expect } from 'vitest';
import {
  checkPublishablePath,
  describeRoots,
  MAX_ARTIFACT_BYTES,
  MAX_DISPLAY_NAME_CHARS,
} from '../path-allowlist.js';

// The allowlist validates against the session's REAL roots, not hardcoded
// sandbox-absolute literals. These use k8s-shaped roots in most cases because
// they read clearly, and subprocess-shaped (mkdtemp) roots where the point is
// specifically that literals are not assumed.

const FILES = '/files';
const EPHEM = '/ephemeral';
const BOTH = { userFilesRoot: FILES, ephemeralRoot: EPHEM };

describe('checkPublishablePath', () => {
  describe('the durable user-files tier', () => {
    // The case the old allowlist rejected outright: the agent's cwd, where the
    // operating notes tell it to put anything it wants to keep, and therefore
    // where a deliverable lands by default.
    it('accepts a file at the root of the tier', () => {
      expect(checkPublishablePath('/files/report.pdf', BOTH)).toEqual({
        ok: true,
        root: 'user-files',
        base: '/files',
        relativePath: 'report.pdf',
      });
    });

    it('accepts a nested file', () => {
      expect(checkPublishablePath('/files/q4/decks/final.pdf', BOTH)).toEqual({
        ok: true,
        root: 'user-files',
        base: '/files',
        relativePath: 'q4/decks/final.pdf',
      });
    });

    it('rejects the bare root (a directory is not a file)', () => {
      expect(checkPublishablePath('/files', BOTH).ok).toBe(false);
      expect(checkPublishablePath('/files/', BOTH).ok).toBe(false);
    });

    it('is not fooled by a sibling whose name merely starts with the root', () => {
      // `/filesX` shares a textual prefix with `/files` but is a different tree;
      // a naive startsWith on the un-slashed root would accept it.
      expect(checkPublishablePath('/filesX/secret', BOTH).ok).toBe(false);
      expect(checkPublishablePath('/files-backup/secret', BOTH).ok).toBe(false);
    });
  });

  describe('the scratch tier', () => {
    it('accepts paths under its artifacts/ namespace', () => {
      expect(checkPublishablePath('/ephemeral/artifacts/report.pdf', BOTH)).toEqual({
        ok: true,
        root: 'ephemeral',
        base: '/ephemeral/artifacts',
        relativePath: 'report.pdf',
      });
    });

    it('accepts nested paths under artifacts/', () => {
      expect(checkPublishablePath('/ephemeral/artifacts/sub/dir/img.png', BOTH)).toEqual({
        ok: true,
        root: 'ephemeral',
        base: '/ephemeral/artifacts',
        relativePath: 'sub/dir/img.png',
      });
    });

    it('rejects the rest of the tier (venv, caches, build trees)', () => {
      expect(checkPublishablePath('/ephemeral/.venv/secret', BOTH).ok).toBe(false);
      expect(checkPublishablePath('/ephemeral/uploads/c/t/f', BOTH).ok).toBe(false);
      expect(checkPublishablePath('/ephemeral/report.pdf', BOTH).ok).toBe(false);
    });

    it('rejects the bare artifacts/ prefix with no file component', () => {
      expect(checkPublishablePath('/ephemeral/artifacts', BOTH).ok).toBe(false);
      expect(checkPublishablePath('/ephemeral/artifacts/', BOTH).ok).toBe(false);
    });
  });

  describe('the governed tier is not publishable at all', () => {
    // `/agent/workspace/**` used to be allowed as the "Pattern A" carve-out — a
    // fossil of the pre-split layout, pointing at a directory nothing creates.
    // Dropping it also puts the agent's own identity, memory and transcripts
    // structurally out of reach of a "publish your instructions" injection.
    it('rejects the retired /agent/workspace/ fossil', () => {
      expect(checkPublishablePath('/agent/workspace/reports/Q4.pdf', BOTH).ok).toBe(false);
    });

    it('rejects the agent state a prompt injection would target', () => {
      for (const p of [
        '/agent/.ax/SOUL.md',
        '/agent/.ax/sessions/sess1.jsonl',
        '/agent/.claude/projects/x/session.jsonl',
        '/agent/.ax/uploads/c/t/private.pdf',
        '/agent/memory/system/rules.md',
      ]) {
        expect(checkPublishablePath(p, BOTH).ok).toBe(false);
      }
    });
  });

  describe('traversal and shape', () => {
    it('rejects traversal that would escape either tier', () => {
      expect(checkPublishablePath('/files/../etc/passwd', BOTH).ok).toBe(false);
      expect(checkPublishablePath('/files/a/../../etc/passwd', BOTH).ok).toBe(false);
      expect(checkPublishablePath('/ephemeral/artifacts/../../etc/passwd', BOTH).ok).toBe(false);
      expect(checkPublishablePath('/ephemeral/artifacts/../.venv/k', BOTH).ok).toBe(false);
    });

    it('normalises traversal that stays INSIDE the tier rather than rejecting it', () => {
      // `path.resolve` collapses this to /files/bar, which is publishable. The
      // old check refused any path containing `..` textually; normalising is
      // both more accurate and what the executor then reads.
      expect(checkPublishablePath('/files/foo/../bar.pdf', BOTH)).toEqual({
        ok: true,
        root: 'user-files',
        base: '/files',
        relativePath: 'bar.pdf',
      });
    });

    it('rejects relative paths', () => {
      expect(checkPublishablePath('report.pdf', BOTH).ok).toBe(false);
      expect(checkPublishablePath('artifacts/report.pdf', BOTH).ok).toBe(false);
      expect(checkPublishablePath('../files/report.pdf', BOTH).ok).toBe(false);
    });

    it('rejects the empty path and non-strings', () => {
      expect(checkPublishablePath('', BOTH).ok).toBe(false);
      expect(checkPublishablePath(undefined as unknown as string, BOTH).ok).toBe(false);
    });

    it('rejects anything outside both roots', () => {
      expect(checkPublishablePath('/etc/passwd', BOTH).ok).toBe(false);
      expect(checkPublishablePath('/', BOTH).ok).toBe(false);
    });
  });

  describe('roots are runtime values, not literals', () => {
    // The regression that made this tool unusable outside k8s: the model is told
    // its real roots in the operating notes, so a real path must validate and a
    // literal from another deployment shape must not.
    const SUBPROC = {
      userFilesRoot: '/var/folders/xy/T/ax-userfiles-abc/agent-1',
      ephemeralRoot: '/var/folders/xy/T/ax-ipc-def/ephemeral',
    };

    it('accepts the real mkdtemp-shaped paths the subprocess sandbox hands out', () => {
      const r = checkPublishablePath(`${SUBPROC.userFilesRoot}/report.pdf`, SUBPROC);
      expect(r.ok).toBe(true);
      const e = checkPublishablePath(`${SUBPROC.ephemeralRoot}/artifacts/x.png`, SUBPROC);
      expect(e.ok).toBe(true);
    });

    it('rejects the k8s literals when those are not the roots of this session', () => {
      expect(checkPublishablePath('/files/report.pdf', SUBPROC).ok).toBe(false);
      expect(checkPublishablePath('/ephemeral/artifacts/x.png', SUBPROC).ok).toBe(false);
    });

    it('tolerates a trailing slash on a configured root', () => {
      const r = checkPublishablePath('/files/report.pdf', {
        userFilesRoot: '/files/',
        ephemeralRoot: '/ephemeral/',
      });
      expect(r).toEqual({
        ok: true,
        root: 'user-files',
        base: '/files',
        relativePath: 'report.pdf',
      });
    });
  });

  describe('partially-wired deployments', () => {
    it('publishes from scratch only when no durable mount is wired', () => {
      const roots = { ephemeralRoot: EPHEM };
      expect(checkPublishablePath('/ephemeral/artifacts/r.pdf', roots).ok).toBe(true);
      expect(checkPublishablePath('/files/r.pdf', roots).ok).toBe(false);
    });

    it('publishes from the durable tier only when no scratch tier is wired', () => {
      const roots = { userFilesRoot: FILES };
      expect(checkPublishablePath('/files/r.pdf', roots).ok).toBe(true);
      expect(checkPublishablePath('/ephemeral/artifacts/r.pdf', roots).ok).toBe(false);
    });

    it('publishes nothing, and says so, when neither is wired', () => {
      const result = checkPublishablePath('/files/r.pdf', {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('no publishable location wired');
      }
    });
  });

  describe('rejection messages name the real paths of this session', () => {
    // A rejection that names a literal from another deployment is how the model
    // ends up retrying a path it can never write to.
    it('lists both live roots', () => {
      const result = checkPublishablePath('/etc/passwd', BOTH);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('/files/**');
        expect(result.reason).toContain('/ephemeral/artifacts/**');
      }
    });

    it('never names the retired literals', () => {
      const result = checkPublishablePath('/etc/passwd', BOTH);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).not.toContain('/agent/workspace');
      }
    });

    it('describeRoots degrades honestly with nothing wired', () => {
      expect(describeRoots({})).toContain('no publishable location wired');
    });
  });

  it('exposes the caps', () => {
    expect(MAX_ARTIFACT_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_DISPLAY_NAME_CHARS).toBe(256);
  });
});
