import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripClaudeCodeEnv } from './real-sdk-env.js';

describe('stripClaudeCodeEnv', () => {
  it('drops CLAUDECODE, CLAUDE_* and ANTHROPIC_* and keeps the rest', () => {
    const out = stripClaudeCodeEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CONFIG_DIR: '/parent/cfg',
      ANTHROPIC_BASE_URL: 'https://parent.example',
      ANTHROPIC_MODEL: 'parent-model',
      PATH: '/usr/bin',
      HOME: '/home/me',
      TMPDIR: '/tmp/x',
    });
    expect(out).toEqual({ PATH: '/usr/bin', HOME: '/home/me', TMPDIR: '/tmp/x' });
  });

  it('does not mutate its input', () => {
    const input: NodeJS.ProcessEnv = { CLAUDECODE: '1', PATH: '/usr/bin' };
    const out = stripClaudeCodeEnv(input);
    expect(input).toEqual({ CLAUDECODE: '1', PATH: '/usr/bin' });
    expect(out).not.toBe(input);
  });
});

// The three ways a test hands the spawned CLI the parent's env wholesale.
const PARENT_ENV_HANDOFF = [
  /\.\.\.\s*process\.env\b/, // { ...process.env }
  /\benv\s*:\s*process\.env\b/, // env: process.env
  /Object\.assign\([^)]*process\.env\b/, // Object.assign({}, process.env)
];

function handsOverParentEnv(source: string): boolean {
  return PARENT_ENV_HANDOFF.some((re) => re.test(source));
}

describe('real-SDK e2e tests', () => {
  it('the scan catches each way of handing over the parent env, and not the helper', () => {
    for (const bad of [
      'env: { ...process.env, X: "1" }',
      'env: process.env,',
      'const env = Object.assign({}, process.env, { X: "1" });',
    ]) {
      expect(handsOverParentEnv(bad), bad).toBe(true);
    }
    for (const ok of [
      'env: { ...stripClaudeCodeEnv(), X: "1" }',
      'env: stripClaudeCodeEnv(process.env),',
      "const key = process.env['ANTHROPIC_API_KEY'];",
    ]) {
      expect(handsOverParentEnv(ok), ok).toBe(false);
    }
  });

  it('no real-SDK e2e test hands the CLI the parent process env', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(dir).filter((f) => /real-sdk.*\.e2e\.test\.ts$/.test(f));
    // Non-vacuity floor: a rename that stops matching must not pass silently.
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const source = readFileSync(`${dir}${file}`, 'utf8');
      expect(handsOverParentEnv(source), file).toBe(false);
    }
  });
});
