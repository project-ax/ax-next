import { promises as fsp } from 'node:fs';
import {
  createIpcClient,
  IpcRequestError,
  type AgentMessage,
  type ContentBlock,
  type IpcClient,
  type SessionGetConfigResponse,
  type ToolListResponse,
  type WorkspaceReadRequest,
  type WorkspaceReadResponse,
} from '@ax/ipc-protocol';
import { ARTIFACT_PUBLISH_TOOL_NAME } from '@ax/tool-artifact-publish';
import { SKILL_PROPOSE_TOOL_NAME } from '@ax/tool-skill-propose';
import { createArtifactPublishExecutor } from './artifact-publish-executor.js';
import {
  translateContentBlocks,
  type WorkspaceReader,
} from './attachment-translation.js';
import {
  commitNotifyWithResync,
  flushWorkspaceToHost,
  type FlushOutcome,
} from './commit-notify-resync.js';
import { commitTrace } from './commit-trace.js';
import { readRunnerEnv, type RunnerEnv } from './env.js';
import {
  commitTurnAndBundle,
  materializeWorkspace,
  scaffoldWorkspaceGitignore,
} from './git-workspace.js';
import { createInboxLoop } from './inbox-loop.js';
import { materializeInstalledSkillsFromEnv } from './installed-skills.js';
import { createLocalDispatcher, type LocalDispatcher } from './local-dispatcher.js';
import {
  materializeUploads,
  resolveMaterializedPath,
  uploadsBaseDir,
} from './materialize-uploads.js';
import { buildSystemPrompt } from './prompt-engine.js';
import { writeProxyCaFromEnv } from './proxy-ca-from-env.js';
import { setupProxy, type ProxyStartup } from './proxy-startup.js';
import { scaffoldPythonVenv } from './python-venv.js';
import { createSkillProposeExecutor } from './skill-propose-executor.js';
import {
  restoreTranscriptForResume,
  shipTranscriptDelta,
  type TranscriptShipState,
  type TranscriptSource,
} from './transcript-delta.js';

// ---------------------------------------------------------------------------
// The runner shell — everything a runner binary does that is NOT the agent
// loop.
//
// A runner process is spawned as a child by a `sandbox:open-session` impl
// inside an isolated sandbox. It communicates back to the host over the URI
// in AX_RUNNER_ENDPOINT (unix:// today, http:// once Task 14 lands), authed
// with AX_AUTH_TOKEN.
//
// The runner holds NO LLM credentials (invariant I5). The loop's vendored SDK
// calls its provider through the host-side credential-proxy (see
// proxy-startup.ts); the outbound API key carries an `ax-cred:<hex>`
// placeholder that the proxy substitutes for the real key mid-flight. If the
// sandbox is compromised, the real key never entered this process.
//
// Shape: `runRunner` boots the session (env, proxy, IPC, workspace
// materialize, uploads, skills, tool catalog, prompt composition, inbox) and
// then hands a `LoopContext` to ONE loop implementation. The loop owns the
// provider SDK and the message pump; the shell owns everything either side of
// it — including the turn-end commit/ship and the single `event.chat-end`.
//
// Exit codes (the spawning host branches on these):
//   0 — chat completed normally (inbox returned cancel; loop drained).
//   1 — terminated abnormally (loop threw, IPC errored after retries, etc.).
//   2 — fatal during bootstrap (missing env, initial tool.list failure).
//
// Boot-failure paths (return 2 before the IPC client is built, or before the
// loop starts) exit WITHOUT firing `event.chat-end`. That's fine — the
// orchestrator's `handle.exited` watcher synthesizes a terminated outcome with
// reason `sandbox-exit-before-chat-end`, so chat:end still fires exactly once
// per agent:invoke from a subscriber's perspective.
//
// This module must never import a provider SDK. If a step below needs one,
// the boundary is in the wrong place.
// ---------------------------------------------------------------------------

/**
 * What the shell built during boot and hands to the loop. Everything here is
 * constructed exactly once, in boot order, before `makeLoop` is called.
 */
export interface RunnerDeps {
  /** The authed IPC client back to the host. */
  client: IpcClient;
  /** The validated runner env (workspace/ephemeral/user-files roots, proxy). */
  env: RunnerEnv;
  /** The frozen per-session agent config the orchestrator wrote. */
  agentConfig: SessionGetConfigResponse['agentConfig'];
  /** Host tool catalog, already filtered against `agentConfig.allowedTools`. */
  tools: ToolListResponse['tools'];
  /** Executors for tools marked `executesIn: 'sandbox'`. */
  localDispatcher: LocalDispatcher;
  /**
   * Mid-turn workspace flush for host tools that declare
   * `flushWorkspaceBeforeCall`. Serialized internally.
   */
  flushWorkspaceForHostTool: () => Promise<FlushOutcome>;
  /** Proxy bootstrap result — the env the loop must pass to its SDK. */
  proxyStartup: ProxyStartup;
  /** True once the session Python venv exists (created or pre-present). */
  pythonVenvReady: boolean;
  /**
   * The agent's WORKING frame — the durable per-agent user-files mount when
   * one was wired, else the governed workspace root. Loops use it for cwd/HOME.
   */
  homeDir: string;
  /** The system prompt the file-based prompt-engine composed for this session. */
  systemPrompt: string;
  /**
   * The transcript session id to resume from, or null to start fresh. Already
   * demoted to null by the F2a guard when the bound id has no resumable
   * transcript.
   */
  resumeSessionId: string | null;
}

