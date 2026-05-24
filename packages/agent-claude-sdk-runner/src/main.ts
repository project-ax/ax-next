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
  IpcRequestError,
  type AgentMessage,
  type ContentBlock,
  type ImageBlock,
  type SessionGetConfigResponse,
  type TextBlock,
  type ToolListResponse,
  type WorkspaceMaterializeResponse,
  type WorkspaceReadRequest,
  type WorkspaceReadResponse,
} from '@ax/ipc-protocol';
import {
  translateContentBlocks,
  type WorkspaceReader,
} from './attachment-translation.js';
import { createCanUseTool } from './can-use-tool.js';
import { readRunnerEnv } from './env.js';
import { createHostMcpServer } from './host-mcp-server.js';
import {
  commitTurnAndBundle,
  materializeWorkspace,
  scaffoldSdkProjectsSymlink,
  scaffoldWorkspaceGitignore,
  scaffoldWorkspaceSkillSurface,
} from './git-workspace.js';
import { commitNotifyWithResync } from './commit-notify-resync.js';
import { commitTrace } from './commit-trace.js';
import { createLocalDispatcher } from './local-dispatcher.js';
import { buildToolCacheEnv } from './tool-cache-env.js';
import { buildPythonVenvEnv, scaffoldPythonVenv } from './python-venv.js';
import { createPostToolUseHook } from './post-tool-use.js';
import { createPreToolUseHook } from './pre-tool-use.js';
import { setupProxy } from './proxy-startup.js';
import { createSandboxMcpServer } from './sandbox-mcp-server.js';
import { buildSystemPrompt } from './system-prompt.js';
import { createArtifactPublishExecutor } from './artifact-publish-executor.js';
import { materializeInstalledSkillsFromEnv } from './installed-skills.js';
import { DISABLED_BUILTINS, MCP_HOST_SERVER_NAME, MCP_SANDBOX_SERVER_NAME } from './tool-names.js';
import {
  hasResumableTranscript,
  readLastTurnUuid,
  waitForTranscriptUuid,
} from './turn-end-uuid.js';
import { ARTIFACT_PUBLISH_TOOL_NAME } from '@ax/tool-artifact-publish';

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

