#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  query,
  type SDKAssistantMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { parseModelRef } from '@ax/core';
import type {
  ContentBlock,
  ImageBlock,
  TextBlock,
} from '@ax/ipc-protocol';
import { createCanUseTool } from './can-use-tool.js';
import { createHostMcpServer } from './host-mcp-server.js';
import {
  buildToolCacheEnv,
  buildHomeBinEnv,
  buildTtyHintEnv,
  commitTrace,
  buildPythonVenvEnv,
  runRunner,
  scaffoldSdkProjectsSymlink,
  type Loop,
  type LoopContext,
  type RunnerDeps,
} from '@ax/agent-runner-core';
import { buildTelemetryEnv } from './telemetry-env.js';
import { createPostToolUseHook } from './post-tool-use.js';
import { createPreToolUseHook } from './pre-tool-use.js';
import { createSandboxMcpServer } from './sandbox-mcp-server.js';
import { DISABLED_BUILTINS, MCP_HOST_SERVER_NAME, MCP_SANDBOX_SERVER_NAME } from './tool-names.js';
import {
  hasResumableTranscript,
  readLastTurnUuid,
  waitForTranscriptUuid,
} from './turn-end-uuid.js';
import { createJsonlTranscriptSource } from './jsonl-transcript-source.js';

// ---------------------------------------------------------------------------
// Runner entry binary (claude-sdk variant).
//
// Everything that is NOT the agent loop — env read, IPC client, workspace
// materialize, uploads, skills projection, inbox wiring, turn-end commit and
// flush, `event.chat-end`, and the 0/1/2 exit-code contract — lives in
// `runRunner` (@ax/agent-runner-core). This file is the Claude Agent SDK
// loop it drives: the `query()` options literal, the `for await` message
// pump, the two MCP servers, the PreToolUse/PostToolUse hook adapters, and
// the SDK-specific transcript reads (`turn-end-uuid.ts`,
// `jsonl-transcript-source.ts`).
//
// Shape: one persistent `query()` driven by an async generator that pulls
// user messages from the shell's inbox. That keeps a single SDK session
// alive for the life of the runner instead of spawning a fresh one per
// chat turn — the SDK's internal conversation history carries across
// turns automatically.
//
// The runner holds NO LLM credentials (invariant I5). The vendored
// @anthropic-ai/claude-agent-sdk calls api.anthropic.com through the
// host-side credential-proxy (see proxy-startup.ts); the SDK's outbound
// x-api-key carries an `ax-cred:<hex>` placeholder that the proxy
// substitutes for the real Anthropic key mid-flight. If the sandbox is
// compromised, the real key never entered this process.
//
// Exit codes (the spawning host branches on these) are owned by runRunner:
//   0 — chat completed normally (inbox returned cancel; SDK drained).
//   1 — terminated abnormally (SDK threw, IPC errored after retries, etc.).
//   2 — fatal during bootstrap (missing env, initial tool.list failure).
// ---------------------------------------------------------------------------

/**
 * The credential-proxy registry's placeholder shape
 * (`packages/credential-proxy/src/registry.ts`). Deliberately duplicated from
 * `proxy-startup.ts` rather than exported across the package boundary: the
 * point of a defense-in-depth check is that it is an INDEPENDENT check. If the
 * format ever changes, both copies fail loudly instead of one silently
 * inheriting the other's mistake.
 */
const PLACEHOLDER_RE = /^ax-cred:[0-9a-f]{32}$/;

export {
  createArtifactPublishExecutor,
  createSkillProposeExecutor,
} from '@ax/agent-runner-core';
export type {
  ArtifactPublishOutput,
  CreateArtifactPublishExecutorOptions,
} from '@ax/agent-runner-core';

