import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import BetterSqlite3 from 'better-sqlite3';

import { main } from '../main.js';

/**
 * Library-mode e2e: real `@ax/sandbox-subprocess` + `@ax/tool-bash` against
 * a stubbed Anthropic client. No `pnpm build` shell-out (invariant I9), no
 * CLI subprocess — we invoke `main()` as a library, hand it a client factory,
 * and assert on stdout and the persisted SQLite audit-log row.
 *
 * Why the `anthropicClientFactory` seam instead of `vi.mock('@anthropic-ai/sdk')`:
 * the SDK is published as CommonJS and gets resolved by Node directly when
 * the llm-anthropic plugin's ESM dist imports it — vitest's module-specifier
 * mock doesn't reach that nested resolution. The `clientFactory` hatch is
 * already the plugin's sanctioned test seam; we thread it through MainOptions
 * (not the JSON config schema, since functions aren't JSON-serializable).
 */

async function mkTmp(): Promise<string> {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-e2e-llm-')));
}

describe('real-llm e2e (library mode, stubbed client)', () => {
  let tmp: string;
  let originalKey: string | undefined;

  beforeEach(async () => {
    tmp = await mkTmp();
    originalKey = process.env.ANTHROPIC_API_KEY;
    // The llm-anthropic plugin's init() requires this env var to be set,
    // even when we inject a stub client (the key is passed to the factory).
    process.env.ANTHROPIC_API_KEY = 'sk-fake-for-test';
  });

  afterEach(async () => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('completes a two-turn chat: LLM emits bash tool_use, bash runs, LLM emits text', async () => {
    // Queue of canned SDK responses, drained per call.
    const responses: unknown[] = [
      // Turn 1: model asks to run `bash -c "echo hello"`.
      {
        content: [
          { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'echo hello' } },
        ],
        stop_reason: 'tool_use',
      },
      // Turn 2: model sees the tool result and emits a final text message.
      {
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      },
    ];
    const createSpy = vi.fn(async (_req: Record<string, unknown>) => {
      const next = responses.shift();
      if (next === undefined) throw new Error('no more queued mock responses');
      return next;
    });
    const clientFactory = (_apiKey: string) => ({ messages: { create: createSpy } });

    const lines: string[] = [];
    const errLines: string[] = [];
    const sqlitePath = path.join(tmp, 'e2e.sqlite');

    const code = await main({
      message: 'list files',
      configOverride: {
        llm: 'anthropic',
        // tool-file-io isn't needed for this test and would just widen the
        // surface; keep the test focused on the bash path.
        tools: ['bash'],
        sandbox: 'subprocess',
        storage: 'sqlite',
      },
      workspaceRoot: tmp,
      sqlitePath,
      stdout: (line) => lines.push(line),
      stderr: (line) => errLines.push(line),
      anthropicClientFactory: clientFactory,
    });

    expect(errLines).toEqual([]);
    expect(code).toBe(0);
    // Stub was hit once per LLM turn (tool_use, then end_turn).
    expect(createSpy).toHaveBeenCalledTimes(2);
    // main() writes the final assistant message to stdout.
    expect(lines.join('\n').trim()).toContain('done');

    // SQLite should hold the audit-log row with the full outcome, including
    // the bash tool-result line that carries 'hello'.
    expect(await fs.stat(sqlitePath)).toBeTruthy();
    const db = new BetterSqlite3(sqlitePath, { readonly: true });
    try {
      const rows = db
        .prepare('SELECT key, value FROM kv')
        .all() as Array<{ key: string; value: Buffer }>;
      const chatRow = rows.find((r) => r.key.startsWith('chat:'));
      expect(chatRow).toBeDefined();
      const decoded = JSON.parse(chatRow!.value.toString('utf8'));
      expect(decoded.outcome.kind).toBe('complete');
      const messages = decoded.outcome.messages as Array<{ role: string; content: string }>;
      // user + assistant(tool_use) + tool-result + assistant(text)
      expect(messages.length).toBeGreaterThanOrEqual(4);
      // The tool result message carries the bash stdout. chat-loop formats it
      // as `[tool bash] ${JSON.stringify(output)}` where output includes
      // stdout: "hello\n", so 'hello' is substring-present.
      const toolResult = messages.find(
        (m) => m.role === 'user' && m.content.startsWith('[tool bash]') && m.content.includes('hello'),
      );
      expect(toolResult).toBeTruthy();
      // And the final assistant message carries 'done'.
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
      expect(lastAssistant?.content).toContain('done');
    } finally {
      db.close();
    }
  });

  it('bash runs in a grandchild process, not the host — topology-shift contract', async () => {
    // Week 6.5a's acceptance contract: the agent loop (and every tool it
    // runs) lives in a subprocess sandbox, not in the host process. If this
    // test regresses, we've lost the subprocess isolation that was the
    // entire point of this slice.
    //
    // We ask bash to print its own PID and PPID. The host process's PID is
    // `process.pid`. Bash's PPID is the runner (its parent), which is in
    // turn the host's child. So the bash process's PPID must NOT be the
    // host PID — if it is, the bash was spawned directly by the host (the
    // Week 4-6 topology) and the topology shift didn't take.
    const responses: unknown[] = [
      {
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'bash',
            // Emits two lines: self PID, parent PID. The runner is the
            // parent, not the host.
            input: { command: 'echo "self=$$"; echo "parent=$(ps -o ppid= -p $$)"' },
          },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'inspected' }],
        stop_reason: 'end_turn',
      },
    ];
    const createSpy = vi.fn(async (_req: Record<string, unknown>) => {
      const next = responses.shift();
      if (next === undefined) throw new Error('no more queued mock responses');
      return next;
    });

    const lines: string[] = [];
    const errLines: string[] = [];
    const sqlitePath = path.join(tmp, 'topology.sqlite');

    const hostPid = process.pid;

    const code = await main({
      message: 'inspect',
      configOverride: {
        llm: 'anthropic',
        tools: ['bash'],
        sandbox: 'subprocess',
        storage: 'sqlite',
      },
      workspaceRoot: tmp,
      sqlitePath,
      stdout: (line) => lines.push(line),
      stderr: (line) => errLines.push(line),
      anthropicClientFactory: (_key) => ({ messages: { create: createSpy } }),
    });

    expect(errLines).toEqual([]);
    expect(code).toBe(0);

    // Pull the recorded tool-result from the audit-log row so we can parse
    // the bash output, then extract the parent PID bash observed.
    const db = new BetterSqlite3(sqlitePath, { readonly: true });
    let parentPid: number | undefined;
    try {
      const rows = db
        .prepare('SELECT key, value FROM kv')
        .all() as Array<{ key: string; value: Buffer }>;
      const chatRow = rows.find((r) => r.key.startsWith('chat:'));
      const decoded = JSON.parse(chatRow!.value.toString('utf8'));
      const messages = decoded.outcome.messages as Array<{ role: string; content: string }>;
      const toolResult = messages.find(
        (m) => m.role === 'user' && m.content.startsWith('[tool bash]'),
      );
      expect(toolResult).toBeTruthy();
      // Pull `parent=<pid>` from the JSON-stringified stdout captured in the
      // tool-result message. The runner writes stdout verbatim and the
      // content body is `[tool bash] <JSON.stringify(output)>`.
      const match = toolResult!.content.match(/parent=\s*(\d+)/);
      expect(match).toBeTruthy();
      parentPid = Number(match![1]);
    } finally {
      db.close();
    }

    // Bash's parent is the runner process. The runner is spawned by the
    // host as a child — so runner.pid !== host.pid, and therefore
    // parentPid !== host.pid. A regression that reinstates in-host tool
    // execution would make parentPid === host.pid.
    expect(parentPid).toBeDefined();
    expect(parentPid).not.toBe(hostPid);
  }, 60_000);
});