/** One user message, ready for the loop to wrap in its own SDK shape. */
export interface LoopUserMessage {
  /**
   * Either the user's plain text or a provider content-block array (when the
   * turn carried attachments). Opaque to the shell.
   */
  content: unknown;
}

/** An assistant-side delta the host fans out to live clients. */
export type StreamChunk =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool-use';
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      kind: 'tool-result';
      toolCallId: string;
      output: string;
      isError?: boolean;
    };

/** What the loop hands the shell at a turn boundary. */
export interface EndTurnInput {
  /** Assistant-side blocks observed during the turn (text/thinking/tool_use). */
  contentBlocks: ContentBlock[];
  /** tool_result blocks the loop observed during the turn. */
  toolResultBlocks: ContentBlock[];
  /**
   * The uuid of the turn's LAST assistant message, when it produced one.
   * Trace-only for the shell; the loop uses it to gate its own durability wait.
   */
  lastAssistantUuid?: string;
  /**
   * Loop-side work that must complete BEFORE the transcript ships — typically
   * waiting for the loop's own delayed transcript write to land. Runs inside
   * the same best-effort try as the ship/commit, exactly where the wait sat
   * when this lived in the loop.
   */
  beforeCommit?: () => Promise<void>;
  /**
   * Reads the id of the last transcript line of `role` for `sessionId`. The
   * transcript's on-disk shape is loop-specific, so the loop supplies this.
   */
  readTurnId: (
    sessionId: string,
    role: 'user' | 'assistant',
  ) => Promise<string | undefined>;
}

/** The shell surface a loop drives. */
export interface LoopContext {
  /** Pulls the next user message; resolves null when the inbox says cancel. */
  nextMessage(): Promise<LoopUserMessage | null>;
  /** Emit an assistant delta to the host (event.stream-chunk). */
  emitChunk(chunk: StreamChunk): Promise<void>;
  /** Close a turn: ships the transcript delta, commits, emits turn-end. */
  endTurn(input: EndTurnInput): Promise<void>;
  /** Record assistant text for the final `event.chat-end` outcome. */
  recordAssistantText(text: string): void;
  /** The transcript session id in effect (resume id, or the loop's own). */
  getTranscriptSessionId(): string | null;
  /** Report the transcript session id the loop minted. */
  setTranscriptSessionId(sessionId: string): void;
}

/**
 * What a loop resolves with. A bare number is the exit code with no diagnostic
 * (0 = drained normally). The object form carries the `reason` that lands in
 * the `event.chat-end` terminated outcome — use it whenever a loop stops
 * abnormally without throwing, so the host sees why instead of 'unknown'.
 */
export type LoopOutcome = number | { code: number; reason: string };

export interface Loop {
  /** Runs until the inbox cancels or the loop errors. Resolves the exit code. */
  run(ctx: LoopContext): Promise<LoopOutcome>;
}

export interface RunnerSeams {
  /**
   * Builds the loop's transcript source. Required: WHERE a loop's transcript
   * lives (and how it is named) is loop-specific, but the delta/resume
   * protocol on top of it is not.
   */
  createTranscriptSource: (env: RunnerEnv) => TranscriptSource;
  /**
   * Loop-local resumability probe, used only by the F2a guard on
   * non-conversation sessions (no host transcript store to ask).
   */
  hasLocalTranscript: (env: RunnerEnv, sessionId: string) => Promise<boolean>;
  /**
   * Loop-specific scaffolding for the freshly-materialized workspace, run
   * inside the materialize step (so a failure is bootstrap-fatal) and after
   * the .gitignore scaffold. Where a loop redirects its own transcript writes
   * into the governed tier.
   */
  afterMaterialize?: (env: RunnerEnv) => Promise<void>;
  /**
   * Whether the loop's provider accepts `document` content blocks in a user
   * message. Drives attachment translation. Defaults to false.
   */
  supportsDocumentBlocks?: boolean;
  /** Defaults to readRunnerEnv. Injected so the shell is testable. */
  readEnv?: () => RunnerEnv;
}

export function runRunner(
  makeLoop: (deps: RunnerDeps) => Loop,
  seams: RunnerSeams,
): Promise<number> {
  return runRunnerInner(makeLoop, seams, seams.readEnv ?? readRunnerEnv);
}

