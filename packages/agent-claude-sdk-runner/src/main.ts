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
  ContentBlock,
  SessionGetConfigResponse,
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
// Spawned as a child process by a `sandbox:open-session` impl inside an
// isolated sandbox. Communicates back to the host over the URI in
// AX_RUNNER_ENDPOINT (unix:// today, http:// once Task 14 lands), authed
// with AX_AUTH_TOKEN.
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
    runnerEndpoint: env.runnerEndpoint,
    token: env.authToken,
  });

  // Week 9.5: fetch the frozen agent config the orchestrator wrote when it
  // resolved this session's agent. We do this BEFORE tool.list so we can
  // filter the catalog defensively against `allowedTools` even if the
  // host's tool-dispatcher (Task 7) hasn't filtered yet.
  //
  // The bearer token in env.authToken is the SAME token the host used to
  // mint this session — the IPC server resolves it to ctx.sessionId, and
  // the session backend reads its own row keyed by that. There's no
  // sessionId on the wire; the runner cannot ask for someone else's
  // config.
  let agentConfig: SessionGetConfigResponse['agentConfig'];
  try {
    const cfg = (await client.call(
      'session.get-config',
      {},
    )) as SessionGetConfigResponse;
    agentConfig = cfg.agentConfig;
  } catch (err) {
    process.stderr.write(
      `runner: session.get-config failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await client.close();
    return 2;
  }

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

  // Defensive client-side filter against agentConfig.allowedTools when it
  // is non-empty. An empty allow-list means "no per-agent restriction"
  // (orchestrator default); a non-empty list overrides what the host
  // returned. This is belt-and-suspenders against the dispatcher filter
  // (Task 7) — if either the host or runner mis-orders a refactor, the
  // tool catalog the SDK sees is still bounded.
  if (agentConfig.allowedTools.length > 0) {
    const allow = new Set(agentConfig.allowedTools);
    tools = tools.filter((t) => allow.has(t.name));
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

  // Per-turn content-block accumulators. Drained at the SDK `result`
  // boundary into event.turn-end so @ax/conversations can persist the
  // turn (Task 3 of Week 10–12). We track assistant and tool turns
  // separately because they emit as distinct chat:turn-end events:
  //   - assistant: text + thinking + tool_use blocks observed in
  //     `assistant` SDK messages within the current turn.
  //   - tool: tool_result blocks observed in `user` SDK messages whose
  //     content is the SDK echoing the tool-result back into the
  //     transcript. Replay (Task 15) needs these to reconstruct the
  //     conversation; the user-side text the human typed already
  //     reaches the conversation table via POST /api/chat/messages
  //     (Task 9), so we deliberately skip plain-text user blocks here.
  let turnContentBlocks: ContentBlock[] = [];
  let turnToolResultBlocks: ContentBlock[] = [];

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
        // Week 9.5: use the frozen agentConfig.systemPrompt the host wrote
        // at session-creation time. An empty string falls back to the SDK
        // preset (the dev-agents-stub seeds a default; production agents
        // require non-empty by validation). systemPrompt is USER-AUTHORED
        // and intended for the LLM — not interpolated into shell, paths,
        // or HTML.
        systemPrompt:
          agentConfig.systemPrompt.length > 0
            ? agentConfig.systemPrompt
            : { type: 'preset', preset: 'claude_code' },
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
        // Accumulate full ContentBlock[] for the per-turn transcript that
        // ships to @ax/conversations via event.turn-end. Block shapes that
        // don't survive replay (raw `text`, `thinking`, `tool_use`) are
        // mapped explicitly; anything else is dropped defensively so a
        // future SDK addition doesn't bypass our schema.
        for (const block of assistant.message.content) {
          if (block.type === 'text') {
            turnContentBlocks.push({ type: 'text', text: block.text });
          } else if (block.type === 'thinking') {
            turnContentBlocks.push({
              type: 'thinking',
              thinking: block.thinking,
              ...(typeof block.signature === 'string'
                ? { signature: block.signature }
                : {}),
            });
          } else if (block.type === 'tool_use') {
            turnContentBlocks.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: (block.input ?? {}) as Record<string, unknown>,
            });
          }
        }
      } else if (msg.type === 'user') {
        // The SDK echoes tool_result blocks back as `user` messages once
        // a tool finishes (the model issued a tool_use; the runner ran
        // the tool; the SDK threads the result into the transcript as a
        // user turn so the next assistant turn can see it). Replay
        // depends on these landing in the conversation row. Plain-text
        // user content is NOT collected: the human's typed message
        // arrives via POST /api/chat/messages (Task 9), and tool_result
        // blocks are the only thing the runner is the authoritative
        // source for here.
        const userMsg = msg as { message?: { content?: unknown } };
        const content = userMsg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<{ type?: string }>) {
            if (block.type === 'tool_result') {
              const tr = block as {
                type: 'tool_result';
                tool_use_id?: string;
                content?: unknown;
                is_error?: boolean;
              };
              if (typeof tr.tool_use_id === 'string') {
                // ToolResultBlock.content is string | (TextBlock |
                // ImageBlock)[]. We narrow array content to the
                // text/image subset; anything else collapses to empty
                // string so the row passes ContentBlockSchema validation.
                let normalizedContent: string | Array<{
                  type: 'text';
                  text: string;
                }> = '';
                if (typeof tr.content === 'string') {
                  normalizedContent = tr.content;
                } else if (Array.isArray(tr.content)) {
                  const textOnly: Array<{ type: 'text'; text: string }> = [];
                  for (const item of tr.content as Array<{
                    type?: string;
                    text?: unknown;
                  }>) {
                    if (item.type === 'text' && typeof item.text === 'string') {
                      textOnly.push({ type: 'text', text: item.text });
                    }
                  }
                  normalizedContent = textOnly;
                }
                const normalized: ContentBlock = {
                  type: 'tool_result',
                  tool_use_id: tr.tool_use_id,
                  content: normalizedContent,
                  ...(typeof tr.is_error === 'boolean'
                    ? { is_error: tr.is_error }
                    : {}),
                };
                turnToolResultBlocks.push(normalized);
              }
            }
          }
        }
      } else if (msg.type === 'result') {
        // Turn boundary. Snapshot the per-turn diff accumulator and ship
        // a single `workspace.commit-notify` when there are changes. We
        // skip empty turns deliberately: a host with no workspace plugin
        // registered would log an internal error on each empty notify,
        // and `event.turn-end` already carries the heartbeat signal.
        // Failures here MUST NOT terminate the chat.
        //
        // Snapshot-then-drain-on-receipt: on thrown errors the
        // accumulator stays intact so the next turn retries the same
        // changes plus whatever new ones land — no silent data loss on
        // transient network/timeout failures. On host `accepted: false`
        // we drain anyway: re-sending against the same stale parent
        // fails forever, and the proper "refresh parent on mismatch"
        // flow needs a wire change out of scope here. Same trade-off
        // the native runner makes; both paths share `DiffAccumulator`.
        if (!diffs.isEmpty()) {
          const snapshot = diffs.snapshot();
          try {
            const resp = (await client.call('workspace.commit-notify', {
              parentVersion,
              commitRef: randomUUID(),
              message: 'turn',
              changes: toWireChanges(snapshot),
            })) as WorkspaceCommitNotifyResponse;
            if (resp.accepted) {
              diffs.drain();
              parentVersion = resp.version as unknown as string;
            } else {
              diffs.drain();
            }
          } catch {
            /* preserve accumulator; next turn retries */
          }
        }

        // One turn of assistant output finished. The SDK now awaits the
        // next yield from userMessages() — i.e. the next inbox pull.
        //
        // We may emit up to TWO chat:turn-end events at this boundary:
        //   1. role='tool' if the runner observed any tool_result blocks
        //      during this turn (the SDK echoed them back as user msgs).
        //      Emitted FIRST because they chronologically precede the
        //      assistant's wrap-up text in the transcript.
        //   2. role='assistant' for the assistant turn itself. Emitted
        //      unconditionally as a heartbeat — contentBlocks is only
        //      attached when non-empty so empty turns stay heartbeats.
        //
        // Failures here MUST NOT terminate the chat (host may be tearing
        // down). Each call swallows independently.
        if (turnToolResultBlocks.length > 0) {
          const toolBlocks = turnToolResultBlocks;
          turnToolResultBlocks = [];
          await client
            .event('event.turn-end', {
              reason: 'user-message-wait',
              role: 'tool',
              contentBlocks: toolBlocks,
            })
            .catch(() => {
              /* host may be tearing down; non-fatal */
            });
        }

        const assistantBlocks = turnContentBlocks;
        turnContentBlocks = [];
        await client
          .event('event.turn-end', {
            reason: 'user-message-wait',
            role: 'assistant',
            ...(assistantBlocks.length > 0
              ? { contentBlocks: assistantBlocks }
              : {}),
          })
          .catch(() => {
            /* host may be tearing down; non-fatal */
          });
      }
      // system / partial / progress / etc. are SDK bookkeeping —
      // the host doesn't need to see them. (`user` messages ARE handled
      // above, but only to extract tool_result blocks for replay.)
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
