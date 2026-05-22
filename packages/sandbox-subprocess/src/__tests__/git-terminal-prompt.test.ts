import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createIpcServerPlugin } from '@ax/ipc-server';
import { createSandboxSubprocessPlugin } from '../plugin.js';
import type { OpenSessionResult } from '../open-session.js';

// ---------------------------------------------------------------------------
// Regression guard: GIT_TERMINAL_PROMPT=0 must be present in the subprocess
// runner child env for fail-fast git auth (B). Without it, git prompts for
// credentials interactively when Basic-auth fails, hanging the runner
// indefinitely. This test locks in the invariant so an accidental removal
// fails CI.
// ---------------------------------------------------------------------------

const ECHO_STUB = fileURLToPath(new URL('./fixtures/echo-stub.mjs', import.meta.url));

async function mkWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'ax-git-tp-'));
}

async function makeHarness() {
  return createTestHarness({
    services: {
      'llm:call': async () => ({
        assistantMessage: { role: 'assistant', content: '' },
        toolCalls: [],
      }),
      'tool:list': async () => ({ tools: [] }),
    },
    plugins: [
      createSessionInmemoryPlugin(),
      createIpcServerPlugin(),
      createSandboxSubprocessPlugin(),
    ],
  });
}

function readFirstStdoutLine(result: OpenSessionResult): Promise<string> {
  const stdout = result.handle.child?.stdout;
  if (stdout === undefined) {
    throw new Error('test harness expected handle.child.stdout');
  }
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        stdout.off('data', onData);
        stdout.off('error', onErr);
        resolve(buf.slice(0, nl));
      }
    };
    const onErr = (err: Error): void => reject(err);
    stdout.on('data', onData);
    stdout.on('error', onErr);
  });
}

describe('sandbox-subprocess git env', () => {
  it('stamps GIT_TERMINAL_PROMPT=0 so a missing credential fails fast (B)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      { sessionId: 'git-tp-1', workspaceRoot: ws, runnerBinary: ECHO_STUB },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;
    expect(parsed.GIT_TERMINAL_PROMPT).toBe('0');

    await result.handle.kill();
    await result.handle.exited;
    await fs.rm(ws, { recursive: true, force: true });
  });
});
