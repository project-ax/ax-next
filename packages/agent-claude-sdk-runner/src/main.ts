#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  query,
  type SDKAssistantMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { createInboxLoop } from './inbox-loop.js';
import {
  createIpcClient,
  type AgentMessage,
  type ContentBlock,
  type ConversationFetchHistoryResponse,
  type ConversationFetchHistoryTurn,
  type ImageBlock,
  type SessionGetConfigResponse,
  type TextBlock,
  type ToolListResponse,
  type WorkspaceCommitNotifyResponse,
  type WorkspaceMaterializeResponse,
} from '@ax/ipc-protocol';
import { createCanUseTool } from './can-use-tool.js';
import { readRunnerEnv } from './env.js';
import { createHostMcpServer } from './host-mcp-server.js';
import {
  advanceBaseline,
  commitTurnAndBundle,
  materializeWorkspace,
  rollbackToBaseline,
} from './git-workspace.js';
import { createPostToolUseHook } from './post-tool-use.js';
import { createPreToolUseHook } from './pre-tool-use.js';
import { setupProxy } from './proxy-startup.js';
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
// @anthropic-ai/claude-agent-sdk calls api.anthropic.com through the
// host-side credential-proxy (see proxy-startup.ts); the SDK's outbound
// x-api-key carries an `ax-cred:<hex>` placeholder that the proxy
// substitutes for the real Anthropic key mid-flight. If the sandbox is
// compromised, the real key never entered this process.
//
// Shape: one persistent `query()` driven by an async generator that pulls
// user messages from the inbox long-poll. That keeps a single SDK session
// alive for the life of the runner instead of spawning a fresh one per
// chat turn — the SDK's internal conversation history carries across
// turns automatically.
//
// Exit codes (the spawning host branches on these):
//   0 — chat completed normally (inbox returned cancel; SDK drained).
//   1 — terminated abnormally (SDK threw, IPC errored after retries, etc.).
//   2 — fatal during bootstrap (missing env, initial tool.list failure).
//
// Boot-failure paths (return 2 before the IPC client is built, or before
// the SDK iterator starts) exit WITHOUT firing `event.chat-end`. That's
// fine — the orchestrator's `handle.exited` watcher synthesizes a
// terminated outcome with reason `sandbox-exit-before-chat-end`, so
// chat:end still fires exactly once per agent:invoke from a subscriber's
// perspective.
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

  // Start the credential-proxy bridge if AX_PROXY_UNIX_SOCKET is set
  // (k8s sandbox); rewrite process.env.HTTP(S)_PROXY in-process so the
  // SDK's outbound fetch sees the loopback bridge. Direct mode
  // (AX_PROXY_ENDPOINT) is a no-op here — sandbox-subprocess already set
  // HTTPS_PROXY in the child env.
  let proxyStartup: Awaited<ReturnType<typeof setupProxy>>;
  try {
    proxyStartup = await setupProxy(env);
  } catch (err) {
    process.stderr.write(
      `runner: proxy setup failed: ${err instanceof Error ? err.message : String(err)}\n`,
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
  let conversationId: string | null = null;
  try {
    const cfg = (await client.call(
      'session.get-config',
      {},
    )) as SessionGetConfigResponse;
    agentConfig = cfg.agentConfig;
    // Task 15 (Week 10–12): the host populates conversationId at session-
    // creation time when the runner is for an existing conversation. The
    // runner uses a truthy value as the trigger to fetch transcript
    // history and replay it into the SDK's prompt iterator (J3 + J6
    // resume). We normalize `undefined` (older host that hasn't shipped
    // the field) and `null` (non-conversation session) into the same
    // skip-replay branch via a strict equality check on the string type
    // — anything else takes the fetch path.
    conversationId = typeof cfg.conversationId === 'string' ? cfg.conversationId : null;
  } catch (err) {
    process.stderr.write(
      `runner: session.get-config failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await client.close();
    return 2;
  }

  // Phase 3: materialize /permanent from a host-streamed baseline bundle
  // BEFORE the SDK query opens. Failure here is bootstrap-fatal — the
  // runner has nowhere to write tool output and can't bundle turn-end
  // diffs without a working tree.
  //
  // Why fatal vs. fall-through to `git init`: a materialize failure means
  // the host either crashed mid-bundle, or its workspace plugin returned
  // a malformed response. Either is a strong signal something is wrong
  // upstream; falling through would silently desync the runner from the
  // host's view of the workspace lineage. Better to fail loud and let
  // the operator see the error.
  try {
    const matResp = (await client.call(
      'workspace.materialize',
      {},
    )) as WorkspaceMaterializeResponse;
    await materializeWorkspace({
      root: env.workspaceRoot,
      bundleBase64: matResp.bundleBytes,
    });
  } catch (err) {
    process.stderr.write(
      `runner: workspace.materialize failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await client.close();
    return 2;
  }

  // Task 15 (Week 10–12): replay-at-boot. Fetch the persisted transcript
  // BEFORE constructing the SDK iterator so the model sees prior turns
  // before any live inbox message.
  //
  // Failure semantics: NON-FATAL. A storage hiccup or ACL drift here
  // shouldn't kill the chat — we'd rather hand the user a fresh
  // conversation than crash on resume. We log to stderr and continue
  // with an empty history.
  //
  // Phase C (2026-05-02): two paths now.
  //   1. `runnerSessionId !== null` — the conversation has a bound SDK
  //      session id from a prior runner. We pass it as `options.resume`
  //      to `query()` and SKIP the replay populate; the SDK rehydrates
  //      the conversation from its own on-disk transcript. Re-emitting
  //      the persisted turns would double-replay them.
  //   2. `runnerSessionId === null` — first-boot path (or unbind path).
  //      Yield prior user turns into the prompt iterator before the live
  //      inbox so the model has the context to regenerate.
  //
  // What we replay (when no resume is in effect) and what we DON'T:
  //   - User turns: yielded as SDKUserMessage. The SDK accepts a user
  //     message whose content is either a string or an Anthropic-
  //     compatible content-block array; we use the array form so
  //     multi-block user turns (e.g. with images) round-trip.
  //   - Assistant + tool turns: NOT re-yielded. The SDK's prompt
  //     iterator only accepts user-shaped messages, and Anthropic's API
  //     rejects tool_result blocks that aren't paired with a preceding
  //     assistant tool_use. The model regenerates the tool flow from
  //     the user-side context.
  let replayTurns: ConversationFetchHistoryTurn[] = [];
  let runnerSessionId: string | null = null;
  if (conversationId !== null) {
    try {
      const resp = (await client.call('conversation.fetch-history', {
        conversationId,
      })) as ConversationFetchHistoryResponse;
      runnerSessionId = resp.runnerSessionId;
      // When a runner-session id is bound, the SDK rehydrates the
      // transcript on its own via `options.resume` (set below). Skip the
      // replay populate so `userMessages()` only yields the live inbox.
      replayTurns = runnerSessionId === null ? resp.turns : [];
    } catch (err) {
      process.stderr.write(
        `runner: conversation.fetch-history failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      replayTurns = [];
      runnerSessionId = null;
    }
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
  // Phase 3: workspace commits are turn-end via git-status against
  // /permanent (`commitTurnAndBundle` at the SDK `result` boundary).
  // The legacy PostToolUse-based diff accumulator is gone — git status
  // catches ALL writes regardless of tool, including the Bash deletes
  // and MCP writes the legacy path missed.

  // Tracks the last accepted workspace version so the host's optimistic-
  // concurrency check sees a coherent lineage across turns.
  let parentVersion: string | null = null;

  // Phase C: bind the SDK's session_id to our conversation row.
  //
  // The Anthropic SDK owns durable transcripts on disk (under HOME, which
  // we redirect into the workspace in a sibling task). The first message
  // every `query()` emits is `{ type: 'system', subtype: 'init',
  // session_id, ... }` — see SDKSystemMessage in
  // @anthropic-ai/claude-agent-sdk/sdk.d.ts:3282-3314. We capture that
  // session_id once and POST it to the host so a future runner restart
  // can `resume(sessionId)` instead of replaying the transcript from
  // our DB.
  //
  // Once-only: a single `query()` can re-emit system/init on a resume
  // path. Only the FIRST init is load-bearing for the bind — the runner
  // sets the flag BEFORE the await so a re-entrant init can't
  // double-fire even if the IPC is in flight.
  //
  // Non-fatal: if the bind fails, we lose the resume optimization on
  // next restart and fall back to fetch-history replay. The chat itself
  // continues uninterrupted.
  let runnerSessionIdSent = false;
  // Host-side bookkeeping for the final event.chat-end outcome. The SDK
  // maintains its OWN transcript internally; this array is only the shape
  // the host cares about (user/assistant text round-tripped through
  // AgentMessage). NOT the same as `replayTurns` above — replayTurns is
  // the persisted history we pull at boot to seed the SDK; chatEndHistory
  // is the within-process trace the host gets at chat:end.
  const chatEndHistory: AgentMessage[] = [];

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

  // Most-recent host-minted reqId from the inbox (J9). Set when a user
  // message arrives; read by `event.stream-chunk` emissions during the
  // assistant branch below. Lifetime is "from the inbox pull until the
  // next inbox pull" — chunks for the SAME reqId may continue across
  // multiple SDK `result` boundaries (the SDK may break a long response
  // into multiple turns), so we DO NOT clear this on turn-end. A chunk
  // that would emit before any user message has been pulled is impossible
  // by SDK construction (no input → no output), but we defend anyway:
  // an unset reqId causes the chunk to be skipped (no `event.stream-chunk`
  // with a missing reqId — the host's router can't route it).
  let currentReqId: string | undefined;

  // Inbox → SDK user-message generator. Closing via `return` on cancel
  // tells the SDK no more user messages are coming, which lets the outer
  // `for await (msg of queryIter)` drain naturally and exit.
  //
  // Task 15 (Week 10–12): replay-at-boot. We yield prior user turns
  // (role=user with text content) BEFORE pulling from the live inbox.
  // Assistant AND tool turns are skipped — the model regenerates the
  // tool flow from the user-side context. We can't re-yield tool turns
  // standalone: Anthropic's API rejects (400 invalid_request_error) any
  // tool_result block that isn't paired with a tool_use in the
  // immediately preceding assistant message, and we don't have the
  // assistant turn (since the prompt iterator only accepts user-shaped
  // messages). The conversation row still stores the tool turn (Task
  // 3's auto-append); on replay the SDK only sees user text turns and
  // the model regenerates tool flows from there.
  //
  // Phase C (2026-05-02): when `runnerSessionId !== null`, the boot
  // block above sets `replayTurns = []` so this generator only yields
  // the live inbox. The SDK rehydrates the transcript itself via
  // `options.resume = runnerSessionId` (set on the `query()` call
  // below). No double-replay.
  async function* userMessages(): AsyncGenerator<SDKUserMessage> {
    // ----- replay -----
    for (const turn of replayTurns) {
      if (turn.role === 'user') {
        // Collapse plain-text contentBlocks back into a string for the
        // SDK (matches the live-inbox shape so the model doesn't see a
        // mid-conversation format change). Multi-block user turns
        // (e.g. with images) yield the full block array.
        const allText = turn.contentBlocks.every(
          (b): b is TextBlock => b.type === 'text',
        );
        const content: SDKUserMessage['message']['content'] = allText
          ? turn.contentBlocks
              .map((b) => (b as TextBlock).text)
              .join('\n')
          : (turn.contentBlocks as unknown as SDKUserMessage['message']['content']);
        yield {
          type: 'user',
          parent_tool_use_id: null,
          message: { role: 'user', content },
        };
      } else {
        // assistant + tool turns are NOT re-yielded; the model
        // regenerates from the user-side context. Tool turns
        // specifically can't be yielded standalone (Anthropic 400:
        // tool_result without paired tool_use in the immediately
        // preceding assistant message).
        process.stderr.write(
          `runner: skipping replay of role=${turn.role} turn (model will regenerate from user-side context)\n`,
        );
      }
    }
    // ----- live inbox -----
    for (;;) {
      const entry = await inbox.next();
      if (entry.type === 'cancel') return;
      if (entry.payload === undefined) continue;
      // Capture the host-minted reqId so subsequent stream-chunk
      // emissions correlate back to the originating request. Both fields
      // are set on `user-message` entries by the InboxLoop layer.
      if (typeof entry.reqId === 'string' && entry.reqId.length > 0) {
        currentReqId = entry.reqId;
      }
      chatEndHistory.push({ role: 'user', content: entry.payload.content });
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
        // Phase C: SDK resume(sessionId). When the conversation has a
        // bound runner session id, the SDK rehydrates the transcript
        // from its own on-disk store under HOME (workspaceRoot, see
        // below). Spread-conditional so the field is OMITTED on first
        // boot — the SDK's `resume?: string` typing is "string or
        // missing", not "string or null"; passing `undefined` would be
        // a type-level rather than a wire-level signal.
        ...(runnerSessionId !== null ? { resume: runnerSessionId } : {}),
        // ANTHROPIC_API_KEY is the `ax-cred:<hex>` placeholder (substituted
        // by the credential-proxy mid-flight); no ANTHROPIC_BASE_URL — SDK
        // calls api.anthropic.com directly through HTTPS_PROXY.
        //
        // Phase C: HOME redirect for the SDK subprocess.
        //   - The k8s sandbox pod sets HOME=/nonexistent at the pod level
        //     so `git` (and any other tool the runner spawns) can't
        //     accidentally read a global ~/.gitconfig — git-paranoia.
        //   - The SDK needs HOME pointed at the workspace so its native
        //     ~/.claude/projects/<sessionId>.jsonl lands where the
        //     turn-end `git status + git add -A + bundle` captures it,
        //     closing the jsonl gap that workspace Phase 3 set up the
        //     plumbing for.
        //   - The runner-process git operations inherit HOME=/nonexistent
        //     from process.env (we don't override their env), so the
        //     redirect is targeted to this SDK subprocess only.
        //   - Side effect: the SDK's auxiliary files (`.claude.json`,
        //     `.claude/backups/`, etc.) also land in the workspace.
        //     Acceptable trade-off (Q1 of the Phase C plan): the `.ax/`
        //     filter in workspace:pre-apply doesn't subscribe validators
        //     to them, and we can split with a symlink/copy step in a
        //     follow-up if needed.
        //   - HOME is spread AFTER ...proxyStartup.anthropicEnv so this
        //     value wins on conflict. anthropicEnv currently doesn't set
        //     HOME, but defensive ordering matches the intent: we
        //     explicitly redirect HOME for the SDK subprocess.
        env: {
          ...proxyStartup.anthropicEnv,
          HOME: env.workspaceRoot,
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
                createPostToolUseHook({ client }),
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
      if (
        msg.type === 'system' &&
        msg.subtype === 'init' &&
        !runnerSessionIdSent
      ) {
        // Set BEFORE the await so a re-entrant system/init (e.g. on a
        // future resume() path) can't double-fire while this IPC is in
        // flight.
        runnerSessionIdSent = true;
        if (conversationId !== null) {
          try {
            await client.call('conversation.store-runner-session', {
              conversationId,
              runnerSessionId: msg.session_id,
            });
          } catch (err) {
            // Non-fatal: we lose the resume optimization on the next
            // restart — the runner falls back to fetch-history replay.
            // The chat continues uninterrupted.
            process.stderr.write(
              `runner: conversation.store-runner-session failed: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        continue;
      }
      if (msg.type === 'assistant') {
        const assistant: SDKAssistantMessage = msg;
        // Only plain text blocks round-trip into host history. Tool-use
        // blocks stay inside the SDK's session — the host observes tool
        // activity via event.tool-post-call, not via the transcript.
        const text = assistant.message.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n');
        if (text.length > 0) {
          chatEndHistory.push({ role: 'assistant', content: text });
        }
        // Accumulate full ContentBlock[] for the per-turn transcript that
        // ships to @ax/conversations via event.turn-end. Every block kind
        // ContentBlockSchema knows about is mapped explicitly:
        //   - text / thinking / redacted_thinking / tool_use
        //
        // Replay (Task 15) requires Anthropic-compatibility (J3): a
        // missing redacted_thinking block leaves a hole the model can
        // detect on a follow-up turn, so we MUST preserve it verbatim.
        // Unknown block kinds are dropped defensively so a future SDK
        // addition can't bypass the canonical schema.
        for (const block of assistant.message.content) {
          if (block.type === 'text') {
            turnContentBlocks.push({ type: 'text', text: block.text });
            // Per-block streaming (Task 6 / J9). The SDK delivers text
            // blocks as the model produces them; we forward each as a
            // `event.stream-chunk` so the host's chat:stream-chunk
            // subscriber (Task 5) can fan out to waiting clients (Task
            // 7). Empty-text blocks are skipped — emitting `{ text: '' }`
            // chunks is noise. Failure is non-fatal: the host may be
            // tearing down, and the canonical transcript still flows
            // via event.turn-end / event.chat-end. Untrusted (J2):
            // `block.text` is model output and reaches the host
            // verbatim — host-side renderers sanitize.
            if (currentReqId !== undefined && block.text.length > 0) {
              await client
                .event('event.stream-chunk', {
                  reqId: currentReqId,
                  text: block.text,
                  kind: 'text',
                })
                .catch(() => {
                  /* host may be tearing down; non-fatal */
                });
            }
          } else if (block.type === 'thinking') {
            turnContentBlocks.push({
              type: 'thinking',
              thinking: block.thinking,
              ...(typeof block.signature === 'string'
                ? { signature: block.signature }
                : {}),
            });
            // Same per-block streaming for thinking. The host's UI
            // toggles thinking visibility (Task 21 / J4), but the
            // chunk still travels with `kind: 'thinking'` so a
            // subscriber can route it to the right pane.
            if (currentReqId !== undefined && block.thinking.length > 0) {
              await client
                .event('event.stream-chunk', {
                  reqId: currentReqId,
                  text: block.thinking,
                  kind: 'thinking',
                })
                .catch(() => {
                  /* host may be tearing down; non-fatal */
                });
            }
          } else if (block.type === 'redacted_thinking') {
            // Redacted-thinking blocks have no human-readable text — the
            // model returned an opaque blob. We persist it (J3 — the
            // SDK detects holes on follow-up turns) but DO NOT emit a
            // stream chunk: there's nothing to render, and `kind`
            // wouldn't accept it anyway.
            turnContentBlocks.push({
              type: 'redacted_thinking',
              data: (block as { data: string }).data,
            });
          } else if (block.type === 'tool_use') {
            // Tool-use blocks are observed via event.tool-post-call
            // (when the tool actually runs) and persisted at turn-end.
            // They are not streamed text and have no `kind` mapping.
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
                // Narrow array content to the text/image subset per
                // ToolResultBlockSchema (`string | (TextBlock |
                // ImageBlock)[]`). Image entries MUST round-trip — a
                // tool that returns image content (screenshot tool, Read
                // on a binary, etc.) loses context on replay otherwise.
                // Other entry types are dropped defensively so a future
                // SDK shape doesn't silently bypass the canonical schema.
                let normalizedContent: string | Array<TextBlock | ImageBlock> =
                  '';
                if (typeof tr.content === 'string') {
                  normalizedContent = tr.content;
                } else if (Array.isArray(tr.content)) {
                  const narrowed: Array<TextBlock | ImageBlock> = [];
                  for (const item of tr.content as Array<{
                    type?: string;
                    text?: unknown;
                    source?: unknown;
                  }>) {
                    if (item.type === 'text' && typeof item.text === 'string') {
                      narrowed.push({ type: 'text', text: item.text });
                    } else if (
                      item.type === 'image' &&
                      item.source !== undefined
                    ) {
                      // The SDK's image-block shape matches ImageBlock
                      // already; the .source discriminated-union is
                      // validated at the storage boundary by
                      // ContentBlockSchema, so no further narrowing here.
                      narrowed.push(item as unknown as ImageBlock);
                    }
                  }
                  normalizedContent = narrowed;
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
        // Turn boundary (Phase 3). Replaces the legacy PostToolUse-based
        // diff observer with `git status` + bundle:
        //   1. Stage everything in /permanent (`git add -A`) — catches
        //      ALL writes, regardless of which tool wrote (Bash, MCP,
        //      SDK Write/Edit/MultiEdit, raw fs, jsonl). Closes the
        //      Bash-delete + MCP-write + jsonl gaps that motivated
        //      the redesign.
        //   2. If nothing's staged → empty turn → skip commit-notify
        //      entirely (same heartbeat-only semantic the legacy path
        //      had for empty diffs).
        //   3. Otherwise: commit, build a thin `baseline..main` bundle,
        //      ship as `workspace.commit-notify`.
        //   4. On accept: advance refs/heads/baseline so the next turn
        //      bundles from the new state.
        //   5. On veto: roll the working tree back to baseline (the
        //      agent's writes for this turn are undone).
        //   6. On IPC error (host unreachable, 5xx): preserve the
        //      working tree as-is. Don't advance baseline; don't
        //      rollback. The next turn's `git add -A` will accumulate
        //      this turn's changes plus the next turn's, and we ship
        //      the combined bundle. Best-effort retry by accumulation.
        //
        // Failures here MUST NOT terminate the chat — `event.turn-end`
        // is still the heartbeat the host keys off.
        try {
          const bundleB64 = await commitTurnAndBundle({
            root: env.workspaceRoot,
            reason: 'turn',
          });
          if (bundleB64 !== null) {
            try {
              const resp = (await client.call('workspace.commit-notify', {
                parentVersion,
                reason: 'turn',
                bundleBytes: bundleB64,
              })) as WorkspaceCommitNotifyResponse;
              if (resp.accepted) {
                parentVersion = resp.version as unknown as string;
                await advanceBaseline(env.workspaceRoot);
              } else {
                // Host vetoed — surface to stderr (the host's log sink)
                // and rollback so the agent's next turn starts clean.
                process.stderr.write(
                  `runner: workspace rejected: ${resp.reason}\n`,
                );
                await rollbackToBaseline(env.workspaceRoot);
              }
            } catch (err) {
              // Network / 5xx / timeout: keep the working tree intact
              // so the next turn's accumulated changes flow as one
              // bundle. Don't advance baseline; don't rollback. Same
              // trade-off the legacy accumulator path made.
              process.stderr.write(
                `runner: commit-notify failed: ${err instanceof Error ? err.message : String(err)}\n`,
              );
            }
          }
        } catch (err) {
          // commitTurnAndBundle itself failed (git binary missing,
          // /permanent in a weird state, etc.). Non-fatal; the next
          // turn will retry.
          process.stderr.write(
            `runner: commitTurnAndBundle failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
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
      ? { kind: 'complete' as const, messages: chatEndHistory }
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
  // Stop the credential-proxy bridge (k8s mode) so its TCP port and active
  // sockets are released before the runner exits. Best-effort: any failure
  // here shouldn't change the exit code — the chat already emitted its
  // outcome.
  if (proxyStartup.stop !== undefined) {
    try {
      proxyStartup.stop();
    } catch {
      /* swallow */
    }
  }
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