export function createClaudeSdkLoop(deps: RunnerDeps): Loop {
  const {
    client,
    env,
    agentConfig,
    tools,
    localDispatcher,
    flushWorkspaceForHostTool,
    proxyStartup,
    pythonVenvReady,
    // The shell calls it `homeDir`; inside this loop it IS the SDK subprocess's
    // HOME + cwd, which is what every comment below calls it.
    homeDir: sdkHome,
    systemPrompt,
    resumeSessionId,
  } = deps;

  return {
    async run(ctx: LoopContext): Promise<number> {
      // Per-turn transcript-flush wait (2026-05-22 conversations:get-latency fix).
      // The Anthropic Agent SDK writes the assistant turn's jsonl line AFTER it
      // yields `result`, so the per-turn commit the shell runs at the turn
      // boundary would otherwise stage `/agent` BEFORE the reply lands and ship a
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

      const hostMcpServer = createHostMcpServer({
        client,
        tools,
        flushWorkspace: flushWorkspaceForHostTool,
      });

      const sandboxMcpServer = createSandboxMcpServer({
        dispatcher: localDispatcher,
        tools,
      });

      // Per-turn content-block accumulators. Drained at the SDK `result`
      // boundary into the shell's endTurn so @ax/conversations can persist the
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

      // Inbox → SDK user-message generator. Closing via `return` on cancel
      // tells the SDK no more user messages are coming, which lets the outer
      // `for await (msg of queryIter)` drain naturally and exit. The shell owns
      // the pull (inbox long-poll, reqId capture, upload re-materialization,
      // attachment translation); we only wrap what it hands back in the SDK's
      // message shape.
      //
      // Phase E (2026-05-09): no more replay-from-DB. The SDK's
      // `resume(sessionId)` rehydrates the transcript from its own on-disk
      // store (~/.claude/projects/<sessionId>.jsonl, HOME-redirected into
      // the workspace by Phase C) when `resumeSessionId !== null`. The
      // generator only yields live inbox messages; prior turns are the
      // SDK's responsibility to surface to the model.
      async function* userMessages(): AsyncGenerator<SDKUserMessage> {
        for (;;) {
          const next = await ctx.nextMessage();
          if (next === null) return;
          yield {
            type: 'user',
            parent_tool_use_id: null,
            // Cast: SDKUserMessage.message.content is typed `string` today, but
            // the SDK accepts content-block arrays at runtime (the SDK's outbound
            // schema permits both shapes; the type just hasn't been widened yet).
            // Phase 3 may upstream a proper type widening to the SDK pin.
            message: { role: 'user', content: next.content } as never,
          };
        }
      }

      // Python venv PATH layer, computed up front so the $HOME/bin layer below can
      // read the venv-adjusted PATH and append AFTER it (the env literal can't
      // reference its own earlier keys). buildPythonVenvEnv returns {} when the
      // venv isn't ready, in which case the base proxy-allowlist PATH is the input
      // to buildHomeBinEnv. See python-venv.ts / home-bin-env.ts.
      const pythonVenvEnv = buildPythonVenvEnv({
        ephemeralRoot: pythonVenvReady ? env.ephemeralRoot : undefined,
        currentPath: proxyStartup.providerEnv.PATH,
        caCertFile:
          proxyStartup.providerEnv.SSL_CERT_FILE ??
          proxyStartup.providerEnv.NODE_EXTRA_CA_CERTS,
      });

      // Provider-agnostic model refs (PR 2): `agentConfig.model` is a
      // `provider/model-id` ref (e.g. `anthropic/claude-sonnet-4-6`), not a
      // raw Anthropic model id. Parse it BEFORE constructing query() so a
      // malformed or non-Anthropic ref fails the turn loudly instead of
      // reaching the SDK. This runner drives the Claude Agent SDK, which
      // only ever talks to api.anthropic.com — there is no way for it to
      // honor a non-Anthropic provider, so silently dropping the prefix
      // (or ignoring the provider) would run the WRONG model under a
      // config that explicitly named a different one. See
      // docs/plans/2026-08-18-provider-agnostic-runner-design.md §6.
      const { provider: modelProvider, modelId } = parseModelRef(
        agentConfig.model,
      );
      if (modelProvider !== 'anthropic') {
        throw new Error(
          `agent-claude-sdk-runner: agentConfig.model "${agentConfig.model}" ` +
            `targets provider "${modelProvider}", but this runner drives the ` +
            `Anthropic Claude Agent SDK only. Select a runner that supports ` +
            `"${modelProvider}", or set the agent's model to an ` +
            `"anthropic/<model-id>" ref.`,
        );
      }

      // ...and because this runner is Anthropic-only, the Anthropic
      // credential placeholder is genuinely ITS requirement. It used to be
      // asserted in @ax/agent-runner-core's setupProxy(), but that runs
      // before `session.get-config` — core cannot know the agent's provider
      // at that point, and an unconditional ANTHROPIC_API_KEY requirement
      // killed every non-Anthropic session at boot. Here `agentConfig` is in
      // scope and the provider is pinned to `anthropic` one line up, so the
      // assert is exactly as strict as before without constraining any other
      // runner.
      //
      // I1: read the placeholder from the proxy-startup env map (the value
      // this process will actually hand the SDK), never from process.env —
      // asserting one value and forwarding another is how a real key sneaks
      // through. The shape is the `ax-cred:<32-hex>` the credential-proxy
      // registry mints; a non-empty check would let a regressed wiring
      // forward a real `sk-ant-...` key upstream silently.
      const apiKeyPlaceholder = proxyStartup.providerEnv.ANTHROPIC_API_KEY;
      if (
        typeof apiKeyPlaceholder !== 'string' ||
        !PLACEHOLDER_RE.test(apiKeyPlaceholder)
      ) {
        throw new Error(
          `agent-claude-sdk-runner: ANTHROPIC_API_KEY must be the ` +
            `ax-cred:<32-hex> placeholder minted by proxy:open-session ` +
            `(got ${
              apiKeyPlaceholder === undefined || apiKeyPlaceholder.length === 0
                ? 'nothing'
                : 'a value of another shape'
            }). A real provider key reaching the sandbox is a capability ` +
            `leak, not a convenience — the credential proxy substitutes the ` +
            `real value mid-flight and this process must never hold it.`,
        );
      }

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
          // the host's bound id unless the shell's F2a guard demoted it to null
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
          //     arrives via `...proxyStartup.providerEnv` below.
          //
          // (a)/(b) interact via the SDK's per-session jsonl path. The
          // SDK derives `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/
          // <sid>.jsonl` from the same var that drives skill discovery,
          // so once (b) moved CLAUDE_CONFIG_DIR outside the workspace,
          // the SDK's turn-transcript writes went with it — and the
          // turn-end `git add -A` stopped capturing them. The fix lives
          // upstream of this env literal: scaffoldSdkProjectsSymlink (in
          // git-workspace.ts, called from the shell's materialize block)
          // creates `$CLAUDE_CONFIG_DIR/projects` as a symlink into
          // `<workspaceRoot>/.claude/projects`, so the writes land inside
          // `/agent` and the bundler picks them up. The (b) split
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
          //   - HOME is spread AFTER ...proxyStartup.providerEnv so this
          //     value wins on conflict. providerEnv currently doesn't set
          //     HOME, but defensive ordering matches the intent: we
          //     explicitly redirect HOME for the SDK subprocess.
          //   - filestore-user-files Phase 2 (TASK-164): HOME is `sdkHome` — the
          //     durable `/workspace` NFS mount when AX_USERFILES_ROOT is wired,
          //     else `/agent` (today). So `~/bin`, dotfiles, and tool caches go to
          //     durable NFS rather than the git-bundled tier. Skill discovery is
          //     unaffected (CLAUDE_CONFIG_DIR, forwarded separately, drives it —
          //     not HOME), and the SDK's per-session jsonl still lands on /agent
          //     because the `$CLAUDE_CONFIG_DIR/projects` symlink targets
          //     `<workspaceRoot>/.claude/projects` regardless of cwd (only the
          //     `<encoded-cwd>` subdir name changes; the conversations readdir-walk
          //     is slug-agnostic). The SDK aux files (`.claude.json`, backups) now
          //     land on /workspace instead — acceptable (never validated/bundled).
          //   - We DO NOT override CLAUDE_CONFIG_DIR here — the sandbox
          //     plugin's value (carried through proxyStartup.providerEnv)
          //     is the source of truth for the (b) split above. If a future
          //     refactor adds CLAUDE_CONFIG_DIR after the spread it would
          //     break I-P0-1.
          env: {
            // TASK-26: terminal-hint env for the Bash tool's detached,
            // no-controlling-TTY child shell. TTY-detecting CLIs (cliffy/Deno
            // e.g. @schpet/linear-cli, ink, chalk, CI-aware tools) emit ZERO
            // stdout — even plain `--help` — when they detect they're not on a
            // terminal; these inert hint strings flip the common detectors so
            // they emit output. Spread FIRST so they're a default FLOOR: a
            // genuinely-forwarded TERM/COLUMNS/LINES from the host (carried in
            // proxyStartup.providerEnv, if the host ever has a real TTY) wins
            // via the later last-write spread. NOT a pseudo-TTY (capability
            // minimization, I5 — see tty-hint-env.ts / SECURITY.md).
            ...buildTtyHintEnv(),
            ...proxyStartup.providerEnv,
            // TASK-55: kill the SDK CLI's telemetry / error-reporting phone-home
            // (notably the datadoghq.com egress that otherwise raised a phantom
            // reactive-wall card every JIT session). Spread AFTER providerEnv so
            // these are a non-negotiable security FLOOR that wins on any conflict
            // — unlike the tty-hints above, which are overridable defaults. See
            // telemetry-env.ts for the verified gate chain and ordering contract.
            ...buildTelemetryEnv(),
            HOME: sdkHome,
            // Redirect npx/uvx fetch caches onto the ephemeral tier so they
            // don't land in HOME and get bundled/persisted. No-op ({}) when no
            // ephemeral root was wired. See tool-cache-env.ts. Spread AFTER HOME
            // so an ephemeral root always wins for the cache vars (HOME stays the
            // working frame).
            ...buildToolCacheEnv(env.ephemeralRoot),
            // Activate the session Python venv (PATH + VIRTUAL_ENV + pip CA
            // trust) so `pip install` reaches the venv and trusts the proxy
            // MITM CA. Gated on the scaffold actually succeeding (pythonVenvReady).
            // Spread AFTER providerEnv so PATH/VIRTUAL_ENV win. caCertFile is the
            // same proxy CA PEM the Node/uv tools already trust (SSL_CERT_FILE /
            // NODE_EXTRA_CA_CERTS, forwarded by proxy-startup). See python-venv.ts.
            // Computed up front (above the query() literal) so the $HOME/bin
            // layer below can append after the venv bin.
            ...pythonVenvEnv,
            // Put `$HOME/bin` (= <sdkHome>/bin) on PATH so binaries the agent
            // installs there PERSIST and are found in later sessions. filestore-
            // user-files Phase 2 (TASK-164): derives from `sdkHome` (= HOME), so
            // when AX_USERFILES_ROOT is wired `~/bin` is `/workspace/bin` on
            // durable NFS — persisted LIVE, NOT via the per-turn git bundle (the
            // bundle only stages /agent). Spread LAST and fed the post-venv PATH so
            // it lands at the END of PATH. APPEND, not prepend (I5 / codex review):
            // $HOME/bin is model-writable + restored across sessions, so prepending
            // would let an injected `$HOME/bin/git` persistently shadow the trusted
            // image/venv binary; appending keeps installed tools discoverable while
            // trusted base+venv bins win on name collisions. This is the load-
            // bearing layer: the SDK's Bash tool is a NON-INTERACTIVE shell that
            // never sources a .bashrc, so PATH must arrive via this env. See
            // home-bin-env.ts (and the matching .bashrc in container/agent/
            // Dockerfile, which uses `$HOME/bin` literally — it follows HOME
            // wherever it points, so no Dockerfile change is needed here).
            ...buildHomeBinEnv(
              sdkHome,
              pythonVenvEnv.PATH ?? proxyStartup.providerEnv.PATH,
            ),
          },
          // filestore-user-files Phase 2 (TASK-164): cwd is the agent's working
          // frame — `sdkHome` (= /workspace when a durable mount is wired, else
          // /agent). Relative-path file work, builds, and `git clone .` default to
          // durable NFS. The governed tier stays /agent; the PreToolUse re-rooter
          // pulls `.ax/**`+`.claude/**` back there (see the hook below, §14).
          cwd: sdkHome,
          // Directories the SDK's file tools may reach BEYOND `cwd` (cwd is always
          // granted implicitly). The SDK bounds file tools to cwd + this list, so
          // any tier the agent legitimately needs and that isn't the cwd must be
          // listed here — else writes there fail.
          //
          // The set, deduped (cwd is excluded; the SDK already grants it):
          //   - The governed tier `env.workspaceRoot` (=/agent). In Phase 2 cwd is
          //     /workspace, so /agent is NO LONGER the cwd and MUST be listed — it
          //     holds `.ax/uploads` (materialized attachments), the transcript
          //     `.claude/projects` symlink target, and every `.ax/**`+`.claude/**`
          //     path the PreToolUse re-rooter rewrites BACK to /agent (§14). Without
          //     it those re-rooted writes would be denied. (When userFilesRoot is
          //     unset, /agent IS the cwd, so it drops out via the dedup.)
          //   - The session-scoped scratch tier `env.ephemeralRoot` (k8s: the
          //     `/ephemeral` emptyDir; subprocess: a per-session tempdir) — for
          //     throwaway work (scratch clones, build caches) that must NOT
          //     round-trip to the host. Omitted when no scratch tier was wired.
          //   - The durable per-agent user-files mount `env.userFilesRoot`
          //     (`/workspace`) — in Phase 2 this is the cwd, so it dedups out; we
          //     still list it defensively for the (transitional) case where it's
          //     wired but not the cwd. Omitted when no durable mount was wired.
          //
          // Each entry is host-controlled env (never model/user input); omitted
          // entries grant no phantom directory. The matching system-prompt notes
          // (the shell's composed prompt) are gated on the same env values.
          ...((): { additionalDirectories?: string[] } => {
            const extra: string[] = [];
            for (const dir of [
              env.workspaceRoot,
              env.ephemeralRoot,
              env.userFilesRoot,
            ]) {
              if (dir !== undefined && dir !== sdkHome && !extra.includes(dir)) {
                extra.push(dir);
              }
            }
            return extra.length > 0 ? { additionalDirectories: extra } : {};
          })(),
          // The SDK's `model` option wants the RAW Anthropic model id
          // (`claude-sonnet-4-6`), not the `provider/model-id` ref
          // (`anthropic/claude-sonnet-4-6`) stored on AgentConfig — the
          // `anthropic/` prefix is host/admin-picker vocabulary for
          // provider routing, meaningless to the SDK itself. `modelId` is
          // the parsed, provider-stripped value computed above (and the
          // provider !== 'anthropic' case already threw before reaching
          // here). See docs/plans/2026-08-18-provider-agnostic-runner-design.md §6.
          model: modelId,
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
            PreToolUse: [
              {
                hooks: [
                  createPreToolUseHook({
                    client,
                    // The re-root TARGET is always the governed tier
                    // (env.workspaceRoot, /agent) — NOT cwd. TASK-78: uploads
                    // materialize at `<workspaceRoot>/.ax/uploads/`, so a
                    // mis-rooted `.ax/uploads/...` reference re-roots THERE.
                    workspaceRoot: env.workspaceRoot,
                    // filestore-user-files Phase 2 (TASK-164) §14 LINCHPIN:
                    // broaden the re-rooter from the `.ax/uploads/` safety-net to
                    // the FULL `.ax/**`+`.claude/**` validator policy iff cwd/HOME
                    // moved to the ungoverned NFS mount (AX_USERFILES_ROOT set).
                    // Forces every governed self-edit back onto /agent so it stays
                    // validated + git-backed; when unset, no NFS to drift onto, so
                    // the legacy uploads-only scope is preserved (today's behavior).
                    broaden: env.userFilesRoot !== undefined,
                    // The roots a TOP-LEVEL governed path may be rooted against —
                    // the cwd (=sdkHome, the NFS mount) and the scratch tier. Bounds
                    // the broadened re-root to top-level governed dirs so a NESTED
                    // `.claude/` under a user subtree (e.g. a cloned repo) is left on
                    // the user tier, matching the validator's git-root-relative scope.
                    // (workspaceRoot is always added by the re-rooter; /home/+~/ are
                    // always recognized.) Filtered to the defined runtime roots.
                    recognizedRoots: [sdkHome, env.ephemeralRoot].filter(
                      (r): r is string => r !== undefined,
                    ),
                  }),
                ],
              },
            ],
            PostToolUse: [
              {
                hooks: [
                  createPostToolUseHook({
                    client,
                    // Only preToolUse (re-rooting) reads workspaceRoot today, but
                    // CreatePostToolUseHookOptions is now the shared
                    // CreateToolPolicyOptions type, so it's a required field here
                    // too — pass the same governed root as the PreToolUse hook
                    // above for consistency even though postToolUse ignores it.
                    workspaceRoot: env.workspaceRoot,
                    // Agent-visible egress-block note: after a Bash tool, drain the
                    // hosts this session was allowlist-blocked on and inject a
                    // remediation note. The host returns `{ hosts: [] }` when no
                    // egress proxy is loaded, so this degrades to no-note silently.
                    drainEgressBlocks: async () => {
                      const r = (await client.call('proxy.drain-egress-blocks', {})) as {
                        hosts: string[];
                      };
                      return r.hosts;
                    },
                  }),
                ],
              },
            ],
          },
          mcpServers: {
            [MCP_HOST_SERVER_NAME]: hostMcpServer,
            [MCP_SANDBOX_SERVER_NAME]: sandboxMcpServer,
          },
          // Phase 3: the read-only `user` projection ($CLAUDE_CONFIG_DIR/skills/,
          // chmod 0555, written by @ax/installed-skills) is the SOLE skill-
          // discovery path. 'project' was dropped because .claude/skills/ inside
          // the workspace is agent-writable and is NOT on @ax/validator-skill's
          // veto list (it's pass-through). Keeping 'project' would let the agent
          // write .claude/skills/evil/SKILL.md and have it discovered directly,
          // bypassing the host projection and the quarantine scan entirely.
          //
          // $HOME is a per-session tempdir/emptyDir, isolated from the host
          // user's ~/.claude (allocated by sandbox plugins in Tasks 4/5).
          //
          // I-P0-1 in docs/plans/2026-05-17-skill-install-phase-0-impl.md.
          settingSources: ['user'],
          // The file-based prompt-engine composed this at spawn for this session
          // (the shell's `buildSystemPrompt` call). It also folds in the
          // ephemeral-scratch / python-venv operational notes (paired with
          // additionalDirectories above) and handles the SDK quirk that `append`
          // is a no-op on a custom string prompt vs. the preset form.
          systemPrompt,
        },
      });

      for await (const msg of queryIter) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          // Capture the SDK session_id so the per-turn flush wait can locate the
          // jsonl. The FIRST init wins — `query({ resume })` can re-emit
          // system/init within the same run, and a re-entrant init must not
          // change the captured id. On a resumed session the shell already
          // seeded the id to the resume value (and it equals msg.session_id), so
          // the null-gate is a no-op there.
          //
          // The host bind (`conversation.store-runner-session`) is NOT done here
          // anymore — the shell defers it to the first host-accepted turn-end
          // commit. Binding at init persisted the binding before the transcript
          // was durable on the host, so a turn killed in that window left a
          // stale `runner_session_id` that crashed the retry's resume (F2a).
          if (ctx.getTranscriptSessionId() === null) {
            ctx.setTranscriptSessionId(msg.session_id);
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
            ctx.recordAssistantText(text);
          }
          // Accumulate full ContentBlock[] for the per-turn transcript that
          // ships to @ax/conversations via the shell's endTurn. Every block kind
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
              // blocks as the model produces them; we forward each to the
              // shell, which stamps the reqId and emits
              // `event.stream-chunk`. Empty-text blocks are skipped —
              // emitting `{ text: '' }` chunks is noise.
              if (block.text.length > 0) {
                await ctx.emitChunk({ kind: 'text', text: block.text });
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
              if (block.thinking.length > 0) {
                await ctx.emitChunk({ kind: 'thinking', text: block.thinking });
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
              // renders these via ToolGroup + ToolFallback).
              await ctx.emitChunk({
                kind: 'tool-use',
                toolCallId: block.id,
                toolName: block.name,
                input: toolInput,
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
                  // Per-block streaming for the result. Flatten array content
                  // (text + image entries) to a string for the wire — the
                  // canonical full-fidelity copy still ships via turn-end /
                  // tool_result blocks.
                  const flatOutput =
                    typeof normalizedContent === 'string'
                      ? normalizedContent
                      : normalizedContent
                          .filter(
                            (c): c is TextBlock => c.type === 'text',
                          )
                          .map((c) => c.text)
                          .join('\n');
                  await ctx.emitChunk({
                    kind: 'tool-result',
                    toolCallId: tr.tool_use_id,
                    output: flatOutput,
                    ...(typeof tr.is_error === 'boolean'
                      ? { isError: tr.is_error }
                      : {}),
                  });
                }
              }
            }
          }
        } else if (msg.type === 'result') {
          // Turn boundary. The shell owns the transcript ship, the commit +
          // bundle, and the turn-end events; we hand it this turn's
          // accumulators and the two SDK-specific transcript reads.
          const contentBlocks = turnContentBlocks;
          const toolResultBlocks = turnToolResultBlocks;
          turnContentBlocks = [];
          turnToolResultBlocks = [];
          const lastAssistantUuid = turnLastAssistantUuid;
          await ctx.endTurn({
            contentBlocks,
            toolResultBlocks,
            ...(lastAssistantUuid !== undefined ? { lastAssistantUuid } : {}),
            beforeCommit: async () => {
              // Wait for the SDK's delayed FINAL-assistant-jsonl write to land so
              // this turn's closing reply is captured by the shell's commit/bundle
              // (see the flush comment at the top of run()). We wait for the
              // SPECIFIC uuid of the turn's last assistant message — NOT "any new
              // line", which a tool-using turn's intermediate tool_use line would
              // satisfy prematurely, dropping the closing text (TASK-11). Skip when
              // the turn produced no assistant message (nothing to wait for) or
              // when we have no session id to locate the jsonl. Bounded; falls
              // through on timeout (the final/idle commit is the safety net).
              const sessionId = ctx.getTranscriptSessionId();
              if (lastAssistantUuid !== undefined && sessionId !== null) {
                const landed = await waitForTranscriptUuid(
                  env.workspaceRoot,
                  sessionId,
                  lastAssistantUuid,
                  { timeoutMs: flushTimeoutMs, intervalMs: flushIntervalMs },
                );
                commitTrace(
                  `[commit-trace] waitForTranscriptUuid target=${lastAssistantUuid} ${landed ? 'LANDED' : 'TIMEOUT (final line never flushed)'}\n`,
                );
              } else {
                commitTrace(
                  `[commit-trace] waitForTranscriptUuid SKIPPED (finalAsstUuid=${lastAssistantUuid ?? '-'} session=${sessionId ?? 'null'})\n`,
                );
              }
            },
            readTurnId: (sessionId, role) =>
              // The shell asks in DISPLAY roles. The SDK echoes tool results
              // back into the transcript as `user` lines, so 'tool' resolves
              // to 'user' here — that mapping is SDK-private and belongs in
              // this adapter rather than in the shell's vocabulary.
              readLastTurnUuid(
                env.workspaceRoot,
                sessionId,
                role === 'tool' ? 'user' : role,
              ),
          });
          // Reset the turn's final-assistant-uuid tracker so the NEXT turn's
          // flush wait is gated on its own assistant message (an empty turn with
          // no assistant message then correctly skips the wait).
          turnLastAssistantUuid = undefined;
        }
        // system / partial / progress / etc. are SDK bookkeeping —
        // the host doesn't need to see them. (`user` messages ARE handled
        // above, but only to extract tool_result blocks for replay.)
      }

      return 0;
    },
  };
}

