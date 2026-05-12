import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
// __tests__ is two levels below packages/memory-strata/
const PKG_ROOT = join(THIS_DIR, '..', '..', '..');
const SRC_DIR = join(PKG_ROOT, 'src');
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const PKG_JSON = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    else if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

describe('Phase 3A ship list', () => {
  it('I25: no bench module names appear in src/', () => {
    const forbidden = ['createConfigA', 'createConfigB', 'createConfigC', 'BenchCache', 'CostMeter', 'judgeAnswer', 'runAgent'];
    const srcFiles = walk(SRC_DIR);
    for (const f of srcFiles) {
      const content = readFileSync(f, 'utf8');
      for (const term of forbidden) {
        expect(content, `${f} should not reference ${term}`).not.toContain(term);
      }
    }
  });

  it('I26: bench-only deps are in devDependencies only', () => {
    const benchOnly = ['zeroentropy', 'openai', '@huggingface/hub', 'sqlite-vec'];
    for (const dep of benchOnly) {
      expect(PKG_JSON.dependencies?.[dep], `${dep} must not be in dependencies`).toBeUndefined();
      expect(PKG_JSON.devDependencies?.[dep], `${dep} must be in devDependencies`).toBeDefined();
    }
  });

  it('I29: API keys are not echoed in any bench file', () => {
    // Exclude __tests__ dir — test files may contain string literals for this very check
    const benchFiles = walk(join(PKG_ROOT, 'test/bench')).filter(
      (f) => !f.includes('__tests__'),
    );
    const forbidden = [
      'console.log(process.env.ANTHROPIC',
      'console.log(process.env.ZEROENTROPY',
      'console.log(process.env.OPENROUTER',
    ];
    for (const f of benchFiles) {
      const content = readFileSync(f, 'utf8');
      for (const term of forbidden) {
        expect(content, `${f} should not log API keys`).not.toContain(term);
      }
    }
  });
});
