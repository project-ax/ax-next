import { describe, it, expect } from 'vitest';
import { readFile, stat as fsStat, unlink as fsUnlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateToken,
  hashToken,
  verifyToken,
  writeTokenFile,
  printTokenToStdout,
} from '../token.js';

describe('bootstrap token', () => {
  it('generateToken returns ax_bs_<43+ chars base64url>', () => {
    const t = generateToken();
    expect(t).toMatch(/^ax_bs_[A-Za-z0-9_-]{43,}$/);
  });

  it('hashToken / verifyToken roundtrip', async () => {
    const t = generateToken();
    const h = await hashToken(t);
    expect(await verifyToken(t, h)).toBe(true);
    expect(await verifyToken('ax_bs_wrong-token-here', h)).toBe(false);
  });

  it('verifyToken uses constant-time comparison (Invariant I7)', async () => {
    // Soft static-analysis check: catches a regression where someone
    // "simplifies" verifyToken to ===. The hard guarantee is that the
    // exported function calls crypto.timingSafeEqual; the test asserts
    // the source contains it AND does not contain a string-equality
    // operator on the hash variable.
    const src = await readFile(new URL('../token.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/timingSafeEqual/);
    // Forbid any obvious === comparison of hash strings.
    expect(src).not.toMatch(/inputHash\s*===|expectedHash\s*===/);
  });

  it('writeTokenFile creates the file with mode 0600', async () => {
    const tmpPath = join(tmpdir(), `ax-bs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await writeTokenFile(tmpPath, 'ax_bs_test');
      const s = await fsStat(tmpPath);
      expect(s.mode & 0o777).toBe(0o600);
      const content = await readFile(tmpPath, 'utf8');
      expect(content).toBe('ax_bs_test');
    } finally {
      await fsUnlink(tmpPath).catch(() => {});
    }
  });

  it('printTokenToStdout writes the human-readable banner', () => {
    const writes: string[] = [];
    const fakeStdout = (line: string) => writes.push(line);
    printTokenToStdout('ax_bs_X', 'http://localhost:8080', fakeStdout);
    const all = writes.join('\n');
    expect(all).toContain('ax_bs_X');
    expect(all).toContain('http://localhost:8080/setup?token=ax_bs_X');
    expect(all).toContain('First-run bootstrap');
  });
});
