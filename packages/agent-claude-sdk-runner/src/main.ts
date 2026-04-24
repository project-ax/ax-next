#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  query,
  type SDKAssistantMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  createDiffAccumulator,
  createInboxLoop,
  createIpcClient,
  toWireChanges,
} from '@ax/agent-runner-core';
import type {
  ChatMessage,
  ToolListResponse,
  WorkspaceCommitNotifyResponse,
} from '@ax/ipc-protocol';
import { createCanUseTool } from './can-use-tool.js';
import { readRunnerEnv } from './env.js';
import { createHostMcpServer } from './host-mcp-server.js';
import { createPostToolUseHook } from './post-tool-use.js';
import { createPreToolUseHook } from './pre-tool-use.js';
import { DISABLED_BUILTINS, MCP_HOST_SERVER_NAME } from './tool-names.js';

// ---------------------------------------------------------------------------
// Runner entry binary (claude-sdk variant).
//
// Spawned as a child process by @ax/sandbox-subprocess inside an isolated
// sandbox. Communicates back to the host exclusively over the unix socket
// whose path is in AX_IPC_SOCKET, authenticated with AX_AUTH_TOKEN.
//
// The runner holds NO LLM credentials (invariant I5). The vendored
// @anthropic-ai/claude-agent-sdk is redirected at our sandbox-internal LLM
// proxy via ANTHROPIC_BASE_URL; the proxy then calls host `llm.call` with
// the host-held key. If the sandbox is compromised, ANTHROPIC_API_KEY never
// entered this process.
//
// Shape: one persistent `query()` driven by an async generator that pulls
// user messages from the inbox long-poll. That keeps a single SDK session
// alive for the life of the runner instead of spawning a fresh one per
// chat turn — the SDK's internal conversation history carries across
// turns automatically.
//
// Exit codes (mirror @ax/agent-native-runner so the spawning host can
// branch identically regardless of runner flavor):
//   0 — chat completed normally (inbox returned cancel; SDK drained).
//   1 — terminated abnormally (SDK threw, IPC errored after retries, etc.).
//   2 — fatal during bootstrap (missing env, initial tool.list failure).
// ---------------------------------------------------------------------------

