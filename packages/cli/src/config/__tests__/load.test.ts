import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAxConfig } from '../load.js';

describe('loadAxConfig', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ax-load-config-'));
  });

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('returns defaults when no config file is present', async () => {
    const cfg = await loadAxConfig({ cwd: workDir });
    expect(cfg).toEqual({
      llm: 'mock',
      sandbox: 'subprocess',
      tools: ['bash', 'file-io'],
      storage: 'sqlite',
      runner: 'native',
    });
  });

  it('merges a valid ax.config.mjs over defaults', async () => {
    writeFileSync(
      join(workDir, 'ax.config.mjs'),
      "export default { llm: 'mock', tools: ['bash'] };\n",
    );
    const cfg = await loadAxConfig({ cwd: workDir });
    expect(cfg.llm).toBe('mock');
    expect(cfg.tools).toEqual(['bash']);
    // Defaults still applied for unspecified fields.
    expect(cfg.sandbox).toBe('subprocess');
    expect(cfg.storage).toBe('sqlite');
  });

  it('throws with "failed validation" when config is invalid', async () => {
    writeFileSync(
      join(workDir, 'ax.config.mjs'),
      "export default { llm: 'openai' };\n",
    );
    await expect(loadAxConfig({ cwd: workDir })).rejects.toThrow(
      /failed validation/,
    );
  });

  it('throws when config file has no default export', async () => {
    writeFileSync(
      join(workDir, 'ax.config.mjs'),
      "export const notDefault = { llm: 'mock' };\n",
    );
    await expect(loadAxConfig({ cwd: workDir })).rejects.toThrow(
      /no default export/,
    );
  });
});
