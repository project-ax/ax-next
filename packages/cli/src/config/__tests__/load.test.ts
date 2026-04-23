import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAxConfig } from '../load.js';

describe('loadAxConfig', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()!;
      rmSync(d, { recursive: true, force: true });
    }
  });

  function mkTmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'ax-cfg-'));
    dirs.push(d);
    return d;
  }

  it('returns defaults when no config file exists', async () => {
    const cwd = mkTmp();
    const cfg = await loadAxConfig(cwd);
    expect(cfg).toEqual({
      llm: 'mock',
      sandbox: 'subprocess',
      tools: ['bash', 'file-io'],
      storage: 'sqlite',
    });
  });

  it('merges a valid ax.config.mjs over defaults', async () => {
    const cwd = mkTmp();
    writeFileSync(
      join(cwd, 'ax.config.mjs'),
      `export default { llm: 'anthropic', anthropic: { model: 'claude-sonnet-4-5', maxTokens: 1024 } };\n`,
    );
    const cfg = await loadAxConfig(cwd);
    expect(cfg.llm).toBe('anthropic');
    expect(cfg.anthropic).toEqual({
      model: 'claude-sonnet-4-5',
      maxTokens: 1024,
    });
    expect(cfg.tools).toEqual(['bash', 'file-io']);
  });

  it('throws with Zod error text on invalid config', async () => {
    const cwd = mkTmp();
    writeFileSync(
      join(cwd, 'ax.config.mjs'),
      `export default { llm: 'openai' };\n`,
    );
    await expect(loadAxConfig(cwd)).rejects.toThrow(/invalid ax\.config\.mjs/);
  });
});