export async function main(): Promise<number> {
  let env;
  try {
    env = readRunnerEnv();
  } catch (err) {
    process.stderr.write(
      `runner: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const client = createIpcClient({
    socketPath: env.ipcSocket,
    token: env.authToken,
  });

  let tools;
  try {
    tools = ((await client.call('tool.list', {})) as ToolListResponse).tools;
  } catch (err) {
    process.stderr.write(
      `runner: tool.list failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await client.close();
    return 2;
  }

  const hostMcpServer = createHostMcpServer({ client, tools });
  const inbox = createInboxLoop({ client });
  // Per-turn diff accumulator (Task 7c). PostToolUse populates; the
  // `result` SDK message drains and ships a single `workspace.commit-
  // notify`. Workspace commits are turn-end, NOT per-tool-call.
  const diffs = createDiffAccumulator();
  // Tracks the last accepted workspace version so the host's optimistic-
  // concurrency check sees a coherent lineage across turns.
  let parentVersion: string | null = null;
  // Host-side bookkeeping for the final event.chat-end outcome. The SDK
  // maintains its OWN transcript internally; this array is only the shape
  // the host cares about (user/assistant text round-tripped through
  // ChatMessage).
  const history: ChatMessage[] = [];

  // Inbox → SDK user-message generator. Closing via `return` on cancel
  // tells the SDK no more user messages are coming, which lets the outer
  // `for await (msg of queryIter)` drain naturally and exit.
  async function* userMessages(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const entry = await inbox.next();
      if (entry.type === 'cancel') return;
      if (entry.payload === undefined) continue;
      history.push({ role: 'user', content: entry.payload.content });
      yield {
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: entry.payload.content },
      };
    }
  }

  let exitCode = 0;
  let terminatedReason: string | undefined;
  let terminatedError:
    | { name: string; message: string; stack?: string }
    | undefined;

  try {
    const queryIter = query({
      prompt: userMessages(),
      options: {
        // Route the SDK's Anthropic calls through our in-sandbox proxy so
        // the real API key stays host-side. The auth token here is the
        // sandbox's IPC bearer — the proxy validates it before forwarding.
        env: {
          ANTHROPIC_BASE_URL: env.llmProxyUrl,
          ANTHROPIC_API_KEY: env.authToken,
        },
        cwd: env.workspaceRoot,
        disallowedTools: [...DISABLED_BUILTINS],
        // canUseTool stays as a belt-and-suspenders allow-path. The real
        // pre-call hook-bus forwarding happens in the PreToolUse hook below,
        // which ALWAYS fires (canUseTool only fires when the CLI decides a
        // tool needs a permission prompt — built-ins like Bash with benign
        // input don't reach it). See pre-tool-use.ts for the rationale.
        canUseTool: createCanUseTool({ client }),
        hooks: {
          PreToolUse: [{ hooks: [createPreToolUseHook({ client })] }],
          PostToolUse: [
            {
              hooks: [
                createPostToolUseHook({
                  client,
                  diffs,
                  workspaceRoot: env.workspaceRoot,
                }),
              ],
            },
          ],
        },
        mcpServers: { [MCP_HOST_SERVER_NAME]: hostMcpServer },
        // Empty settingSources = SDK isolation mode: the runner does NOT
        // read ~/.claude, project settings, or CLAUDE.md. Config for this
        // sandbox arrives entirely through host-mediated IPC.
        settingSources: [],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
      },
    });

    for await (const msg of queryIter) {
      if (msg.type === 'assistant') {
        const assistant: SDKAssistantMessage = msg;
        // Only plain text blocks round-trip into host history. Tool-use
        // blocks stay inside the SDK's session — the host observes tool
        // activity via event.tool-post-call, not via the transcript.
        const text = assistant.message.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n');
        if (text.length > 0) {
          history.push({ role: 'assistant', content: text });
        }
      } else if (msg.type === 'result') {
        // Turn boundary. Drain the per-turn diff accumulator and ship a
        // single `workspace.commit-notify` when there are changes. We
        // skip empty turns deliberately: a host with no workspace plugin
        // registered would log an internal error on each empty notify,
        // and `event.turn-end` already carries the heartbeat signal.
        // Failures here MUST NOT terminate the chat — the next turn
        // retries against whatever parent version we last knew.
        if (!diffs.isEmpty()) {
          const drained = diffs.drain();
          try {
            const resp = (await client.call('workspace.commit-notify', {
              parentVersion,
              commitRef: randomUUID(),
              message: 'turn',
              changes: toWireChanges(drained),
            })) as WorkspaceCommitNotifyResponse;
            if (resp.accepted) {
              parentVersion = resp.version as unknown as string;
            }
            // accepted:false is logged on the host; the runner just keeps
            // its previous parent and tries again next turn.
          } catch {
            /* swallow — workspace commits are recoverable */
          }
        }

        // One turn of assistant output finished. The SDK now awaits the
        // next yield from userMessages() — i.e. the next inbox pull.
        await client
          .event('event.turn-end', { reason: 'user-message-wait' })
          .catch(() => {
            /* host may be tearing down; non-fatal */
          });
      }
      // system / user / partial / progress / etc. are SDK bookkeeping —
      // the host doesn't need to see them.
    }
  } catch (err) {
    exitCode = 1;
    if (err instanceof Error) {
      terminatedReason = `${err.name}: ${err.message}`;
      terminatedError = {
        name: err.name,
        message: err.message,
        ...(err.stack !== undefined ? { stack: err.stack } : {}),
      };
    } else {
      terminatedReason = String(err);
      terminatedError = { name: 'NonError', message: String(err) };
    }
  }

  // Single event.chat-end at the end of the runner's life, awaited so the
  // event reaches the wire before the process exits. If the host is
  // already gone, swallow — there's nothing left to signal to. The
  // `error` shape here is a plain object so the event payload survives
  // JSON.stringify (an `Error` instance would serialize to `{}`, stripping
  // the diagnostic).
  const outcome =
    exitCode === 0
      ? { kind: 'complete' as const, messages: history }
      : {
          kind: 'terminated' as const,
          reason: terminatedReason ?? 'unknown',
          ...(terminatedError !== undefined ? { error: terminatedError } : {}),
        };
  await client.event('event.chat-end', { outcome }).catch(() => {
    /* swallow */
  });
  await client.close().catch(() => {
    /* close is best-effort; a clean chat shouldn't exit non-zero on teardown */
  });
  return exitCode;
}

// ESM main-module guard. `require.main === module` doesn't work in ESM.
// Compare URLs to detect "was this file invoked directly".
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(
        `runner: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    });
}