export { createArtifactPublishExecutor } from './artifact-publish-executor.js';
export type {
  ArtifactPublishOutput,
  CreateArtifactPublishExecutorOptions,
} from './artifact-publish-executor.js';

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

  // Phase 1 (skill-install): materialize installed skills from
  // AX_INSTALLED_SKILLS_JSON BEFORE the SDK spawns. The sandbox-k8s plugin
  // passes skill content via this env var (subprocess sandbox writes files
  // directly during open-session instead). A failure here is bootstrap-
  // fatal — the SDK discovers skills at startup; missing files it expects
  // would produce a silent skill gap for the entire session life.
  try {
    await materializeInstalledSkillsFromEnv();
  } catch (err) {
    process.stderr.write(
      `runner: installed-skills materialize failed: ${err instanceof Error ? err.message : String(err)}\n`,
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
  let runnerSessionId: string | null = null;
  try {
    const cfg = (await client.call(
      'session.get-config',
      {},
    )) as SessionGetConfigResponse;
    agentConfig = cfg.agentConfig;
    // Task 15 (Week 10–12): the host populates conversationId at session-
    // creation time when the runner is for an existing conversation. The
    // runner uses a non-null value as the trigger to bind the SDK
    // session id back via `conversation.store-runner-session` after
    // first init. We normalize `undefined` (older host that hasn't
    // shipped the field) and `null` (non-conversation session) into the
    // same skip-bind branch via a strict equality check on the string
    // type.
    conversationId = typeof cfg.conversationId === 'string' ? cfg.conversationId : null;
    // Phase E (2026-05-09): runnerSessionId rides the same response now
    // that `conversation.fetch-history` is gone. Non-null = the SDK has
    // bound a session id on a prior boot; we pass it as `options.resume`
    // to `query()` below so the SDK rehydrates from its own on-disk
    // transcript instead of starting a fresh conversation. Null = first
    // boot OR conversationId is null; the SDK starts fresh.
    //
    // Empty string is treated as null. The wire schema is
    // `z.string().nullable()` (no `.min(1)`), so a future bug or stale
    // row could in principle deliver `''`. Passing `resume: ''` to the
    // SDK is undefined behavior; coerce defensively.
    runnerSessionId =
      typeof cfg.runnerSessionId === 'string' && cfg.runnerSessionId.length > 0
        ? cfg.runnerSessionId
        : null;
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
  // The materialize-time tip OID seeds parentVersion below. When the
  // workspace already has prior history (any session beyond the first
  // ever), this is the workspace's actual HEAD — not null. Sending
  // null on the first commit-notify of a non-first session would make
  // the host export the deterministic empty baseline whose tip
  // doesn't match our local baseline ref, and the bundler would
  // reject our thin bundle with "Repository lacks these prerequisite
  // commits".
  let initialBaselineCommit: string;
  // Set true once the session Python venv exists (created or pre-present).
  // Gates the venv env wiring + system-prompt note below.
  let pythonVenvReady = false;
  try {
    const matResp = (await client.call(
      'workspace.materialize',
      {},
    )) as WorkspaceMaterializeResponse;
    const out = await materializeWorkspace({
      root: env.workspaceRoot,
      bundleBase64: matResp.bundleBytes,
    });
    initialBaselineCommit = out.baselineCommit;
    // Lay down `.claude/skills` → `../.ax/skills` so the SDK's
    // `'project'` skill source resolves. Must run AFTER the clone — see
    // scaffoldWorkspaceSkillSurface's doc for the regression that
    // motivated moving this off the k8s init container.
    await scaffoldWorkspaceSkillSurface(env.workspaceRoot);
    // Ensure dependency/build artifacts (node_modules, venvs, __pycache__,
    // fetch caches) are git-ignored so agent tooling output isn't committed +
    // bundled back to the host. Must run AFTER the clone for the same reason
    // as the skill-surface scaffold (it appends to any baseline .gitignore).
    await scaffoldWorkspaceGitignore(env.workspaceRoot);
    // Phase E follow-up: redirect the SDK's turn-transcript jsonl
    // writes back into the workspace. Phase 0 set CLAUDE_CONFIG_DIR
    // OUTSIDE /permanent so the `'user'` skill-discovery source could
    // be distinct from the `'project'` source, but the SDK ALSO derives
    // `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sid>.jsonl` from the
    // same var — the transcript writes moved with it. We restore the
    // pre-Phase-0 invariant ("turn-end git add -A captures the SDK's
    // own jsonl") with a filesystem-level redirect: a symlink at
    // `$CLAUDE_CONFIG_DIR/projects` pointing into the workspace. See
    // scaffoldSdkProjectsSymlink's doc and the (a)/(b) comment block
    // around the SDK query() env literal below for the full picture.
    //
    // Guard: CLAUDE_CONFIG_DIR is sandbox-injected. If a future sandbox
    // provider doesn't set it, fall through to the pre-Phase-0 behavior
    // (HOME redirect below sends the SDK's jsonls to `<HOME>/.claude/
    // projects/...` which IS inside workspaceRoot already).
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    if (claudeConfigDir) {
      await scaffoldSdkProjectsSymlink(env.workspaceRoot, claudeConfigDir);
    }
  } catch (err) {
    process.stderr.write(
      `runner: workspace.materialize failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await client.close();
    return 2;
  }

  // Create a session-scoped Python venv on the ephemeral tier so the agent's
  // `pip install` + `import` Just Work. The image bakes a relocatable, pre-
  // seeded venv template; scaffoldPythonVenv copies it onto the ephemeral tier
  // OFFLINE (~1s) — see python-venv.ts. (Fallback when no template is baked:
  // an online `uv venv --seed`, which fetches from pypi and is slow/may hang
  // when pypi egress is denied — local dev only.)
  //
  // BOUNDED-WAIT (and OUTSIDE the materialize try — a venv failure must NOT
  // abort the session): we wait up to `venvReadyWaitMs` so the fast baked-
  // template copy resolves before the FIRST turn (so its `pip` is on PATH),
  // while the slow online fallback (or a hung uv) exceeds the budget and stays
  // non-blocking — `pythonVenvReady` flips when/if it later succeeds, and turns
  // before then simply skip the venv env wiring (opt-in via `pip install`). This
  // bound is what keeps a denied-pypi fallback from stalling the cold-start
  // turn. AX_VENV_READY_WAIT_MS tunes it (tests set 0 to assert non-blocking).
  if (env.ephemeralRoot) {
    const parsedVenvWait = Number.parseInt(
      process.env.AX_VENV_READY_WAIT_MS ?? '',
      10,
    );
    const venvReadyWaitMs = Number.isFinite(parsedVenvWait)
      ? parsedVenvWait
      : 5000;
    const scaffoldDone = scaffoldPythonVenv(env.ephemeralRoot)
      .then((ok) => {
        pythonVenvReady = ok;
      })
      .catch(() => {
        /* scaffoldPythonVenv never throws; defensive */
      });
    await Promise.race([
      scaffoldDone,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, venvReadyWaitMs);
        t.unref?.();
      }),
    ]);
  }

  // Per-turn transcript-flush wait (2026-05-22 conversations:get-latency fix).
  // The Anthropic Agent SDK writes the assistant turn's jsonl line AFTER it
  // yields `result`, so the per-turn commit in the `result` handler below
  // would otherwise stage `/permanent` BEFORE the reply lands and ship a
  // bundle missing it. Under idle-keepalive the warm runner doesn't drain the
  // SDK loop (no final commit) until idle-reap, so the reply stayed unreadable
  // via conversations:get for the whole idle window (minutes). We wait for the
  // new assistant line before each per-turn commit so EVERY turn's bundle
  // contains its own reply. Timeout/interval are env-tunable (tests set 0 to
  // skip the wait); production defaults are 5 s / 50 ms. On timeout we fall
  // through to the prior behavior — the next turn's commit or the final commit
  // still captures the line — so the wait is a strict improvement.
  const parsedFlushTimeout = Number.parseInt(
    process.env.AX_TURN_FLUSH_TIMEOUT_MS ?? '',
    10,
  );
  const parsedFlushInterval = Number.parseInt(
    process.env.AX_TURN_FLUSH_INTERVAL_MS ?? '',
    10,
  );
  const flushTimeoutMs = Number.isFinite(parsedFlushTimeout)
    ? parsedFlushTimeout
    : 5000;
  const flushIntervalMs =
    Number.isFinite(parsedFlushInterval) && parsedFlushInterval > 0
      ? parsedFlushInterval
      : 50;
  // SDK session_id used to LOCATE the jsonl for the flush wait. Starts as the
  // resume id (if any); set to the SDK's session_id on the first system/init.
  // Distinct from `runnerSessionId` (which only ever holds the resume value)
  // so the turnId-on-event behavior at the turn-end emissions stays unchanged.
  let transcriptSessionId: string | null = runnerSessionId;

  // Phase E (2026-05-09): the replay-at-boot path is gone. Transcripts
  // live in the runner's native ~/.claude/projects/<sessionId>.jsonl
  // file (HOME-redirected into the workspace by Phase C), and the host
  // reads them back via @ax/workspace-* on demand (Phase D). The runner
  // never re-emits prior user turns into the SDK's prompt iterator: the
  // SDK's own `resume(sessionId)` rehydrates the entire conversation
  // from disk when `runnerSessionId` is set above, and a null
  // `runnerSessionId` means there's no prior conversation to rehydrate
  // (first boot for this conversation, or non-conversation session).
  //
  // What used to be `conversation.fetch-history` is gone too: the bind
  // state (`runnerSessionId`) now rides on the `session.get-config`
  // response, composed by the host's IPC handler from
  // `conversations:get-metadata`. One IPC, one response — no separate
  // replay payload to chase.

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

  // Phase 2: sandbox-MCP bridge. The local-dispatcher holds executors for
  // tools marked `executesIn: 'sandbox'`. Today only `artifact_publish`
  // uses this path; future sandbox tools register here too.
  const localDispatcher = createLocalDispatcher();
  if (tools.some((t) => t.name === ARTIFACT_PUBLISH_TOOL_NAME && t.executesIn === 'sandbox')) {
    localDispatcher.register(
      ARTIFACT_PUBLISH_TOOL_NAME,
      createArtifactPublishExecutor({ workspaceRoot: env.workspaceRoot }),
    );
  }
  const sandboxMcpServer = createSandboxMcpServer({
    dispatcher: localDispatcher,
    tools,
  });

  const inbox = createInboxLoop({ client });

  // Phase 2: feature-detect whether the pinned claude-agent-sdk supports
  // `document` content blocks. The SDK exposes its accepted block types
  // via a type-only export, so we probe by environment variable for now.
  // Pinning the SDK version makes this a static answer in practice; we
  // keep the override so a future SDK bump doesn't silently regress.
  // Conservative default: false. Override via env for early access.
  const SUPPORTS_DOCUMENT_BLOCKS = process.env.AX_SDK_DOCUMENT_BLOCKS === '1';

  const workspaceReader: WorkspaceReader = async (path) => {
    const resp = (await client.call('workspace.read', {
      path,
    } as WorkspaceReadRequest)) as WorkspaceReadResponse;
    return resp;
  };

  // Phase 3: workspace commits are turn-end via git-status against
  // /permanent (`commitTurnAndBundle` at the SDK `result` boundary).
  // The legacy PostToolUse-based diff accumulator is gone — git status
  // catches ALL writes regardless of tool, including the Bash deletes
  // and MCP writes the legacy path missed.

  // Tracks the last accepted workspace version so the host's optimistic-
  // concurrency check sees a coherent lineage across turns. Initialized
  // to the materialize-time baseline OID so the FIRST commit-notify of
  // this session reports a parent that matches what the host's
  // workspace-export-baseline-bundle hook will reproduce.
  let parentVersion: string | null = initialBaselineCommit;

  // Phase C: bind the SDK's session_id to our conversation row.
  //
  // The Anthropic SDK owns durable transcripts on disk (under HOME, which
  // we redirect into the workspace in a sibling task). The first message
  // every `query()` emits is `{ type: 'system', subtype: 'init',
  // session_id, ... }` — see SDKSystemMessage in
  // @anthropic-ai/claude-agent-sdk/sdk.d.ts:3282-3314. We capture that
  // session_id once and POST it to the host so a future runner restart
  // can `resume(sessionId)` — read back via the runnerSessionId field
  // on the next session.get-config response (Phase E).
  //
  // Once-only: a single `query()` can re-emit system/init on a resume
  // path. Only the FIRST init is load-bearing for the bind — the runner
  // sets the flag BEFORE the await so a re-entrant init can't
  // double-fire even if the IPC is in flight.
  //
  // Non-fatal: if the bind fails, we lose the resume optimization on
  // next restart (the SDK starts a fresh session and writes a new jsonl,
  // which the workspace-jsonl reader still picks up alongside any
  // earlier jsonl files). The chat itself continues uninterrupted.
  let runnerSessionIdSent = false;
  // Host-side bookkeeping for the final event.chat-end outcome. The SDK
  // maintains its OWN transcript internally; this array is only the shape
  // the host cares about (user/assistant text round-tripped through
  // AgentMessage).
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
  // The uuid of the turn's MOST-RECENT assistant message (SDKAssistantMessage
  // .uuid). The SDK assigns this id to the jsonl line it writes for the
  // message. The per-turn commit waits for THIS uuid to land in the jsonl
  // before staging, so the turn's closing-text line is durable even on a
  // tool-using turn (whose intermediate tool_use line lands first). Reset at
  // each `result` boundary; the gate skips the wait when the turn produced no
  // assistant message. See waitForTranscriptUuid (TASK-11).
  let turnLastAssistantUuid: string | undefined;

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
  // Phase E (2026-05-09): no more replay-from-DB. The SDK's
  // `resume(sessionId)` rehydrates the transcript from its own on-disk
  // store (~/.claude/projects/<sessionId>.jsonl, HOME-redirected into
  // the workspace by Phase C) when `runnerSessionId !== null`. The
  // generator only yields live inbox messages; prior turns are the
  // SDK's responsibility to surface to the model.
  async function* userMessages(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const entry = await inbox.next();
      if (entry.type === 'cancel') return;
      if (entry.type === 'idle-timeout') {
        // Host-crash floor: nobody is going to send us another message and
        // the host idle reaper isn't around to cancel us. Drain the SDK and
        // exit cleanly (same as cancel) — we still emit our single chat:end
        // on the way out (main.ts tail), which the host's session:terminate
        // path keys off.
        process.stderr.write('runner: inbox idle floor reached; exiting\n');
        return;
      }
      if (entry.payload === undefined) continue;
      // Capture the host-minted reqId so subsequent stream-chunk
      // emissions correlate back to the originating request. Both fields
      // are set on `user-message` entries by the InboxLoop layer.
      if (typeof entry.reqId === 'string' && entry.reqId.length > 0) {
        currentReqId = entry.reqId;
      }
      const hasBlocks =
        entry.payload.contentBlocks !== undefined &&
        entry.payload.contentBlocks.length > 0;

      // When the chat-messages handler ships both `content` (typed text)
      // AND `contentBlocks` (attachments) for a single user turn (Phase 3),
      // we need to preserve BOTH. Dropping `content` here would erase the
      // user's typed prompt the moment an attachment was attached. Emit
      // text-first so the model reads the user's intent before the blocks.
      // The empty-text guard skips synthetic empty text the chat-messages
      // handler may send when the user attaches without typing.
      const userText = entry.payload.content;
      const messageContent: unknown = hasBlocks
        ? [
            ...(userText.length > 0 ? [{ type: 'text', text: userText }] : []),
            ...(await translateContentBlocks(entry.payload.contentBlocks!, {
              readWorkspace: workspaceReader,
              supportsDocumentBlocks: SUPPORTS_DOCUMENT_BLOCKS,
            })),
          ]
        : userText;

      // Keep chatEndHistory as text-only — if contentBlocks were used,
      // include the user's typed text (if any) plus a short blocks summary
      // so the chat-end event payload doesn't carry raw bytes. Phase 3 may
      // refine this once downstream consumers of event.chat-end's
      // outcome.messages are clearer about what they need.
      chatEndHistory.push({
        role: 'user',
        content: hasBlocks
          ? `${userText}${userText.length > 0 ? ' ' : ''}[${entry.payload.contentBlocks!.length} blocks]`
          : userText,
      });

      yield {
        type: 'user',
        parent_tool_use_id: null,
        // Cast: SDKUserMessage.message.content is typed `string` today, but
        // the SDK accepts content-block arrays at runtime (the SDK's outbound
        // schema permits both shapes; the type just hasn't been widened yet).
        // Phase 3 may upstream a proper type widening to the SDK pin.
        message: { role: 'user', content: messageContent } as never,
      };
    }
  }

  let exitCode = 0;
  let terminatedReason: string | undefined;
  let terminatedError:
    | { name: string; message: string; stack?: string }
    | undefined;

  // F2a resume guard (defense-in-depth). `query({ resume: X })` hard-crashes
  // the runner (`exit 1` → chat-end `terminated`) with "No conversation found
  // with session ID: X" whenever the bound session has NO parseable transcript
  // in the materialized workspace. The host bind is now deferred to the first
  // durable commit (see bindRunnerSessionIfNeeded), so a bound id should always
  // have a transcript — but if a materialize/git regression ever drops it, omit
  // `resume` and start fresh instead of crashing. Verified against the live SDK
  // (0.2.119) on 2026-05-24: a missing/empty/metadata-only/garbage transcript
  // is exactly what triggers the crash; a real user/assistant transcript
  // resumes cleanly even with a truncated trailing line.
  let resumeSessionId = runnerSessionId;
  if (
    runnerSessionId !== null &&
    !(await hasResumableTranscript(env.workspaceRoot, runnerSessionId))
  ) {
    process.stderr.write(
      'runner: bound runner session has no resumable transcript in the workspace; starting fresh instead of resuming\n',
    );
    resumeSessionId = null;
    // `transcriptSessionId` was seeded to the (stale) resume id above; the SDK
    // will mint a FRESH session id now that we omit `resume`, so clear it back
    // to null so the system/init handler re-captures the new id. Otherwise the
    // turn-end flush wait would poll the wrong (non-existent) jsonl.
    transcriptSessionId = null;
  }

  // F2a root fix: bind the conversation row → runner-native transcript ONCE,
  // after the first host-ACCEPTED turn-end commit — NOT at `system/init`.
  // Binding at init persisted `runner_session_id` ~1s into the turn, BEFORE the
  // transcript is durable on the host (commits fire only at turn-end). A turn
  // killed in that window left a binding that points at nothing, so the retry's
  // `query({ resume })` crashed with "No conversation found". Deferring the bind
  // to a host-accepted commit makes `runner_session_id` set IFF a resumable
  // transcript exists → a killed-before-commit turn leaves it NULL → the retry
  // starts fresh cleanly. Gated to the fresh-boot case (`runnerSessionId` null);
  // a resumed session is already bound on the host.
  //
  // Failure handling distinguishes two cases:
  //   - definitive host rejection (4xx IpcRequestError — don't-retry per the
  //     IPC taxonomy): the conversation can't be bound to this id. The chief
  //     case is 409 conflict (HOOK_REJECTED) — the host already bound this
  //     conversation to a DIFFERENT id, a concurrent fresh-boot race in which
  //     another runner won; we are the loser and continuing to stream/commit
  //     under our orphan transcript would diverge the conversation. (404/400
  //     are likewise unrecoverable.) RE-THROW so the run terminates (host
  //     chat:end outcome `terminated`, surfaced by F2b) rather than silently
  //     committing an orphan. The host's once-only bind invariant relies on
  //     the loser stopping here.
  //   - anything else (network / 5xx / timeout): transient — leave the flag
  //     unset so the next accepted commit (or the final commit) retries; the
  //     turn already streamed to the user, so failing the run now would be
  //     incoherent.
  async function bindRunnerSessionIfNeeded(): Promise<void> {
    const convId = conversationId;
    const sdkSessionId = transcriptSessionId;
    if (
      runnerSessionIdSent ||
      convId === null ||
      runnerSessionId !== null ||
      sdkSessionId === null
    ) {
      return;
    }
    try {
      await client.call('conversation.store-runner-session', {
        conversationId: convId,
        runnerSessionId: sdkSessionId,
      });
      runnerSessionIdSent = true;
    } catch (err) {
      // 4xx (e.g. 409 conflict, 404 not-found) is a definitive host rejection —
      // not retryable; terminate rather than orphan. (commitNotifyWithResync
      // swallows its own IPC errors, so a 4xx in the surrounding commit try can
      // only originate from this bind.) 5xx was already retried by the client.
      if (
        err instanceof IpcRequestError &&
        err.status >= 400 &&
        err.status < 500
      ) {
        throw err;
      }
      process.stderr.write(
        `runner: conversation.store-runner-session failed (will retry on next commit): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

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
        // a type-level rather than a wire-level signal. `resumeSessionId` is
        // `runnerSessionId` unless the F2a guard above demoted it to null
        // (bound id with no resumable transcript → start fresh).
        ...(resumeSessionId !== null ? { resume: resumeSessionId } : {}),
        // ANTHROPIC_API_KEY is the `ax-cred:<hex>` placeholder (substituted
        // by the credential-proxy mid-flight); no ANTHROPIC_BASE_URL — SDK
        // calls api.anthropic.com directly through HTTPS_PROXY.
        //
        // The env literal here partitions into two distinct concerns that
        // happen to share the same SDK subprocess env namespace:
        //
        // (a) Phase C — HOME redirect for the SDK subprocess (jsonl
        //     persistence). See per-bullet rationale below.
        //
        // (b) Phase 0 skill discovery (I-P0-1 / I-P0-3) — CLAUDE_CONFIG_DIR
        //     forwarded from the sandbox-provided runner env so the SDK's
        //     `'user'` setting source resolves to a host-owned root
        //     (`<sandbox-HOME>/.ax/session`) that's SEPARATE from the
        //     workspace's `'project'` source (`<cwd>/.claude/skills`).
        //     Without the forward, the SDK falls back to `<HOME>/.claude`,
        //     which — because the (a) override below sets HOME=workspaceRoot
        //     — collapses onto the project-source path, making the two
        //     setting sources indistinguishable and rendering the host-
        //     installed-skills surface unreachable. The forward itself
        //     lives in proxy-startup.ts (ENV_ALLOWLIST) so the value
        //     arrives via `...proxyStartup.anthropicEnv` below.
        //
        // (a)/(b) interact via the SDK's per-session jsonl path. The
        // SDK derives `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/
        // <sid>.jsonl` from the same var that drives skill discovery,
        // so once (b) moved CLAUDE_CONFIG_DIR outside the workspace,
        // the SDK's turn-transcript writes went with it — and the
        // turn-end `git add -A` stopped capturing them. The fix lives
        // upstream of this env literal: scaffoldSdkProjectsSymlink (in
        // git-workspace.ts, called from the materialize block above)
        // creates `$CLAUDE_CONFIG_DIR/projects` as a symlink into
        // `<workspaceRoot>/.claude/projects`, so the writes land inside
        // `/permanent` and the bundler picks them up. The (b) split
        // and the jsonl capture are restored independently; no env
        // change here.
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
        //   - We DO NOT override CLAUDE_CONFIG_DIR here — the sandbox
        //     plugin's value (carried through proxyStartup.anthropicEnv)
        //     is the source of truth for the (b) split above. If a future
        //     refactor adds CLAUDE_CONFIG_DIR after the spread it would
        //     break I-P0-1.
        env: {
          ...proxyStartup.anthropicEnv,
          HOME: env.workspaceRoot,
          // Redirect npx/uvx fetch caches onto the ephemeral tier so they
          // don't land in HOME=/permanent and get bundled to the host each
          // turn. No-op ({}) when no ephemeral root was wired. See
          // tool-cache-env.ts. Spread AFTER HOME so an ephemeral root always
          // wins for the cache vars (HOME stays the workspace root).
          ...buildToolCacheEnv(env.ephemeralRoot),
          // Activate the session Python venv (PATH + VIRTUAL_ENV + pip CA
          // trust) so `pip install` reaches the venv and trusts the proxy
          // MITM CA. Gated on the scaffold actually succeeding (pythonVenvReady).
          // Spread AFTER anthropicEnv so PATH/VIRTUAL_ENV win. caCertFile is the
          // same proxy CA PEM the Node/uv tools already trust (SSL_CERT_FILE /
          // NODE_EXTRA_CA_CERTS, forwarded by proxy-startup). See python-venv.ts.
          ...buildPythonVenvEnv({
            ephemeralRoot: pythonVenvReady ? env.ephemeralRoot : undefined,
            currentPath: proxyStartup.anthropicEnv.PATH,
            caCertFile:
              proxyStartup.anthropicEnv.SSL_CERT_FILE ??
              proxyStartup.anthropicEnv.NODE_EXTRA_CA_CERTS,
          }),
        },
        cwd: env.workspaceRoot,
        // Session-scoped scratch tier. When the sandbox provided an
        // ephemeral root (k8s: the `/ephemeral` emptyDir mount; subprocess:
        // a per-session tempdir), grant the SDK's file tools access to it
        // BEYOND cwd. Without this the file tools are bounded to cwd
        // (`/permanent`), so any "temporary" file the agent writes lands in
        // the workspace tree and gets `git add -A`'d + bundled to the host
        // at turn end. additionalDirectories lets the agent stage throwaway
        // work (scratch clones, build caches) somewhere that never
        // round-trips. Omitted when the sandbox didn't wire one — no
        // phantom directory. (The matching system-prompt note that tells
        // the agent this directory exists is added via buildSystemPrompt
        // below; both are gated on the same env.ephemeralRoot.)
        ...(env.ephemeralRoot !== undefined
          ? { additionalDirectories: [env.ephemeralRoot] }
          : {}),
        // `Skill` is added to the allow list so the SDK auto-permits the
        // built-in Skill tool without prompting — that's the path the SDK
        // uses to invoke a skill it discovered under `settingSources`
        // (below). The SDK treats `allowedTools` as a set, not an ordered
        // list — position is irrelevant; we put Skill first for reader-
        // facing emphasis only. The remaining names are the per-agent
        // allow list the host wrote at session creation; an empty
        // `agentConfig.allowedTools` means "no per-agent restriction"
        // (orchestrator default) and the SDK falls back to its own
        // defaults for everything other than the explicit deny list in
        // `disallowedTools`.
        allowedTools: ['Skill', ...agentConfig.allowedTools],
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
        mcpServers: {
          [MCP_HOST_SERVER_NAME]: hostMcpServer,
          [MCP_SANDBOX_SERVER_NAME]: sandboxMcpServer,
        },
        // settingSources: 'user' is required for the SDK to discover skills
        // under $CLAUDE_CONFIG_DIR/skills/ (host-controlled installed skills);
        // 'project' is required for skills under <workspace>/.claude/skills/
        // (which is a symlink to .ax/skills/, the agent-authored convention).
        //
        // Agent cannot escalate SDK behavior via these sources because:
        //  - the SDK's other user/project files (.claude/settings.json,
        //    CLAUDE.md, .claude/agents/, .claude/commands/, .claude/rules/,
        //    CLAUDE.local.md, .claude/CLAUDE.md) are vetoed at the
        //    workspace:pre-apply boundary by @ax/validator-skill;
        //  - the workspace symlink points narrowly at `.ax/skills`, not at
        //    the parent `.claude/` directory;
        //  - $HOME is a per-session tempdir/emptyDir, isolated from the
        //    host user's ~/.claude (allocated by sandbox plugins in Tasks 4/5).
        //
        // I-P0-1 in docs/plans/2026-05-17-skill-install-phase-0-impl.md.
        settingSources: ['user', 'project'],
        // Week 9.5: use the frozen agentConfig.systemPrompt the host wrote
        // at session-creation time. An empty string falls back to the SDK
        // preset (the dev-agents-stub seeds a default; production agents
        // require non-empty by validation). systemPrompt is USER-AUTHORED
        // and intended for the LLM — not interpolated into shell, paths,
        // or HTML.
        //
        // buildSystemPrompt also appends the ephemeral-scratch note when
        // env.ephemeralRoot is set (paired with additionalDirectories
        // above). It handles the SDK quirk that `append` is a no-op on a
        // custom string prompt vs. the preset form.
        systemPrompt: buildSystemPrompt(
          agentConfig.systemPrompt,
          env.ephemeralRoot,
          pythonVenvReady,
        ),
      },
    });

    for await (const msg of queryIter) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        // Capture the SDK session_id so the per-turn flush wait can locate the
        // jsonl. The FIRST init wins — `query({ resume })` can re-emit
        // system/init within the same run, and a re-entrant init must not
        // change the captured id. On a resumed session `transcriptSessionId`
        // is already seeded to the resume id (and equals msg.session_id), so
        // the null-gate is a no-op there.
        //
        // The host bind (`conversation.store-runner-session`) is NOT done here
        // anymore — it's deferred to the first host-accepted turn-end commit
        // (bindRunnerSessionIfNeeded). Binding at init persisted the binding
        // before the transcript was durable on the host, so a turn killed in
        // that window left a stale `runner_session_id` that crashed the
        // retry's resume (F2a).
        if (transcriptSessionId === null) {
          transcriptSessionId = msg.session_id;
        }
        continue;
      }
      if (msg.type === 'assistant') {
        const assistant: SDKAssistantMessage = msg;
        // Record this assistant message's uuid as the turn's latest — the
        // per-turn commit waits for the LAST one's jsonl line before staging
        // (the SDK flushes the final assistant line after `result`). On a
        // tool-using turn this advances tool_use → … → closing-text so the
        // wait targets the closing text, not the intermediate tool_use line.
        turnLastAssistantUuid = assistant.uuid;
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
            const toolInput = (block.input ?? {}) as Record<string, unknown>;
            turnContentBlocks.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: toolInput,
            });
            // Per-block streaming for tool calls. Mirrors the text/thinking
            // path above so the host's chat:stream-chunk subscriber can
            // fan tool activity to live SSE clients (channel-web's Thread
            // renders these via ToolGroup + ToolFallback). Failure is
            // non-fatal: the canonical transcript still flows via
            // event.turn-end.
            if (currentReqId !== undefined) {
              await client
                .event('event.stream-chunk', {
                  reqId: currentReqId,
                  kind: 'tool-use',
                  toolCallId: block.id,
                  toolName: block.name,
                  input: toolInput,
                })
                .catch(() => {
                  /* host may be tearing down; non-fatal */
                });
            }
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
                // Per-block streaming for the result. Flatten array content
                // (text + image entries) to a string for the wire — the
                // canonical full-fidelity copy still ships via turn-end /
                // tool_result blocks. Failure non-fatal.
                if (currentReqId !== undefined) {
                  const flatOutput =
                    typeof normalizedContent === 'string'
                      ? normalizedContent
                      : normalizedContent
                          .filter(
                            (c): c is TextBlock => c.type === 'text',
                          )
                          .map((c) => c.text)
                          .join('\n');
                  await client
                    .event('event.stream-chunk', {
                      reqId: currentReqId,
                      kind: 'tool-result',
                      toolCallId: tr.tool_use_id,
                      output: flatOutput,
                      ...(typeof tr.is_error === 'boolean'
                        ? { isError: tr.is_error }
                        : {}),
                    })
                    .catch(() => {
                      /* host may be tearing down; non-fatal */
                    });
                }
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
          // Wait for the SDK's delayed FINAL-assistant-jsonl write to land so
          // this turn's closing reply is captured by the commit/bundle below
          // (see the flush comment after materialize). We wait for the SPECIFIC
          // uuid of the turn's last assistant message — NOT "any new line",
          // which a tool-using turn's intermediate tool_use line would satisfy
          // prematurely, dropping the closing text (TASK-11). Skip when the
          // turn produced no assistant message (nothing to wait for) or when we
          // have no session id to locate the jsonl. Bounded; falls through on
          // timeout (the final/idle commit is the safety net).
          commitTrace(
            `[commit-trace] per-turn result: session=${transcriptSessionId ?? 'null'} contentBlocks=${turnContentBlocks.length} toolResults=${turnToolResultBlocks.length} finalAsstUuid=${turnLastAssistantUuid ?? '-'} parent=${parentVersion ?? 'null'}\n`,
          );
          if (turnLastAssistantUuid !== undefined && transcriptSessionId !== null) {
            const landed = await waitForTranscriptUuid(
              env.workspaceRoot,
              transcriptSessionId,
              turnLastAssistantUuid,
              { timeoutMs: flushTimeoutMs, intervalMs: flushIntervalMs },
            );
            commitTrace(
              `[commit-trace] waitForTranscriptUuid target=${turnLastAssistantUuid} ${landed ? 'LANDED' : 'TIMEOUT (final line never flushed)'}\n`,
            );
          } else {
            commitTrace(
              `[commit-trace] waitForTranscriptUuid SKIPPED (finalAsstUuid=${turnLastAssistantUuid ?? '-'} session=${transcriptSessionId ?? 'null'})\n`,
            );
          }
          const bundleB64 = await commitTurnAndBundle({
            root: env.workspaceRoot,
            reason: 'turn',
          });
          commitTrace(
            `[commit-trace] per-turn commitTurnAndBundle → ${bundleB64 === null ? 'EMPTY (no staged diff; commit-notify SKIPPED)' : `${bundleB64.length}B`}\n`,
          );
          if (bundleB64 !== null) {
            // Bounded re-sync + retry. On a concurrent-writer advance the host
            // returns accepted:false with actualParent + baselineBundleBytes;
            // the shared helper rebases our turn commit onto the new head and
            // retries (up to MAX_RESYNC_ATTEMPTS). A true policy veto rolls
            // back; a network/5xx error keeps the tree intact for accumulation
            // next turn. Same helper drives the final/idle commit below.
            const result = await commitNotifyWithResync({
              client,
              root: env.workspaceRoot,
              bundleBytes: bundleB64,
              parentVersion,
              reason: 'turn',
            });
            parentVersion = result.parentVersion;
            commitTrace(
              `[commit-trace] per-turn DONE outcome=${result.outcome} parent=${parentVersion ?? 'null'}\n`,
            );
            // F2a: the transcript is now durable on the host — bind the
            // conversation row to it (once, fresh-boot only). See
            // bindRunnerSessionIfNeeded.
            if (result.outcome === 'accepted') {
              await bindRunnerSessionIfNeeded();
            }
          }
        } catch (err) {
          // A 4xx from bindRunnerSessionIfNeeded (e.g. conversation owned by
          // another session) is terminal — propagate it past this
          // commit-failure catch so the run ends `terminated` instead of
          // silently orphaning.
          if (
            err instanceof IpcRequestError &&
            err.status >= 400 &&
            err.status < 500
          ) {
            throw err;
          }
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
          // The SDK echoes tool_result blocks back as jsonl lines with
          // `type: 'user'`, so we look up the uuid of the LAST 'user'
          // line for this session. Best-effort: undefined-on-miss is
          // fine because subscribers gracefully skip without a turnId.
          const turnId =
            runnerSessionId !== null
              ? await readLastTurnUuid(env.workspaceRoot, runnerSessionId, 'user')
              : undefined;
          await client
            .event('event.turn-end', {
              reason: 'user-message-wait',
              role: 'tool',
              contentBlocks: toolBlocks,
              // Forward the inbox message's reqId so host-side per-request
              // subscribers (e.g., @ax/routines `pending.get(reqId)`) can
              // correlate this turn-end back to the originating request.
              // Without this the host fires `chat:turn-end` with the IPC
              // request's freshly-minted reqId, dead to those subscribers.
              ...(currentReqId !== undefined ? { reqId: currentReqId } : {}),
              ...(turnId !== undefined ? { turnId } : {}),
            })
            .catch(() => {
              /* host may be tearing down; non-fatal */
            });
        }

        const assistantBlocks = turnContentBlocks;
        turnContentBlocks = [];
        // Reset the turn's final-assistant-uuid tracker so the NEXT turn's
        // flush wait is gated on its own assistant message (an empty turn with
        // no assistant message then correctly skips the wait).
        turnLastAssistantUuid = undefined;
        // Look up the uuid of the LAST 'assistant' line so subscribers
        // (e.g., @ax/routines silence-token logic) can refer back to
        // this specific turn via conversations:drop-turn.
        const assistantTurnId =
          runnerSessionId !== null
            ? await readLastTurnUuid(
                env.workspaceRoot,
                runnerSessionId,
                'assistant',
              )
            : undefined;
        await client
          .event('event.turn-end', {
            reason: 'user-message-wait',
            role: 'assistant',
            ...(assistantBlocks.length > 0
              ? { contentBlocks: assistantBlocks }
              : {}),
            // See reqId rationale on the tool turn-end above.
            ...(currentReqId !== undefined ? { reqId: currentReqId } : {}),
            ...(assistantTurnId !== undefined ? { turnId: assistantTurnId } : {}),
          })
          .catch(() => {
            /* host may be tearing down; non-fatal */
          });
      }
      // system / partial / progress / etc. are SDK bookkeeping —
      // the host doesn't need to see them. (`user` messages ARE handled
      // above, but only to extract tool_result blocks for replay.)
    }
    // Final commit: the SDK subprocess writes the assistant response to
    // the jsonl AFTER yielding `result` to Node.js. The per-turn commit in
    // the `result` handler fires before those writes land, so the assistant
    // response is always missing from the committed state. Committing here
    // — after the for-await fully drains — captures the SDK's delayed
    // writes. If nothing changed vs. the last per-turn commit (e.g. the
    // SDK flushed everything before `result`), `git add -A` produces an
    // empty diff and no commit is created (commitTurnAndBundle short-
    // circuits on empty diffs).
    commitTrace(
      `[commit-trace] for-await drained → final commit (parent=${parentVersion ?? 'null'})\n`,
    );
    try {
      const finalBundle = await commitTurnAndBundle({
        root: env.workspaceRoot,
        reason: 'turn',
      });
      commitTrace(
        `[commit-trace] final commitTurnAndBundle → ${finalBundle === null ? 'EMPTY (no staged diff; commit-notify SKIPPED)' : `${finalBundle.length}B`}\n`,
      );
      if (finalBundle !== null) {
        // Run the SAME bounded re-sync+retry helper as the per-turn commit. A
        // concurrent writer racing this final/idle commit advances the mirror;
        // without the re-sync the final turn's tail (the SDK's delayed
        // post-`result` jsonl writes) was silently dropped — it only logged.
        const result = await commitNotifyWithResync({
          client,
          root: env.workspaceRoot,
          bundleBytes: finalBundle,
          parentVersion,
          reason: 'turn',
        });
        parentVersion = result.parentVersion;
        commitTrace(
          `[commit-trace] final DONE outcome=${result.outcome} parent=${parentVersion ?? 'null'}\n`,
        );
        // F2a: last chance to bind once the final commit is durable (e.g. when
        // the per-turn commit-notify was 'kept'/'rolled-back' but this one was
        // accepted). Once-only via bindRunnerSessionIfNeeded.
        if (result.outcome === 'accepted') {
          await bindRunnerSessionIfNeeded();
        }
      }
    } catch (err) {
      // Propagate a terminal bind rejection (4xx) past this best-effort catch
      // so the run ends `terminated` rather than orphaning (see per-turn site).
      if (
        err instanceof IpcRequestError &&
        err.status >= 400 &&
        err.status < 500
      ) {
        throw err;
      }
      process.stderr.write(`runner: final commitTurnAndBundle failed: ${err instanceof Error ? err.message : String(err)}\n`);
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