async function runRunnerInner(
  makeLoop: (deps: RunnerDeps) => Loop,
  seams: RunnerSeams,
  readEnv: () => RunnerEnv,
): Promise<number> {
  let env: RunnerEnv;
  try {
    env = readEnv();
  } catch (err) {
    process.stderr.write(
      `runner: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  // TASK-67 split (runner-core extraction): the delta/prefixHash/resync
  // protocol lives here; locating the loop's transcript (the SDK's private
  // cwd-slug encoding, for the claude-sdk loop) hides behind this source,
  // constructed once and threaded into every `shipTranscriptDelta` call.
  const transcriptSource = seams.createTranscriptSource(env);

  // TASK-149: in TCP-Service mode (production gVisor — no hostPath), the
  // host can't mount the proxy MITM CA into this pod, so it ships the PEM as
  // AX_PROXY_CA_PEM and we write it to the tmpfs cert path BEFORE the loop's
  // SDK (or any TLS) runs. No-op when the cert is already mounted (hostPath
  // mode wins) or when the env isn't set (subprocess / no-proxy). A write
  // failure here is bootstrap-fatal — without the CA the SDK's fetch to the
  // proxy dies with an SSL verification error on its first call. Mirrors the
  // subprocess backend's CA-write (sandbox-subprocess/open-session.ts).
  try {
    const outcome = await writeProxyCaFromEnv();
    if (outcome === 'written') {
      process.stderr.write('runner: wrote proxy MITM CA from AX_PROXY_CA_PEM\n');
    }
  } catch (err) {
    process.stderr.write(
      `runner: proxy CA write failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  // Start the credential-proxy bridge if AX_PROXY_UNIX_SOCKET is set
  // (k8s sandbox); rewrite process.env.HTTP(S)_PROXY in-process so the
  // SDK's outbound fetch sees the loopback bridge. Direct mode
  // (AX_PROXY_ENDPOINT) is a no-op here — sandbox-subprocess already set
  // HTTPS_PROXY in the child env.
  let proxyStartup: ProxyStartup;
  try {
    proxyStartup = await setupProxy(env);
  } catch (err) {
    process.stderr.write(
      `runner: proxy setup failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  // Phase 1 (skill-install): materialize installed skills from
  // AX_INSTALLED_SKILLS_JSON BEFORE the loop's SDK spawns. The sandbox-k8s
  // plugin passes skill content via this env var (subprocess sandbox writes
  // files directly during open-session instead). A failure here is bootstrap-
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
    // runner uses a non-null value as the trigger to bind the loop's
    // session id back via `conversation.store-runner-session` after
    // first init. We normalize `undefined` (older host that hasn't
    // shipped the field) and `null` (non-conversation session) into the
    // same skip-bind branch via a strict equality check on the string
    // type.
    conversationId = typeof cfg.conversationId === 'string' ? cfg.conversationId : null;
    // Phase E (2026-05-09): runnerSessionId rides the same response now
    // that `conversation.fetch-history` is gone. Non-null = the loop has
    // bound a session id on a prior boot; we hand it back as
    // `deps.resumeSessionId` so the loop rehydrates from its own on-disk
    // transcript instead of starting a fresh conversation. Null = first
    // boot OR conversationId is null; the loop starts fresh.
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

  // Phase 3: materialize /agent from a host-streamed baseline bundle
  // BEFORE the loop opens. Failure here is bootstrap-fatal — the
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
    // The materialize bundle is streamed as a raw octet-stream body and drained
    // to a temp file (BUG-W3 — bypasses the 4 MiB JSON response cap that an aged
    // workspace's bundle would blow). materializeWorkspace clones from the file
    // and owns its deletion.
    const mat = await client.callBinary('workspace.materialize', {});
    const out = await materializeWorkspace({
      root: env.workspaceRoot,
      bundlePath: mat.path,
    });
    initialBaselineCommit = out.baselineCommit;
    // Ensure dependency/build artifacts (node_modules, venvs, __pycache__,
    // fetch caches) are git-ignored so agent tooling output isn't committed +
    // bundled back to the host. Must run AFTER the clone for the same reason
    // as the skill-surface scaffold (it appends to any baseline .gitignore).
    await scaffoldWorkspaceGitignore(env.workspaceRoot);
    // Whatever the loop needs scaffolded into the freshly-cloned tree before
    // it starts — typically redirecting the loop's own transcript writes into
    // the workspace. Loop-shaped by nature (it knows where its SDK writes), so
    // it is a seam; it runs INSIDE this try, so a failure is bootstrap-fatal
    // exactly like the clone itself.
    if (seams.afterMaterialize !== undefined) {
      await seams.afterMaterialize(env);
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

  // TASK-68 (out-of-git Part C) + TASK-78: materialize the conversation's
  // committed uploads at the ADVERTISED path `<workspaceRoot>/.ax/uploads/` so
  // the agent can Read them where the system prompt says they are. Uploads left
  // git — the durable home is the blob store; this is the read-only working copy
  // (`.ax/uploads/` is git-ignored, so it never round-trips into the bundle).
  // Best-effort: a missing/failed blob is skipped, never fatal (a single
  // unreadable upload must not abort session boot — the download path still
  // serves it from the store, and the transcript keeps its provenance). The
  // closure is reused on warm-runner rebind (a later turn that brings a new
  // upload — see nextMessage below); each call wipes stale residue + writes the
  // full current set, so the on-disk copy always matches the host's list. Gated
  // on a bound conversation (a non-conversation session has no uploads to pull).
  const materializeUploadsForConversation = async (): Promise<void> => {
    if (conversationId === null) return;
    try {
      const n = await materializeUploads({
        client,
        conversationId,
        workspaceRoot: env.workspaceRoot,
      });
      if (n > 0) {
        process.stderr.write(
          `runner: materialized ${n} upload(s) into ${env.workspaceRoot}/.ax/uploads\n`,
        );
      }
    } catch (err) {
      // materializeUploads is best-effort and shouldn't throw, but never let a
      // surprise abort the boot/turn.
      process.stderr.write(
        `runner: upload materialization error (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  };
  await materializeUploadsForConversation();

  // Transcript session id used to LOCATE the transcript for the loop's
  // durability wait AND for the turn-end turnId reads. Starts as the resume id
  // (if any); set to the loop's own session id on its first init. Distinct from
  // `runnerSessionId`, which only ever holds the resume value (null on a fresh
  // first turn). The turn-end emissions read turnIds from THIS id, not
  // `runnerSessionId`, so a first turn (where `runnerSessionId` is null but the
  // loop has minted a real session) still surfaces a turnId for first-turn
  // consumers (FAULTA-3).
  let transcriptSessionId: string | null = runnerSessionId;

  // Phase E (2026-05-09): the replay-at-boot path is gone. Transcripts
  // live in the runner's native ~/.claude/projects/<sessionId>.jsonl
  // file (HOME-redirected into the workspace by Phase C), and the host
  // reads them back via @ax/workspace-* on demand (Phase D). The runner
  // never re-emits prior user turns into the loop's prompt iterator: the
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
  // tool catalog the loop sees is still bounded.
  if (agentConfig.allowedTools.length > 0) {
    const allow = new Set(agentConfig.allowedTools);
    tools = tools.filter((t) => allow.has(t.name));
  }

  // Tracks the last accepted workspace version so the host's optimistic-
  // concurrency check sees a coherent lineage across turns. Initialized
  // to the materialize-time baseline OID so the FIRST commit-notify of
  // this session reports a parent that matches what the host's
  // workspace-export-baseline-bundle hook will reproduce. Declared here
  // (ahead of the loop) so the mid-turn host-tool flush below and the
  // turn-end commit share the same chained `parentVersion`.
  let parentVersion: string | null = initialBaselineCommit;

  // TASK-67: the runner-local resume-transcript ship state, threaded across
  // turns exactly like `parentVersion`. `sentOffset` is the transcript byte
  // offset already shipped to the host store; `sentSeq` is the host's row count
  // (max seq). Fresh boot starts at {0,0}; a resume seeds it from the rebuilt
  // transcript (set in the F2a block below, after restoreTranscriptForResume
  // runs).
  let transcriptShipState: TranscriptShipState = { sentOffset: 0, sentSeq: 0 };

  // Mid-turn flush for host tools that declare `flushWorkspaceBeforeCall`.
  // The runner commits + pushes its live /agent tree to the host mirror
  // BEFORE the host tool runs, so a host read of a file the agent just wrote
  // this turn sees it instead of the stale committed mirror (BUG-W2). Threads the
  // advanced version back into `parentVersion` so the turn-end commit chains,
  // and returns the flush outcome so the forwarder can gate the call on it.
  //
  // Serialized via `flushChain`: `commitTurnAndBundle` runs git ops on the one
  // /agent repo and reads+mutates the shared `parentVersion`. If the loop
  // ever dispatches two flagged host tools concurrently, unserialized flushes
  // would race the git index and the parent token; chaining makes the
  // read-flush-write critical section atomic. The turn-end commit runs at the
  // turn boundary (after all tool calls), so it never overlaps a flush.
  let flushChain: Promise<unknown> = Promise.resolve();
  const flushWorkspaceForHostTool = (): Promise<FlushOutcome> => {
    const run = flushChain.then(async () => {
      const result = await flushWorkspaceToHost({
        client,
        root: env.workspaceRoot,
        parentVersion,
        reason: 'turn',
      });
      parentVersion = result.parentVersion;
      return result.outcome;
    });
    // Keep the chain alive whether this run resolves or rejects, so one failed
    // flush doesn't permanently wedge the next.
    flushChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // Phase 2: sandbox-MCP bridge. The local-dispatcher holds executors for
  // tools marked `executesIn: 'sandbox'`. Today only `artifact_publish`
  // uses this path; future sandbox tools register here too.
  const localDispatcher = createLocalDispatcher();
  if (tools.some((t) => t.name === ARTIFACT_PUBLISH_TOOL_NAME && t.executesIn === 'sandbox')) {
    // TASK-68: the executor now streams artifact bytes to the host blob store
    // (blob.put) + records the metadata row (artifact.publish), so it needs the
    // IPC client + the bound conversationId. Artifacts default to
    // /ephemeral/artifacts/**, so it also needs ephemeralRoot to map the path.
    localDispatcher.register(
      ARTIFACT_PUBLISH_TOOL_NAME,
      createArtifactPublishExecutor({
        workspaceRoot: env.workspaceRoot,
        ...(env.ephemeralRoot !== undefined ? { ephemeralRoot: env.ephemeralRoot } : {}),
        client,
        conversationId,
      }),
    );
  }
  // TASK-74 — skill_propose executor (sandbox-executed, like artifact_publish):
  // reads the agent's draft under `<root>/.skill-draft/<id>/`, validates it, and
  // ships it to the host gate over the skill.propose IPC action. The draft root is
  // the DURABLE per-agent mount when wired (AX_USERFILES_ROOT) so drafts persist
  // across sessions, else the ephemeral scratch tier (fallback) — TASK-165 / §7.
  // Needs both roots (the executor picks userFilesRoot ?? ephemeralRoot) + the IPC
  // client; scope is host-derived. Both spread-when-present so an absent tier is
  // simply not passed.
  if (tools.some((t) => t.name === SKILL_PROPOSE_TOOL_NAME && t.executesIn === 'sandbox')) {
    localDispatcher.register(
      SKILL_PROPOSE_TOOL_NAME,
      createSkillProposeExecutor({
        ...(env.userFilesRoot !== undefined ? { userFilesRoot: env.userFilesRoot } : {}),
        ...(env.ephemeralRoot !== undefined ? { ephemeralRoot: env.ephemeralRoot } : {}),
        client,
      }),
    );
  }

  const inbox = createInboxLoop({ client });

  // Phase 2: whether the loop's provider accepts `document` content blocks.
  // A per-loop capability (each SDK pin answers differently), so the loop
  // declares it; conservative default false.
  const SUPPORTS_DOCUMENT_BLOCKS = seams.supportsDocumentBlocks ?? false;

  // TASK-68 + TASK-78: the attachment-translation reader fetches an attachment's
  // bytes to inline (text) or pass through (image/pdf) to the loop. Uploads left
  // git — they materialize at the advertised `<workspaceRoot>/.ax/uploads/` (see
  // materializeUploadsForConversation above) — so for an `.ax/uploads/...` key we
  // read the materialized local file. A non-upload path (a Pattern A workspace
  // file referenced as an attachment) still goes through `workspace.read`. The
  // translation pass degrades to a text mention on a read failure, so a missing
  // materialized file is non-fatal.
  const workspaceReader: WorkspaceReader = async (p) => {
    const materialized = resolveMaterializedPath(
      uploadsBaseDir(env.workspaceRoot),
      p,
    );
    if (materialized !== null) {
      try {
        const bytes = await fsp.readFile(materialized);
        return { found: true, bytesBase64: bytes.toString('base64') };
      } catch {
        return { found: false };
      }
    }
    const resp = (await client.call('workspace.read', {
      path: p,
    } as WorkspaceReadRequest)) as WorkspaceReadResponse;
    return resp;
  };

  // Phase 3: workspace commits are turn-end via git-status against
  // /agent (`commitTurnAndBundle` at the turn boundary).
  // The legacy PostToolUse-based diff accumulator is gone — git status
  // catches ALL writes regardless of tool, including the Bash deletes
  // and MCP writes the legacy path missed. (`parentVersion` is declared
  // above, before the dispatcher, so the mid-turn host-tool flush
  // shares the same chained version.)

  // Phase C: bind the loop's session_id to our conversation row.
  //
  // The loop's SDK owns durable transcripts on disk (under HOME, which we
  // redirect into the workspace in a sibling task). We capture the session_id
  // the loop reports at its first init and POST it to the host so a future
  // runner restart can `resume(sessionId)` — read back via the
  // runnerSessionId field on the next session.get-config response (Phase E).
  //
  // Once-only: a loop can re-emit init on a resume path. Only the FIRST init
  // is load-bearing for the bind — the runner sets the flag BEFORE the await
  // so a re-entrant init can't double-fire even if the IPC is in flight.
  //
  // Non-fatal: if the bind fails, we lose the resume optimization on
  // next restart (the SDK starts a fresh session and writes a new jsonl,
  // which the workspace-jsonl reader still picks up alongside any
  // earlier jsonl files). The chat itself continues uninterrupted.
  let runnerSessionIdSent = false;
  // Host-side bookkeeping for the final event.chat-end outcome. The loop's SDK
  // maintains its OWN transcript internally; this array is only the shape
  // the host cares about (user/assistant text round-tripped through
  // AgentMessage).
  const chatEndHistory: AgentMessage[] = [];

  // Most-recent host-minted reqId from the inbox (J9). Set when a user
  // message arrives; read by `event.stream-chunk` emissions during the
  // assistant branch. Lifetime is "from the inbox pull until the
  // next inbox pull" — chunks for the SAME reqId may continue across
  // multiple turn boundaries (the loop may break a long response
  // into multiple turns), so we DO NOT clear this on turn-end. A chunk
  // that would emit before any user message has been pulled is impossible
  // by construction (no input → no output), but we defend anyway:
  // an unset reqId causes the chunk to be skipped (no `event.stream-chunk`
  // with a missing reqId — the host's router can't route it).
  let currentReqId: string | undefined;

  // Inbox → loop user-message pull. Resolving null on cancel tells the loop no
  // more user messages are coming, which lets it drain naturally and exit.
  //
  // Phase E (2026-05-09): no more replay-from-DB. The SDK's
  // `resume(sessionId)` rehydrates the transcript from its own on-disk
  // store (~/.claude/projects/<sessionId>.jsonl, HOME-redirected into
  // the workspace by Phase C) when `runnerSessionId !== null`. This pull
  // surfaces only live inbox messages; prior turns are the loop's
  // responsibility to surface to the model.
  async function nextMessage(): Promise<LoopUserMessage | null> {
    for (;;) {
      const entry = await inbox.next();
      if (entry.type === 'cancel') return null;
      if (entry.type === 'idle-timeout') {
        // Host-crash floor: nobody is going to send us another message and
        // the host idle reaper isn't around to cancel us. Drain the loop and
        // exit cleanly (same as cancel) — we still emit our single chat:end
        // on the way out (the tail of runRunner), which the host's
        // session:terminate path keys off.
        process.stderr.write('runner: inbox idle floor reached; exiting\n');
        return null;
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

      // TASK-78 (warm-runner rebind): boot-time materialization (above) only
      // covers uploads that already existed when this runner started. A warm
      // runner reused for a LATER turn that brings a fresh upload never re-ran
      // it, so the new file was missing on disk and the agent couldn't Read it.
      // Re-materialize the full upload set whenever this turn carries an
      // `attachment` block — idempotent (wipes + rewrites the current set), so
      // the just-uploaded file lands and stale residue is cleared. Best-effort:
      // the helper swallows its own errors and the translate pass below degrades
      // to a text mention if a file is still missing.
      const hasAttachment =
        hasBlocks &&
        entry.payload.contentBlocks!.some((b) => b.type === 'attachment');
      if (hasAttachment) {
        await materializeUploadsForConversation();
      }

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

      // NOTE (TASK-66): the USER turn is persisted into the display event log
      // HOST-side by @ax/chat-orchestrator at agent:invoke dispatch (it already
      // holds the user's content blocks + conversationId there). The runner
      // does NOT emit a user `event.turn-end` — firing chat:turn-end here would
      // trip the host's turn-end side effects (the SSE done-frame closer keyed
      // by conversationId, one-shot keep-warm, clear-active-req-id), closing
      // the live stream before the turn even runs. See orchestrator.

      return { content: messageContent };
    }
  }

  let exitCode = 0;
  let terminatedReason: string | undefined;
  let terminatedError:
    | { name: string; message: string; stack?: string }
    | undefined;

  // F2a resume guard + TASK-67 resume rebuild. `query({ resume: X })`
  // hard-crashes the runner (`exit 1` → chat-end `terminated`) with "No
  // conversation found with session ID: X" whenever the bound session has NO
  // parseable transcript on disk where the SDK looks for it.
  //
  // The transcript now lives OUT OF GIT, as rows in the host store (TASK-67).
  // So on resume we REBUILD the transcript from the store FIRST —
  // `restoreTranscriptForResume` fetches the joined bytes and writes them via
  // the loop's transcript source (the path the SDK reads) — then seed
  // `transcriptShipState` so the delta-ship picks up where the store
  // left off. The F2a guard becomes the DB check: when the host has no rows
  // (`written === false`, i.e. max(seq) === 0) we omit `resume` and start fresh
  // instead of crashing. A bound id should always have rows (bind is deferred to
  // the first durable append), but a regression that drops them degrades to a
  // fresh start, not a hard exit.
  //
  // Single-session / non-conversation runs (conversationId === null) can't
  // reach the host transcript store, so they keep the legacy on-disk scan
  // (the loop's `hasLocalTranscript` seam) as the guard — the transcript, if
  // any, is the materialized-workspace copy.
  let resumeSessionId = runnerSessionId;
  if (runnerSessionId !== null) {
    let resumable: boolean;
    if (conversationId !== null) {
      try {
        const restored = await restoreTranscriptForResume({
          client,
          source: transcriptSource,
          sessionId: runnerSessionId,
        });
        resumable = restored.written;
        if (restored.written) {
          transcriptShipState = restored.state;
        }
      } catch (err) {
        // A failure fetching/rebuilding the transcript shouldn't crash boot —
        // degrade to a fresh start (the user re-states; far better than a hard
        // exit). Log loudly.
        process.stderr.write(
          `runner: restoreTranscriptForResume failed; starting fresh: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        resumable = false;
      }
    } else {
      resumable = await seams.hasLocalTranscript(env, runnerSessionId);
    }
    if (!resumable) {
      process.stderr.write(
        'runner: bound runner session has no resumable transcript; starting fresh instead of resuming\n',
      );
      resumeSessionId = null;
      // `transcriptSessionId` was seeded to the (stale) resume id above; the loop
      // will mint a FRESH session id now that we omit `resume`, so clear it back
      // to null so its init handler re-captures the new id. Otherwise the
      // turn-end flush wait would poll the wrong (non-existent) transcript, and
      // the fresh transcript would ship from a stale offset.
      transcriptSessionId = null;
      transcriptShipState = { sentOffset: 0, sentSeq: 0 };
    }
  }

  // F2a root fix: bind the conversation row → runner-native transcript ONCE,
  // after the first host-ACCEPTED turn-end commit — NOT at the loop's init.
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
    const loopSessionId = transcriptSessionId;
    if (
      runnerSessionIdSent ||
      convId === null ||
      runnerSessionId !== null ||
      loopSessionId === null
    ) {
      return;
    }
    try {
      await client.call('conversation.store-runner-session', {
        conversationId: convId,
        runnerSessionId: loopSessionId,
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

  // filestore-user-files Phase 2 (TASK-164) — the agent's WORKING FRAME.
  //
  // When the sandbox wired a durable per-agent user-files mount
  // (AX_USERFILES_ROOT, e.g. `/workspace`), the loop's subprocess cwd + HOME
  // move there, so relative-path file work, builds, `git clone .`, `~/bin`, and
  // tool caches all default to durable NFS instead of the ephemeral `/agent`
  // emptyDir. When unset, this is `env.workspaceRoot` (=/agent) — today's
  // behavior, byte-identical.
  //
  // This is ONLY the agent's working frame. The GOVERNED frame
  // (`env.workspaceRoot`=/agent — the validated, git-backed tier) is unchanged
  // and still drives every other path: git status/bundle, the transcript
  // `$CLAUDE_CONFIG_DIR/projects → <workspaceRoot>/.claude/projects` symlink, the
  // prompt-engine's `${workspaceRoot}/.ax` reads, uploads materialization, and —
  // critically — the PreToolUse re-rooter's TARGET, so `.ax/**`+`.claude/**`
  // self-edits land back on /agent even though cwd is now ungoverned NFS (§14).
  const homeDir = env.userFilesRoot ?? env.workspaceRoot;

  // Conversational-agent-identity: the file-based prompt-engine reads
  // `${workspaceRoot}/.ax/` and composes the system prompt for THIS turn —
  // bootstrap mode (BOOTSTRAP.md verbatim) or normal mode (safety floor + the
  // agent's IDENTITY/SOUL/AGENTS files + evolution guidance + operational
  // notes; a file-less agent falls back to its displayName identity line).
  // `agentConfig.systemPromptAugment` carries the host `system-prompt:augment`
  // contribution, prepended on top in normal mode; `agentConfig.displayName` is
  // the host-controlled fallback identity used when no IDENTITY.md exists. Both
  // are intended for the LLM and never interpolated into shell, paths, or HTML.
  // The `.ax/` files are agent-authored (untrusted): the hardcoded safety floor
  // is always injected in normal mode and no file can suppress it. Computed
  // before the loop starts because the engine reads files (async) and an SDK
  // options literal can't await inline.
  const composedSystemPrompt = await buildSystemPrompt(
    agentConfig.displayName,
    agentConfig.systemPromptAugment,
    env.workspaceRoot,
    env.ephemeralRoot,
    pythonVenvReady,
    // filestore-user-files Phase 1: advertise the durable per-agent mount when
    // the sandbox wired one.
    env.userFilesRoot,
    // filestore-user-files Phase 2 (TASK-164): the agent's effective working
    // directory. When it differs from the governed root, the workspace note
    // states both so the model resolves shared `.ax/uploads/…` files under the
    // governed root, not the new cwd.
    homeDir,
  );

  // Turn boundary (Phase 3). Replaces the legacy PostToolUse-based
  // diff observer with `git status` + bundle:
  //   1. Stage everything in /agent (`git add -A`) — catches
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
  async function endTurn(input: EndTurnInput): Promise<void> {
    try {
      commitTrace(
        `[commit-trace] per-turn result: session=${transcriptSessionId ?? 'null'} contentBlocks=${input.contentBlocks.length} toolResults=${input.toolResultBlocks.length} finalAsstUuid=${input.lastAssistantUuid ?? '-'} parent=${parentVersion ?? 'null'}\n`,
      );
      // Let the loop wait for its own delayed transcript write to land so this
      // turn's closing reply is captured by the commit/bundle below.
      if (input.beforeCommit !== undefined) {
        await input.beforeCommit();
      }
      // TASK-67: ship the resume-transcript DELTA (the loop's transcript, now
      // out of git). Replaces the per-turn commit/bundle of the jsonl: the new
      // lines append as opaque rows in the host store, O(1) per turn. The
      // bind-after-DURABLE (F2a) moves here — the transcript is durable once
      // the host accepts the append/replace, mirroring today's
      // bind-after-commit-accepted. Non-transcript /agent state (identity,
      // Pattern A) still rides commitTurnAndBundle below (the jsonl is
      // gitignored, so that commit is usually empty on a chat turn).
      if (transcriptSessionId !== null && conversationId !== null) {
        const shipped = await shipTranscriptDelta({
          client,
          source: transcriptSource,
          sessionId: transcriptSessionId,
          state: transcriptShipState,
        });
        transcriptShipState = {
          sentOffset: shipped.sentOffset,
          sentSeq: shipped.sentSeq,
        };
        commitTrace(
          `[commit-trace] per-turn shipTranscriptDelta → ${shipped.outcome} sentSeq=${shipped.sentSeq} sentOffset=${shipped.sentOffset}\n`,
        );
        if (shipped.outcome === 'appended' || shipped.outcome === 'resynced') {
          await bindRunnerSessionIfNeeded();
        }
      }
      // Commit + bundle any NON-transcript /agent change (identity,
      // Pattern A project code). With transcripts (TASK-67), blobs/
      // attachments (TASK-68), and skills (TASK-69) all off git, this is
      // the WHOLE of what the per-turn commit carries now — and a pure
      // chat turn changes none of it: `.claude/projects/` is gitignored,
      // so nothing stages → `commitTurnAndBundle` returns null →
      // commit-notify is SKIPPED. The commit fires ONLY on a non-empty
      // /agent diff (TASK-70 Phase-5 gate; the empty-diff skip is the
      // `git diff --cached --quiet` short-circuit inside
      // commitTurnAndBundle).
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
      // /agent in a weird state, etc.). Non-fatal; the next
      // turn will retry.
      process.stderr.write(
        `runner: commitTurnAndBundle failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    // One turn of assistant output finished. The loop now awaits the
    // next user message — i.e. the next inbox pull.
    //
    // We may emit up to TWO chat:turn-end events at this boundary:
    //   1. role='tool' if the runner observed any tool_result blocks
    //      during this turn (the loop echoed them back as user msgs).
    //      Emitted FIRST because they chronologically precede the
    //      assistant's wrap-up text in the transcript.
    //   2. role='assistant' for the assistant turn itself. Emitted
    //      unconditionally as a heartbeat — contentBlocks is only
    //      attached when non-empty so empty turns stay heartbeats.
    //
    // Failures here MUST NOT terminate the chat (host may be tearing
    // down). Each call swallows independently.
    if (input.toolResultBlocks.length > 0) {
      // The loop echoes tool_result blocks back as transcript lines with
      // `type: 'user'`, so we look up the uuid of the LAST 'user'
      // line for this session. Best-effort: undefined-on-miss is
      // fine because subscribers gracefully skip without a turnId.
      // Read via `transcriptSessionId` (the loop's real session id,
      // captured at its init) — NOT the boot `runnerSessionId`,
      // which is null on a conversation's first turn (it only ever
      // holds a *resume* value). On a fresh first turn the transcript lives
      // under the freshly-minted session id, so `runnerSessionId` would
      // emit no turnId and a first-turn consumer (e.g. @ax/routines
      // silence-token dropping a per-fire conversation's first turn)
      // couldn't refer back to it. (FAULTA-3)
      const turnId =
        transcriptSessionId !== null
          ? await input.readTurnId(transcriptSessionId, 'user')
          : undefined;
      await client
        .event('event.turn-end', {
          reason: 'user-message-wait',
          role: 'tool',
          contentBlocks: input.toolResultBlocks,
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

    // Look up the uuid of the LAST 'assistant' line so subscribers
    // (e.g., @ax/routines silence-token logic) can refer back to
    // this specific turn via conversations:drop-turn. Read via
    // `transcriptSessionId` (the loop's real session id), NOT the boot
    // `runnerSessionId` — see the role='tool' turn-end above; on a
    // fresh first turn `runnerSessionId` is null, so reading it would
    // emit no turnId and a routine silencing its per-fire
    // conversation's first turn couldn't drop it. (FAULTA-3)
    const assistantTurnId =
      transcriptSessionId !== null
        ? await input.readTurnId(transcriptSessionId, 'assistant')
        : undefined;
    await client
      .event('event.turn-end', {
        reason: 'user-message-wait',
        role: 'assistant',
        ...(input.contentBlocks.length > 0
          ? { contentBlocks: input.contentBlocks }
          : {}),
        // See reqId rationale on the tool turn-end above.
        ...(currentReqId !== undefined ? { reqId: currentReqId } : {}),
        ...(assistantTurnId !== undefined ? { turnId: assistantTurnId } : {}),
      })
      .catch(() => {
        /* host may be tearing down; non-fatal */
      });
  }

  const ctx: LoopContext = {
    nextMessage,
    emitChunk: async (chunk: StreamChunk): Promise<void> => {
      // Per-block streaming (Task 6 / J9). The loop forwards each block as
      // the model produces it; we ship it as `event.stream-chunk` so the
      // host's chat:stream-chunk subscriber (Task 5) can fan out to waiting
      // clients (Task 7). Failure is non-fatal: the host may be tearing down,
      // and the canonical transcript still flows via event.turn-end /
      // event.chat-end. Untrusted (J2): the text is model output and reaches
      // the host verbatim — host-side renderers sanitize.
      if (currentReqId === undefined) return;
      await client
        .event('event.stream-chunk', { reqId: currentReqId, ...chunk })
        .catch(() => {
          /* host may be tearing down; non-fatal */
        });
    },
    endTurn,
    recordAssistantText: (text: string): void => {
      chatEndHistory.push({ role: 'assistant', content: text });
    },
    getTranscriptSessionId: () => transcriptSessionId,
    setTranscriptSessionId: (sessionId: string): void => {
      transcriptSessionId = sessionId;
    },
  };

  // Constructed OUTSIDE the try below on purpose. Building the loop (its MCP
  // servers, hook adapters, provider client) is the tail of bootstrap, not the
  // run: a throw here must stay bootstrap-fatal — propagate, exit 2, no
  // `event.chat-end` — exactly as it did when these constructions sat inline in
  // the runner binary's boot sequence.
  const loop = makeLoop({
    client,
    env,
    agentConfig,
    tools,
    localDispatcher,
    flushWorkspaceForHostTool,
    proxyStartup,
    pythonVenvReady,
    homeDir,
    systemPrompt: composedSystemPrompt,
    resumeSessionId,
  });

  try {
    const outcome = await loop.run(ctx);
    if (typeof outcome === 'number') {
      exitCode = outcome;
    } else {
      exitCode = outcome.code;
      // A loop that stops abnormally without throwing still owes the host a
      // reason; without this the chat-end outcome degrades to 'unknown'.
      terminatedReason = outcome.reason;
    }

    // Final commit: the loop's SDK subprocess writes the assistant response to
    // the transcript AFTER yielding `result` to Node.js. The per-turn commit in
    // the turn handler fires before those writes land, so the assistant
    // response is always missing from the committed state. Committing here
    // — after the loop fully drains — captures the SDK's delayed
    // writes. If nothing changed vs. the last per-turn commit (e.g. the
    // SDK flushed everything before `result`), `git add -A` produces an
    // empty diff and no commit is created (commitTurnAndBundle short-
    // circuits on empty diffs).
    commitTrace(
      `[commit-trace] for-await drained → final flush (parent=${parentVersion ?? 'null'})\n`,
    );
    try {
      // TASK-67: final transcript flush. The SDK writes the closing assistant
      // line AFTER yielding `result`, so the per-turn ship may have raced it;
      // this final ship (after the loop fully drains) captures the tail.
      // `shipTranscriptDelta` is a noop when the per-turn ship already sent
      // everything (no new complete line past sentOffset).
      if (transcriptSessionId !== null && conversationId !== null) {
        const shipped = await shipTranscriptDelta({
          client,
          source: transcriptSource,
          sessionId: transcriptSessionId,
          state: transcriptShipState,
        });
        transcriptShipState = {
          sentOffset: shipped.sentOffset,
          sentSeq: shipped.sentSeq,
        };
        commitTrace(
          `[commit-trace] final shipTranscriptDelta → ${shipped.outcome} sentSeq=${shipped.sentSeq}\n`,
        );
        // F2a: last chance to bind once the transcript is durable (e.g. when the
        // per-turn ship was a noop but a final line landed here). Once-only.
        if (shipped.outcome === 'appended' || shipped.outcome === 'resynced') {
          await bindRunnerSessionIfNeeded();
        }
      }
      // Commit + bundle any NON-transcript /agent change (see per-turn site).
      const finalBundle = await commitTurnAndBundle({
        root: env.workspaceRoot,
        reason: 'turn',
      });
      commitTrace(
        `[commit-trace] final commitTurnAndBundle → ${finalBundle === null ? 'EMPTY (no staged diff; commit-notify SKIPPED)' : `${finalBundle.length}B`}\n`,
      );
      if (finalBundle !== null) {
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
      process.stderr.write(`runner: final transcript flush / commit failed: ${err instanceof Error ? err.message : String(err)}\n`);
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
