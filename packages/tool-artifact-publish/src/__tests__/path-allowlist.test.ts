import { describe, it, expect } from 'vitest';
import { checkPublishablePath, MAX_ARTIFACT_BYTES } from '../path-allowlist.js';

describe('checkPublishablePath', () => {
  it('accepts paths under /permanent/workspace/', () => {
    expect(checkPublishablePath('/permanent/workspace/reports/Q4.pdf')).toEqual({
      ok: true,
      relativePath: 'workspace/reports/Q4.pdf',
    });
  });

  it('accepts paths under /permanent/.ax/artifacts/', () => {
    expect(checkPublishablePath('/permanent/.ax/artifacts/img.png')).toEqual({
      ok: true,
      relativePath: '.ax/artifacts/img.png',
    });
  });

  it('rejects paths outside the allowlist', () => {
    const result = checkPublishablePath('/permanent/.ax/sessions/sess1.jsonl');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not-publishable/);
    }
  });

  it('rejects relative paths (no /permanent/ prefix)', () => {
    const result = checkPublishablePath('workspace/reports/Q4.pdf');
    expect(result.ok).toBe(false);
  });

  it('rejects paths with traversal segments', () => {
    expect(checkPublishablePath('/permanent/workspace/../../etc/passwd').ok).toBe(false);
    expect(checkPublishablePath('/permanent/workspace/foo/../bar').ok).toBe(false);
  });

  it('rejects absolute paths outside /permanent/', () => {
    expect(checkPublishablePath('/etc/passwd').ok).toBe(false);
    expect(checkPublishablePath('/permanent').ok).toBe(false);
  });

  it('exposes the size cap', () => {
    expect(MAX_ARTIFACT_BYTES).toBe(100 * 1024 * 1024);
  });
});
