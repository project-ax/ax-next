#!/usr/bin/env node
/**
 * Stub agent runner.
 *
 * Built to `dist/stub-runner.js` and spawned by chat-orchestrator e2e tests
 * via `child_process.spawn(process.execPath, [stubRunnerPath])` in place of
 * `@ax/agent-claude-sdk-runner`. It speaks the IPC protocol via
 * `createIpcClient` from `@ax/agent-runner-core` and replays a canned
 * `StubRunnerScript` decoded from the `AX_TEST_STUB_SCRIPT` env var.
 *
 * Why this exists: tests need a runner that exercises the real IPC wire path
 * (tool.list / tool.pre-call / tool.execute-host / event.tool-post-call /
 * event.chat-end) without depending on a live LLM or the SDK. Each test
 * encodes a deterministic script of tool calls + assistant text + finish,
 * spawns this stub against a real orchestrator, and asserts on the IPC
 * actions that fire.
 */
import { randomBytes } from 'node:crypto';

import { createIpcClient } from '@ax/agent-runner-core';
import type {
  AgentMessage,
  ToolCall,
  ToolPreCallResponse,
  ToolExecuteHostResponse,
} from '@ax/ipc-protocol';

import { decodeScript, type StubRunnerScript } from './script-schema.js';

interface StubEnv {
  runnerEndpoint: string;
  sessionId: string;
  authToken: string;
  workspaceRoot: string;
  encodedScript: string;
}

function readEnv(env: NodeJS.ProcessEnv): StubEnv {
  const need = (k: string): string => {
    const v = env[k];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`stub-runner: missing required env: ${k}`);
    }
    return v;
  };
  return {
    runnerEndpoint: need('AX_RUNNER_ENDPOINT'),
    sessionId: need('AX_SESSION_ID'),
    authToken: need('AX_AUTH_TOKEN'),
    workspaceRoot: need('AX_WORKSPACE_ROOT'),
    encodedScript: need('AX_TEST_STUB_SCRIPT'),
  };
}

function mintCallId(): string {
  return `c-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

async function run(): Promise<number> {
  let stubEnv: StubEnv;
  try {
    stubEnv = readEnv(process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  let script: StubRunnerScript;
  try {
    script = decodeScript(stubEnv.encodedScript);
  } catch (err) {
    process.stderr.write(
      `stub-runner: failed to decode AX_TEST_STUB_SCRIPT: ${(err as Error).message}\n`,
    );
    return 2;
  }

  // Parity with the real runner: sessionId + workspaceRoot are passed by the
  // sandbox provider and read here so a missing one fails fast at boot. The
  // stub itself doesn't need them at runtime.
  void stubEnv.sessionId;
  void stubEnv.workspaceRoot;

  const client = createIpcClient({
    runnerEndpoint: stubEnv.runnerEndpoint,
    token: stubEnv.authToken,
  });

  await client.call('tool.list', {});

  const messages: AgentMessage[] = [];
  let finished = false;

  for (const entry of script.entries) {
    if (entry.kind === 'tool-call') {
      const callId = mintCallId();
      const call: ToolCall = {
        id: callId,
        name: entry.name,
        input: entry.input,
      };

      const pre = (await client.call('tool.pre-call', { call })) as ToolPreCallResponse;
      if (pre.verdict === 'reject') continue;

      const finalCall = pre.modifiedCall ?? call;

      let output: unknown;
      if (entry.executesIn === 'host') {
        const exec = (await client.call('tool.execute-host', {
          call: finalCall,
        })) as ToolExecuteHostResponse;
        output = exec.output;
      } else {
        output = { ok: true, simulated: true };
      }

      if (entry.expectPostCall) {
        await client.event('event.tool-post-call', { call: finalCall, output });
      }
      continue;
    }

    if (entry.kind === 'assistant-text') {
      messages.push({ role: 'assistant', content: entry.content });
      continue;
    }

    if (entry.kind === 'finish') {
      await client.event('event.chat-end', {
        outcome: { kind: 'complete', messages },
      });
      await client.close();
      finished = true;
      break;
    }
  }

  if (!finished) {
    process.stderr.write('stub-runner: script ended without a finish entry\n');
    await client.close();
    return 1;
  }

  return 0;
}

run().then(
  (code) => {
    process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(
      `stub-runner fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  },
);
