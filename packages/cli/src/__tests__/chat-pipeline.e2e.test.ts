import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

import {
  createTestHostToolPlugin,
  createTestProxyPlugin,
  stubRunnerPath,
  type StubRunnerScript,
} from '@ax/test-harness';
import { main } from '../main.js';
import type { Plugin, ToolCall } from '@ax/core';

// ---------------------------------------------------------------------------
// Phase 6.6 Task 7 — chat-pipeline e2e (I_R2).
//
// Library-mode acceptance test that drives the full chat pipeline (sandbox
// spawn → IPC routing → host MCP service hook → pre/post tool subscribers)
// using the stub runner from @ax/test-harness in place of the real
// @ax/agent-claude-sdk-runner. No real Anthropic credentials required.
//
// Replaces the parked claude-sdk-runner.e2e.test.ts placeholder. The stub
// runner is platform-neutral (pure Node IPC client), so unlike the parked
// test there is NO darwin gate.
// ---------------------------------------------------------------------------

interface PreCallRecord {
  kind: 'pre';
  name: string;
  toolCallId: string;
}

interface PostCallRecord {
  kind: 'post';
  name: string;
  toolCallId: string;
}

type Record_ = PreCallRecord | PostCallRecord;

describe('@ax/cli chat pipeline e2e (stub runner)', () => {
  let tmp: string;
  let originalCredKey: string | undefined;

  beforeEach(async () => {
    tmp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ax-chat-pipeline-')),
    );
    originalCredKey = process.env.AX_CREDENTIALS_KEY;
    // @ax/credentials init() requires this even when skipCredentialProxy is
    // true, because the credentials facade is loaded unconditionally.
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
  });

  afterEach(async () => {
    if (originalCredKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = originalCredKey;
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it(
    'fires tool:pre-call and tool:post-call in order for built-in and host-mediated tools',
    { timeout: 20_000 },
    async () => {
      const script: StubRunnerScript = {
        entries: [
          {
            kind: 'tool-call',
            name: 'Bash',
            input: { command: 'echo hi' },
            executesIn: 'sandbox',
            expectPostCall: true,
          },
          {
            kind: 'tool-call',
            name: 'test-host-echo',
            input: { text: 'world' },
            executesIn: 'host',
            expectPostCall: true,
          },
          { kind: 'assistant-text', content: 'ok' },
          { kind: 'finish', reason: 'end_turn' },
        ],
      };

      const records: Record_[] = [];
      const recorderPlugin: Plugin = {
        manifest: {
          name: '@ax/test-chat-pipeline-recorder',
          version: '0.0.0',
          registers: [],
          calls: [],
          subscribes: ['tool:pre-call', 'tool:post-call'],
        },
        init({ bus }) {
          // tool:pre-call fires with the bare ToolCall envelope as the bus
          // payload (see ipc-core/handlers/tool-pre-call.ts: it strips the
          // wire `{ call }` wrapper before bus.fire). tool:post-call, by
          // contrast, fires with `{ toolCall, output }` (see
          // ipc-core/handlers/event-tool-post-call.ts) — the IPC wire field
          // `call` gets renamed to `toolCall` to match chat-loop's existing
          // payload shape. Different shapes per hook is intentional.
          bus.subscribe<ToolCall>(
            'tool:pre-call',
            '@ax/test-chat-pipeline-recorder',
            async (_ctx, call) => {
              records.push({
                kind: 'pre',
                name: call.name,
                toolCallId: call.id,
              });
              // Pass-through verdict — explicit undefined keeps us out of the
              // verdict path. Returning false/null would reject the tool call.
              return undefined;
            },
          );
          bus.subscribe<{ toolCall: ToolCall; output: unknown }>(
            'tool:post-call',
            '@ax/test-chat-pipeline-recorder',
            async (_ctx, payload) => {
              records.push({
                kind: 'post',
                name: payload.toolCall.name,
                toolCallId: payload.toolCall.id,
              });
              return undefined;
            },
          );
        },
      };

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const rc = await main({
        message: 'go',
        configOverride: { sandbox: 'subprocess', storage: 'sqlite' },
        workspaceRoot: tmp,
        sqlitePath: path.join(tmp, 'chat-pipeline.sqlite'),
        stdout: (line) => stdoutLines.push(line),
        stderr: (line) => stderrLines.push(line),
        runnerBinaryOverride: stubRunnerPath,
        skipCredentialProxy: true,
        extraPlugins: [
          createTestProxyPlugin({ script }),
          createTestHostToolPlugin(),
          recorderPlugin,
        ],
      });

      // Surface stderr context if the chat path failed — diagnostics that
      // would be otherwise hidden by an unhelpful "rc !== 0" assertion.
      if (rc !== 0) {
        throw new Error(
          `main exited ${rc}; stderr:\n${stderrLines.join('\n')}`,
        );
      }
      expect(rc).toBe(0);
      expect(stdoutLines.join('\n')).toContain('ok');

      // Per stub-runner.ts, each script entry runs to completion (pre →
      // optional host execute → post) before the next entry starts. So the
      // pre/post observer sees pairs interleaved per tool, not a "all pres
      // then all posts" sequence:
      //   pre[Bash], post[Bash], pre[test-host-echo], post[test-host-echo]
      const order = records.map((r) => `${r.kind}[${r.name}]`);
      expect(order).toEqual([
        'pre[Bash]',
        'post[Bash]',
        'pre[test-host-echo]',
        'post[test-host-echo]',
      ]);

      // ID-pairing check: pre/post for the same tool share an ID, and the
      // IDs across tools are distinct. Without this, a regression where
      // pre/post fire for mismatched toolCallIds would still pass the
      // (kind, name) order assertion above.
      expect(records[0]!.toolCallId).toBe(records[1]!.toolCallId); // Bash pre = Bash post
      expect(records[2]!.toolCallId).toBe(records[3]!.toolCallId); // test-host-echo pre = test-host-echo post
      expect(records[0]!.toolCallId).not.toBe(records[2]!.toolCallId); // different tools have different IDs
    },
  );
});