export async function main(): Promise<number> {
  return runRunner((deps) => createClaudeSdkLoop(deps), {
    // TASK-67 split: the delta/prefixHash/resync protocol lives in
    // @ax/agent-runner-core; locating the SDK's jsonl (its private cwd-slug
    // encoding) is SDK-specific and hides behind this source.
    createTranscriptSource: (env) => createJsonlTranscriptSource(env.workspaceRoot),
    // F2a guard, non-conversation branch: the legacy on-disk scan of the
    // materialized workspace's jsonl.
    hasLocalTranscript: (env, sessionId) =>
      hasResumableTranscript(env.workspaceRoot, sessionId),
    afterMaterialize: async (env) => {
      // Redirect the SDK's turn-transcript jsonl writes into the workspace.
      // Phase 0 set CLAUDE_CONFIG_DIR OUTSIDE /agent so the `'user'`
      // skill-discovery source could be distinct from the `'project'` source,
      // but the SDK ALSO derives `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/
      // <sid>.jsonl` from the same var — the transcript writes moved with it.
      // A filesystem-level redirect (a symlink at `$CLAUDE_CONFIG_DIR/projects`
      // pointing into `<workspaceRoot>/.claude/projects`) lands those writes
      // inside the workspace.
      //
      // This symlink stays LOAD-BEARING after TASK-67/70 — but NOT for git:
      // `.claude/projects/` is gitignored (the shell's .gitignore scaffold runs
      // just before this), so the jsonl never rides a commit/bundle anymore.
      // Its purpose now is PATH LOCALITY for the out-of-git transcript
      // pipeline: the per-turn delta-ship + uuid-wait readers
      // (jsonl-transcript-source.ts `locateJsonl`, turn-end-uuid.ts)
      // readdir-walk `<workspaceRoot>/.claude/projects`, and resume
      // (`restoreTranscriptForResume`) WRITES the rebuilt jsonl there for the
      // SDK to read back via this same symlink. Remove it and both the
      // delta-ship and resume go blind. See scaffoldSdkProjectsSymlink's doc
      // and the (a)/(b) comment block around the query() env literal above.
      //
      // Guard: CLAUDE_CONFIG_DIR is sandbox-injected. If a future sandbox
      // provider doesn't set it, fall through to the pre-Phase-0 behavior
      // (the HOME redirect sends the SDK's jsonls to `<HOME>/.claude/
      // projects/...` which IS inside workspaceRoot already).
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
      if (claudeConfigDir) {
        await scaffoldSdkProjectsSymlink(env.workspaceRoot, claudeConfigDir);
      }
    },
    // Phase 2: feature-detect whether the pinned claude-agent-sdk supports
    // `document` content blocks. The SDK exposes its accepted block types via
    // a type-only export, so we probe by environment variable for now. Pinning
    // the SDK version makes this a static answer in practice; we keep the
    // override so a future SDK bump doesn't silently regress. Conservative
    // default: false. Override via env for early access.
    supportsDocumentBlocks: process.env.AX_SDK_DOCUMENT_BLOCKS === '1',
  });
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
