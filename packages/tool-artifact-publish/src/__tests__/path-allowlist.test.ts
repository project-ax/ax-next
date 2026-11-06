import { describe, it, expect } from 'vitest';
import {
  checkPublishablePath,
  describeRoots,
  MAX_ARTIFACT_BYTES,
} from '../path-allowlist.js';

// The allowlist validates against the session's REAL files root, not a
// hardcoded sandbox-absolute literal. These use a k8s-shaped root in most cases
// because it reads clearly, and subprocess-shaped (mkdtemp) roots where the
// point is specifically that literals are not assumed.

const FILES = '/files';
const ROOTS = { userFilesRoot: FILES };

describe('checkPublishablePath', () => {
  describe('the files folder', () => {
    // The agent's cwd, where the operating notes tell it to put anything it
    // wants to keep, and therefore where a deliverable lands by default.
    it('accepts a file at the root of the folder', () => {
      expect(checkPublishablePath('/files/report.pdf', ROOTS)).toEqual({
        ok: true,
        base: '/files',
        relativePath: 'report.pdf',
      });
    });

    it('accepts a nested file', () => {
      expect(checkPublishablePath('/files/q4/decks/final.pdf', ROOTS)).toEqual({
        ok: true,
        base: '/files',
        relativePath: 'q4/decks/final.pdf',
      });
    });

    it('rejects the bare root (a directory is not a file)', () => {
      expect(checkPublishablePath('/files', ROOTS).ok).toBe(false);
      expect(checkPublishablePath('/files/', ROOTS).ok).toBe(false);
    });

    it('is not fooled by a sibling whose name merely starts with the root', () => {
      // `/filesX` shares a textual prefix with `/files` but is a different tree;
      // a naive startsWith on the un-slashed root would accept it.
      expect(checkPublishablePath('/filesX/secret', ROOTS).ok).toBe(false);
      expect(checkPublishablePath('/files-backup/secret', ROOTS).ok).toBe(false);
    });
  });

  describe('the scratch root is not publishable at all (C2)', () => {
    // Publishing is only from the files folder. The scratch root holds the
    // person's uploads, the SDK's conversation log, the venv and caches, and
    // its old artifacts/ namespace is gone with the rest of it.
    it('refuses a scratch artifacts/ path', () => {
      for (const p of ['/tmp/artifacts/report.pdf', '/ephemeral/artifacts/report.pdf']) {
        const result = checkPublishablePath(p, ROOTS);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/^artifact-path-not-publishable:/);
      }
    });

    it('refuses uploads, transcripts and anything else in the scratch root', () => {
      for (const p of ['/tmp/uploads/a.pdf', '/tmp/transcripts/s.jsonl', '/tmp/a.txt', '/tmp/.venv/k']) {
        expect(checkPublishablePath(p, ROOTS).ok).toBe(false);
      }
    });
  });

  describe('the retired /agent tier is not publishable at all', () => {
    // `/agent` was the versioned workspace tier (removed in TASK-995), and
    // `/agent/workspace/**` was once allowed as its "Pattern A" carve-out — a
    // fossil of the pre-split layout. Neither is a root, so nothing under them
    // is publishable; these pin that the old paths stay refused.
    it('rejects the retired /agent/workspace/ fossil', () => {
      expect(checkPublishablePath('/agent/workspace/reports/Q4.pdf', ROOTS).ok).toBe(false);
    });

    it('rejects the agent state a prompt injection would target', () => {
      for (const p of [
        '/agent/.ax/SOUL.md',
        '/agent/.ax/sessions/sess1.jsonl',
        '/agent/.claude/projects/x/session.jsonl',
        '/agent/.ax/uploads/c/t/private.pdf',
        '/agent/memory/system/rules.md',
      ]) {
        expect(checkPublishablePath(p, ROOTS).ok).toBe(false);
      }
    });
  });

  describe('traversal and shape', () => {
    it('rejects traversal that would escape the folder', () => {
      expect(checkPublishablePath('/files/../etc/passwd', ROOTS).ok).toBe(false);
      expect(checkPublishablePath('/files/a/../../etc/passwd', ROOTS).ok).toBe(false);
    });

    it('normalises traversal that stays INSIDE the folder rather than rejecting it', () => {
      // `path.resolve` collapses this to /files/bar, which is publishable.
      expect(checkPublishablePath('/files/foo/../bar.pdf', ROOTS)).toEqual({
        ok: true,
        base: '/files',
        relativePath: 'bar.pdf',
      });
    });

    it('rejects relative paths (the executor resolves them against the files root first)', () => {
      expect(checkPublishablePath('report.pdf', ROOTS).ok).toBe(false);
      expect(checkPublishablePath('../files/report.pdf', ROOTS).ok).toBe(false);
    });

    it('rejects the empty path and non-strings', () => {
      expect(checkPublishablePath('', ROOTS).ok).toBe(false);
      expect(checkPublishablePath(undefined as unknown as string, ROOTS).ok).toBe(false);
    });

    it('rejects anything outside the folder', () => {
      expect(checkPublishablePath('/etc/passwd', ROOTS).ok).toBe(false);
      expect(checkPublishablePath('/', ROOTS).ok).toBe(false);
    });
  });

  describe('roots are runtime values, not literals', () => {
    // The model is told its real files root in the operating notes, so a real
    // path must validate and a literal from another deployment shape must not.
    const SUBPROC = { userFilesRoot: '/var/folders/xy/T/ax-userfiles-abc/agent-1' };

    it('accepts the real mkdtemp-shaped paths the subprocess sandbox hands out', () => {
      expect(checkPublishablePath(`${SUBPROC.userFilesRoot}/report.pdf`, SUBPROC).ok).toBe(true);
    });

    it('rejects the k8s literal when it is not the root of this session', () => {
      expect(checkPublishablePath('/files/report.pdf', SUBPROC).ok).toBe(false);
    });

    it('tolerates a trailing slash on a configured root', () => {
      expect(checkPublishablePath('/files/report.pdf', { userFilesRoot: '/files/' })).toEqual({
        ok: true,
        base: '/files',
        relativePath: 'report.pdf',
      });
    });
  });

  it('publishes nothing, and says so, when no files folder is wired', () => {
    const result = checkPublishablePath('/files/r.pdf', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no publishable location wired');
  });

  describe('rejection messages name the real path of this session', () => {
    // A rejection that names a literal from another deployment is how the model
    // ends up retrying a path it can never write to.
    it('names the live files root and nothing else', () => {
      const result = checkPublishablePath('/etc/passwd', ROOTS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('/files/**');
        expect(result.reason).not.toContain('artifacts/**');
        expect(result.reason).not.toContain('/agent/workspace');
      }
    });

    it('describeRoots degrades honestly with nothing wired', () => {
      expect(describeRoots({})).toContain('no publishable location wired');
    });
  });

  describe('the facts export (/memory) is not publishable — design §11', () => {
    it('rejects /memory and anything under it with a k8s-shaped root', () => {
      expect(checkPublishablePath('/memory/facts/a.md', ROOTS).ok).toBe(false);
      expect(checkPublishablePath('/memory', ROOTS).ok).toBe(false);
    });

    it('rejects a sibling memory tree next to a subprocess-shaped root', () => {
      const base = '/tmp/ax-sbx-123';
      expect(checkPublishablePath(`${base}/memory/facts/a.md`, { userFilesRoot: `${base}/files` }).ok).toBe(false);
    });
  });

  it('exposes the size cap', () => {
    expect(MAX_ARTIFACT_BYTES).toBe(100 * 1024 * 1024);
  });
});
