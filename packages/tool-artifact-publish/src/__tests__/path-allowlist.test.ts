import { describe, it, expect } from 'vitest';
import { checkPublishablePath, MAX_ARTIFACT_BYTES } from '../path-allowlist.js';

// TASK-68: the artifact namespace moved to /ephemeral/artifacts/** (primary) +
// kept /agent/workspace/** (Pattern A double-home). The old git artifact
// namespace /agent/.ax/artifacts/** is GONE. checkPublishablePath now also
// reports which `root` the path lives under so the executor maps it onto the
// right filesystem root.

describe('checkPublishablePath', () => {
  it('accepts paths under /ephemeral/artifacts/ (the primary namespace)', () => {
    expect(checkPublishablePath('/ephemeral/artifacts/report.pdf')).toEqual({
      ok: true,
      root: 'ephemeral',
      relativePath: 'artifacts/report.pdf',
    });
  });

  it('accepts nested paths under /ephemeral/artifacts/', () => {
    expect(checkPublishablePath('/ephemeral/artifacts/sub/dir/img.png')).toEqual({
      ok: true,
      root: 'ephemeral',
      relativePath: 'artifacts/sub/dir/img.png',
    });
  });

  it('accepts paths under /agent/workspace/ (Pattern A double-home)', () => {
    expect(checkPublishablePath('/agent/workspace/reports/Q4.pdf')).toEqual({
      ok: true,
      root: 'agent',
      relativePath: 'workspace/reports/Q4.pdf',
    });
  });

  it('rejects the retired git artifact namespace /agent/.ax/artifacts/', () => {
    const result = checkPublishablePath('/agent/.ax/artifacts/img.png');
    expect(result.ok).toBe(false);
  });

  it('rejects /ephemeral paths outside artifacts/ (e.g. the venv / caches)', () => {
    expect(checkPublishablePath('/ephemeral/.venv/secret').ok).toBe(false);
    expect(checkPublishablePath('/ephemeral/uploads/c/t/f').ok).toBe(false);
  });

  it('rejects paths outside any allowlisted root', () => {
    const result = checkPublishablePath('/agent/.ax/sessions/sess1.jsonl');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not-publishable/);
    }
  });

  it('rejects relative paths (no recognized root prefix)', () => {
    expect(checkPublishablePath('workspace/reports/Q4.pdf').ok).toBe(false);
    expect(checkPublishablePath('artifacts/report.pdf').ok).toBe(false);
  });

  it('rejects paths with traversal segments under either root', () => {
    expect(checkPublishablePath('/agent/workspace/../../etc/passwd').ok).toBe(false);
    expect(checkPublishablePath('/agent/workspace/foo/../bar').ok).toBe(false);
    expect(checkPublishablePath('/ephemeral/artifacts/../../etc/passwd').ok).toBe(false);
  });

  it('rejects absolute paths outside the roots', () => {
    expect(checkPublishablePath('/etc/passwd').ok).toBe(false);
    expect(checkPublishablePath('/agent').ok).toBe(false);
    expect(checkPublishablePath('/ephemeral').ok).toBe(false);
  });

  it('rejects a bare root prefix with no file component', () => {
    expect(checkPublishablePath('/ephemeral/artifacts/').ok).toBe(false);
    expect(checkPublishablePath('/agent/workspace/').ok).toBe(false);
  });

  it('exposes the size cap', () => {
    expect(MAX_ARTIFACT_BYTES).toBe(100 * 1024 * 1024);
  });
});
