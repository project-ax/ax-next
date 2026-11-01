import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { ChatEndHistory } from './chat-end-history.js';
import {
  createIpcClient,
  IpcRequestError,
  type ContentBlock,
  type IpcClient,
  type SessionGetConfigResponse,
  type ToolListResponse,
} from '@ax/ipc-protocol';
import { ARTIFACT_PUBLISH_TOOL_NAME } from '@ax/tool-artifact-publish';
import { SKILL_PROPOSE_TOOL_NAME } from '@ax/tool-skill-propose';
import { createArtifactPublishExecutor } from './artifact-publish-executor.js';
import { trackGeneratedFiles, publishedAttachments } from './generated-files.js';
import { createToolPolicy } from './tool-policy.js';
import { translateContentBlocks } from './attachment-translation.js';
import { commitTrace } from './commit-trace.js';
import { assertConfigDirOutsideAgentHome } from './config-dir-guard.js';
import { readRunnerEnv, runnerHomeDir, type RunnerEnv } from './env.js';
import { decisionResolvedTurn } from './decision-turn.js';
import { createInboxLoop, type InboxLoopEntry } from './inbox-loop.js';
import { materializeInstalledSkillsFromEnv } from './installed-skills.js';
import { createLocalDispatcher, type LocalDispatcher } from './local-dispatcher.js';
import { materializeUploads, scratchUploadsDir, type MaterializedUpload } from './materialize-uploads.js';
import { buildSystemPrompt } from './prompt-engine.js';
import { writeProxyCaFromEnv } from './proxy-ca-from-env.js';
import { setupProxy, type ProxyStartup } from './proxy-startup.js';
import { scaffoldPythonVenv } from './python-venv.js';
import { createSkillProposeExecutor } from './skill-propose-executor.js';
import {
  replaceWholeTranscript,
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
// Shape: `runRunner` boots the session (env, proxy, IPC, the loop's own
// session preparation, uploads, skills, tool catalog, prompt composition,
// inbox) and then hands a `LoopContext` to ONE loop implementation. The loop
// owns the provider SDK and the message pump; the shell owns everything either
// side of it — including the turn-end transcript ship and the single
// `event.chat-end`.
//
// Exit codes (the spawning host branches on these):
//   0 — chat completed normally (inbox returned cancel; loop drained).
//   1 — terminated abnormally (loop threw, IPC errored after retries, etc.).
//   2 — fatal during bootstrap (missing env, initial tool.list failure).
//
// Boot-failure paths (return 2 before the IPC client is built, or before the
// loop starts) exit WITHOUT firing `event.chat-end`. That's fine — the
// orchestrator's `handle.exited` watcher synthesizes a terminated outcome, so
// chat:end still fires exactly once per agent:invoke from a subscriber's
// perspective. The reason is `runner-boot-failed` for exit 2 (TASK-784 — the
// orchestrator reads the exit code; keep 2 meaning "fatal before the loop") and
// `sandbox-exit-before-chat-end` for any other early exit.
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
  /** The validated runner env (the home and scratch roots, proxy). */
  env: RunnerEnv;
  /** The frozen per-session agent config the orchestrator wrote. */
  agentConfig: SessionGetConfigResponse['agentConfig'];
  /** Host tool catalog, already filtered against `agentConfig.allowedTools`
   *  and with `agentConfig.disallowedTools` removed. */
  tools: ToolListResponse['tools'];
  /** Executors for tools marked `executesIn: 'sandbox'`. */
  localDispatcher: LocalDispatcher;
  /** Proxy bootstrap result — the env the loop must pass to its SDK. */
  proxyStartup: ProxyStartup;
  /** True once the session Python venv exists (created or pre-present). */
  pythonVenvReady: boolean;
  /**
   * The agent's home (`runnerHomeDir`: the durable per-agent user-files root).
   * Loops use it for the SDK's cwd/HOME.
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
  /**
   * A shell-minted UUID naming this message (TASK-708). A loop whose model can
   * fold a message into a turn already running hands this to its SDK and,
   * when the SDK says the message was consumed, reports it back through
   * `LoopContext.markMessageConsumed`. Loops that cannot fold ignore it.
   */
  id: string;
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
      /**
       * Runner-side twin of the `held` block field (TASK-270): the call
       * never ran and is waiting on a human. Optional; absent = not held.
       */
      held?: boolean;
    };

/**
 * What one turn cost, as the loop measured it (TASK-692, per-user spend
 * limits). Rides the assistant `event.turn-end` as `usage`; the host meters it.
 *
 * The buckets are DISJOINT — the host prices each at its own rate, so a loop
 * that lets them overlap double-charges the user:
 *   - `model`: the `provider/model-id` ref the turn ran on (the agent's
 *     configured model, e.g. `anthropic/claude-sonnet-4-6`).
 *   - `inputTokens`: input billed at the STANDARD input rate, i.e. EXCLUDING
 *     cache reads and cache writes.
 *   - `outputTokens`: every output token, including reasoning/thinking.
 *   - `cacheReadTokens` / `cacheWriteTokens`: cached input read / written.
 */
export interface TurnUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Upper bound on any reported token count; mirrors the wire schema's max. */
const MAX_TOKEN_COUNT = 1_000_000_000;
/** Mirrors the wire schema's `model` max length. A longer ref fails validation. */
const MAX_MODEL_REF_LENGTH = 200;
/** Local mirror of the host tool @ax/agents registers for an agent to rewrite
 *  its own identity or soul (TASK-989). Mirrored, not imported: the runner
 *  imports no plugin (Invariant #2). */
const UPDATE_IDENTITY_TOOL_NAME = 'update_identity';

/**
 * One token count made safe for the wire: an unreadable value (NaN, Infinity,
 * a string) is 0, a fraction rounds, a negative is 0, and anything above the
 * wire's ceiling is clamped to it. Loop data is not trusted to be well-formed —
 * and a value the host's schema rejects would fail the WHOLE turn-end (the
 * display frame rides it), so a bad count must never reach the wire.
 */
function normalizeTokenCount(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.min(MAX_TOKEN_COUNT, Math.max(0, Math.round(n)));
}

/**
 * The `usage` object for the wire, or `undefined` when there is none to send
 * (the loop reported `null`/nothing, or the model ref is unusable). `undefined`
 * means "unknown", which the host charges at a conservative flat cost.
 */
function normalizeTurnUsage(usage: TurnUsage | null | undefined): TurnUsage | undefined {
  if (usage === null || usage === undefined) return undefined;
  const model: unknown = usage.model;
  if (typeof model !== 'string' || model.length === 0 || model.length > MAX_MODEL_REF_LENGTH) {
    return undefined;
  }
  return {
    model,
    inputTokens: normalizeTokenCount(usage.inputTokens),
    outputTokens: normalizeTokenCount(usage.outputTokens),
    cacheReadTokens: normalizeTokenCount(usage.cacheReadTokens),
    cacheWriteTokens: normalizeTokenCount(usage.cacheWriteTokens),
  };
}

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
   * waiting for the loop's own delayed transcript write to land, so the turn's
   * closing reply is in what ships. Runs inside the same best-effort try as
   * the ship.
   */
  beforeTranscriptShip?: () => Promise<void>;
  /**
   * Reads the id of the last transcript entry for `sessionId` carrying the
   * given DISPLAY role — the same role the shell is about to stamp on
   * `event.turn-end`, so subscribers can refer back to that exact turn (e.g.
   * `conversations:drop-turn`).
   *
   * The role vocabulary here is the HOST's (`chat:turn-end`'s `role`), never a
   * loop's storage vocabulary. The Claude Agent SDK, for instance, echoes tool
   * results back as `user` jsonl lines; mapping `'tool'` onto that is the SDK
   * adapter's job, not the shell's. The transcript's shape is loop-specific,
   * so the loop supplies this whole function.
   */
  readTurnId: (
    sessionId: string,
    role: 'tool' | 'assistant',
  ) => Promise<string | undefined>;
  /**
   * What this turn cost. REQUIRED, on purpose: `endTurn` is the one seam every
   * loop closes a turn through, so a loop cannot compile without saying what
   * its turn cost — a new runner cannot silently skip the meter (TASK-692).
   *
   * `null` means "this loop cannot tell" (an aborted turn with no accounting, a
   * provider that reports none). The host then charges a conservative flat
   * assumed cost: unknown is never free. Do NOT pass zeros to mean "unknown" —
   * zeros are a claim that the turn was free.
   *
   * The shell forwards it on the ASSISTANT `event.turn-end` only (never the
   * role='tool' one), after clamping each count to a sane non-negative integer.
   */
  usage: TurnUsage | null;
}

/** The shell surface a loop drives. */
export interface LoopContext {
  /** Pulls the next user message; resolves null when the inbox says cancel. */
  nextMessage(): Promise<LoopUserMessage | null>;
  /**
   * Register for the person pressing Stop (TASK-688): `handler` is called, at
   * most once per turn, when an `interrupt` arrives while a turn is in flight.
   * Returns a disposer.
   *
   * What the handler must do is the loop's business — abort the model call and
   * the running tool, then reach `endTurn` with whatever the turn produced. The
   * runner is NOT ending: `cancel` ends the session, `interrupt` stops the turn
   * and leaves the runner ready for the next message. An interrupt with no turn
   * in flight never reaches a handler, and one that arrives before the handler
   * registered fires on registration, so a loop need not worry about the race
   * between "the turn began" and "I started listening".
   *
   * Handlers are called synchronously from the shell's inbox reader: keep them
   * to "flip a flag / abort a controller". A throwing handler is logged and
   * does not stop the others.
   */
  onInterrupt(handler: () => void): () => void;
  /** Emit an assistant delta to the host (event.stream-chunk). */
  emitChunk(chunk: StreamChunk): Promise<void>;
  /** Close a turn: ships the transcript delta, emits the turn-ends. */
  endTurn(input: EndTurnInput): Promise<void>;
  /**
   * Publish a transcript the loop deliberately REWROTE, replacing the host's
   * stored copy with what the source holds now.
   *
   * For loops whose transcript only ever grows this never gets called; the
   * per-turn delta is the whole protocol. The caller today is the aisdk
   * runner's rung-3 compaction, which summarizes the middle of a long
   * conversation and hands back a shorter list (design §7). Call it right
   * after adopting such a rewrite and before the next model call, so the
   * shortened transcript is what a resume would find.
   *
   * BEST-EFFORT BY CONTRACT: it does not throw. A failed replace leaves the
   * host holding the pre-rewrite transcript, and the next `endTurn` delta
   * cannot match its prefix hash — so the resync path re-ships the whole thing
   * anyway. Failing the turn over a bookkeeping call whose own fallback is
   * already in place would be the wrong trade.
   */
  replaceTranscript(): Promise<void>;
  /** Record recent assistant text for the bounded final `event.chat-end` outcome. */
  recordAssistantText(text: string): void;
  /** The transcript session id in effect (resume id, or the loop's own). */
  getTranscriptSessionId(): string | null;
  /** Report the transcript session id the loop minted. */
  setTranscriptSessionId(sessionId: string): void;
  /**
   * Report that the model consumed the message `nextMessage()` handed out
   * under `id` (TASK-708). Call it when the SDK acknowledges the message, not
   * when the loop forwards it: the point is to learn WHICH turn answered it.
   *
   * A message consumed into a turn that runs under a different reqId was
   * folded into that turn, and will never get a turn-end of its own. The shell
   * lists it on that turn's turn-ends (`foldedReqIds`) so the host can stop
   * waiting on it. Unknown or repeated ids are ignored. A loop whose model
   * never folds (one message, one turn) need not call it.
   */
  markMessageConsumed(id: string): void;
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
   * Loop-specific session setup, run once at boot right after the session
   * config arrives. Where a loop lays down what it needs before it starts —
   * the claude-sdk loop links the SDK's projects dir to the sandbox's
   * transcripts root. It runs before the resume restore writes the rebuilt
   * transcript there (#1085), and a failure is bootstrap-fatal (exit 2, no
   * `event.chat-end`).
   */
  prepareSession?: (env: RunnerEnv) => Promise<void>;
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

  // TASK-994 (design §11): the SDK loads $CLAUDE_CONFIG_DIR as its own trusted
  // configuration, so it must not overlap the agent's home. Checked before
  // every other boot step — in particular before the installed-skills
  // materialization below writes into $CLAUDE_CONFIG_DIR/skills.
  try {
    await assertConfigDirOutsideAgentHome(env);
  } catch (err) {
    process.stderr.write(
      `runner: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  // TASK-995: the home is the agent's cwd and the only place its work persists,
  // and the sandbox mounts it before starting the runner. Without it every
  // file the agent writes would fail (or, were anything to create the path,
  // land on disk that dies with the pod), so refuse to start rather than run
  // an agent that cannot keep anything. Never created here.
  const home = runnerHomeDir(env);
  let homeIsDir = false;
  let homeErr = 'not a directory';
  try {
    homeIsDir = (await fs.stat(home)).isDirectory();
  } catch (err) {
    homeErr = (err as NodeJS.ErrnoException).code ?? String(err);
  }
  if (!homeIsDir) {
    process.stderr.write(
      `runner: refusing to start: the agent's home (${home}) is not an existing directory (${homeErr}). ` +
        'The sandbox mounts it before starting the runner, so a missing one means the sandbox is misconfigured.\n',
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

  // Whatever the loop needs laid down before it starts — the claude-sdk loop
  // links the SDK's projects dir to the sandbox's transcripts root. Loop-shaped
  // by nature (it knows where its SDK writes), so it is a seam. Bootstrap-fatal:
  // a loop that cannot find its own transcript would resume nothing. It runs
  // before the resume restore below writes the rebuilt transcript (#1085).
  try {
    if (seams.prepareSession !== undefined) {
      await seams.prepareSession(env);
    }
  } catch (err) {
    process.stderr.write(
      `runner: session preparation failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await client.close();
    return 2;
  }

  // Create a session-scoped Python venv in the scratch root so the agent's
  // `pip install` + `import` Just Work. The image bakes a relocatable, pre-
  // seeded venv template; scaffoldPythonVenv copies it into the scratch root
  // OFFLINE (~1s) — see python-venv.ts. (Fallback when no template is baked:
  // an online `uv venv --seed`, which fetches from pypi and is slow/may hang
  // when pypi egress is denied — local dev only.)
  //
  // BOUNDED-WAIT (and never fatal — a venv failure must NOT abort the
  // session): we wait up to `venvReadyWaitMs` so the fast baked-template copy
  // resolves before the FIRST turn (so its `pip` is on PATH), while the slow
  // online fallback (or a hung uv) exceeds the budget and stays non-blocking —
  // `pythonVenvReady` flips when/if it later succeeds, and turns before then
  // simply skip the venv env wiring (opt-in via `pip install`). This bound is
  // what keeps a denied-pypi fallback from stalling the cold-start turn.
  // AX_VENV_READY_WAIT_MS tunes it (tests set 0 to assert non-blocking).
  let pythonVenvReady = false;
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

  // TASK-995: copy the bound conversation's uploads into `<scratch>/uploads/`,
  // flat (`report.pdf`, `report (2).pdf`), so the agent can open them. The blob
  // store stays the source of truth; this is a working copy, and translation
  // re-checks a copy's hash before using it as the person's file (see
  // materialize-uploads.ts and attachment-translation.ts). Best-effort: a
  // missing blob or failed copy is skipped, never fatal — the download route
  // still serves it, and the model is told the file could not be loaded.
  //
  // `knownUploads` maps each copied attachment id to its copy. A later message
  // that names an id not in it (a new upload on a warm runner) triggers another
  // call, which copies only what is new and keeps every name already given out.
  // Calls are serialized, so two pulls can never copy one upload twice under
  // two names: LoopContext does not forbid a loop from pulling twice at once,
  // (pinned by the "serializes overlapping copies" test). Gated on a bound conversation: a session without one has no
  // uploads.
  const knownUploads = new Map<string, MaterializedUpload>();
  const uploadsDir = scratchUploadsDir(env.ephemeralRoot);
  let uploadsChain: Promise<void> = Promise.resolve();
  const materializeUploadsForConversation = (): Promise<void> => {
    const run = uploadsChain.then(async () => {
      if (conversationId === null) return;
      const before = knownUploads.size;
      try {
        await materializeUploads({
          client,
          conversationId,
          uploadsDir,
          known: knownUploads,
          warn: (msg) => process.stderr.write(`${msg}\n`),
        });
      } catch (err) {
        // materializeUploads is best-effort and shouldn't throw, but never let
        // a surprise abort the boot or the turn.
        process.stderr.write(
          `runner: upload materialization error (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
      const added = knownUploads.size - before;
      if (added > 0) {
        process.stderr.write(`runner: copied ${added} upload(s) into ${uploadsDir}\n`);
      }
    });
    uploadsChain = run.catch(() => undefined);
    return run;
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

  // Phase E (2026-05-09): the replay-at-boot path is gone. The runner-local
  // transcript is the SDK's own jsonl under `$CLAUDE_CONFIG_DIR/projects`
  // (or the sandbox's transcripts root it links to); the host store is the
  // source of truth, rebuilt into that file on resume. The runner
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

  // Catalog hygiene: drop tools the agent's tool policy DENIES (frozen onto
  // `agentConfig.disallowedTools` by the orchestrator). Enforcement stays
  // host-side on tool:pre-call — this only keeps the model from being offered
  // a tool it will be refused. Absent (older session rows) = no extra denies.
  const disallowed = agentConfig.disallowedTools ?? [];
  if (disallowed.length > 0) {
    const deny = new Set(disallowed);
    tools = tools.filter((t) => !deny.has(t.name));
  }

  // TASK-67: the runner-local resume-transcript ship state, threaded across
  // turns. `sentOffset` is the transcript byte offset already shipped to the
  // host store; `sentSeq` is the host's row count (max seq). Fresh boot starts
  // at {0,0}; a resume seeds it from the rebuilt transcript (set in the F2a
  // block below, after restoreTranscriptForResume runs).
  let transcriptShipState: TranscriptShipState = { sentOffset: 0, sentSeq: 0 };

  // Phase 2: sandbox-MCP bridge. The local-dispatcher holds executors for
  // tools marked `executesIn: 'sandbox'` (`artifact_publish`, `skill_propose`).
  const localDispatcher = createLocalDispatcher();
  if (tools.some((t) => t.name === ARTIFACT_PUBLISH_TOOL_NAME && t.executesIn === 'sandbox')) {
    // TASK-68: the executor streams artifact bytes to the host blob store
    // (blob.put) + records the metadata row (artifact.publish), so it needs the
    // IPC client + the bound conversationId.
    //
    // It also needs the session's REAL roots, because the allowlist validates
    // against them rather than against hardcoded sandbox-absolute literals: the
    // home is publishable in full (the usual home of a deliverable) and the
    // scratch root only under `artifacts/` — never its uploads or transcripts.
    localDispatcher.register(
      ARTIFACT_PUBLISH_TOOL_NAME,
      createArtifactPublishExecutor({
        userFilesRoot: env.userFilesRoot,
        ephemeralRoot: env.ephemeralRoot,
        client,
        conversationId,
      }),
    );
  }
  // TASK-74 — skill_propose executor (sandbox-executed, like artifact_publish):
  // reads the agent's draft under `<home>/.skill-draft/<id>/`, validates it, and
  // ships it to the host gate over the skill.propose IPC action. The draft root is
  // the agent's home, so drafts persist across sessions (TASK-165 / §7); scope is
  // host-derived.
  if (tools.some((t) => t.name === SKILL_PROPOSE_TOOL_NAME && t.executesIn === 'sandbox')) {
    localDispatcher.register(
      SKILL_PROPOSE_TOOL_NAME,
      createSkillProposeExecutor({ userFilesRoot: env.userFilesRoot, client }),
    );
  }

  const inbox = createInboxLoop({ client });

  // Phase 2: whether the loop's provider accepts `document` content blocks.
  // A per-loop capability (each SDK pin answers differently), so the loop
  // declares it; conservative default false.
  const SUPPORTS_DOCUMENT_BLOCKS = seams.supportsDocumentBlocks ?? false;

  // Phase C: bind the loop's session_id to our conversation row.
  //
  // The loop keeps a transcript under that session id (the claude-sdk loop's
  // jsonl under the sandbox's transcripts root; the host store is its source
  // of truth). We capture the session_id the loop reports and POST it to the
  // host so a future runner can `resume(sessionId)` — read back via the
  // runnerSessionId field on the next session.get-config response (Phase E).
  // When the bind happens is `bindRunnerSessionIfNeeded`'s business (F2a:
  // only once the transcript is durable on the host).
  //
  // Once-only: a loop can re-emit init on a resume path. Only the FIRST bind
  // is load-bearing.
  //
  // Non-fatal unless the host refuses outright: if the bind fails transiently,
  // the next ship retries it; at worst a later runner starts a fresh session
  // instead of resuming. The chat itself continues uninterrupted.
  let runnerSessionIdSent = false;
  // Host-side bookkeeping for the final event.chat-end outcome. The loop's SDK
  // maintains its OWN transcript internally; this array is only the shape
  // the host cares about (user/assistant text round-tripped through
  // AgentMessage).
  const chatEndHistory = new ChatEndHistory();
  const logEventRefusal = (action: 'event.turn-end' | 'event.chat-end', error: unknown): void => {
    // IDs and a numeric status only. Never serialize the exception: its
    // message may contain a refused payload or the host's response body.
    try {
      process.stderr.write(JSON.stringify({
        event: 'ipc_event_refused', action, sessionId: env.sessionId.slice(0, 128),
        ...(currentReqId !== undefined ? { reqId: currentReqId.slice(0, 128) } : {}),
        ...(error instanceof IpcRequestError ? { status: error.status } : {}),
      }) + '\n');
    } catch { /* diagnostic failure must not fail a completed turn */ }
  };

  // Most-recent host-minted reqId from the inbox (J9). Set when a user
  // message arrives; read by `event.stream-chunk` emissions during the
  // assistant branch. Lifetime is "from the turn its message starts until
  // the next message's turn starts" (TASK-573: NOT from pull to pull — see
  // `adoptReqIdForTurn` below) — chunks for the SAME reqId may continue across
  // multiple turn boundaries (the loop may break a long response
  // into multiple turns), so we DO NOT clear this on turn-end. A chunk
  // that would emit before any user message has been pulled is impossible
  // by construction (no input → no output), but we defend anyway:
  // an unset reqId causes the chunk to be skipped (no `event.stream-chunk`
  // with a missing reqId — the host's router can't route it).
  let currentReqId: string | undefined;

  // TASK-573: a reqId belongs to the TURN its message starts, and a turn owns
  // it until its `endTurn` has emitted the turn-end — not merely until the next
  // inbox pull. Those are different moments for a loop that pulls ahead: the
  // Claude Agent SDK pumps its prompt iterable eagerly (`Query.streamInput` is
  // a bare `for await` into the CLI's stdin), so the loop's next
  // `nextMessage()` is already pending while a turn streams, and it resolves
  // the instant the inbox has something. When a person approves while the held
  // reply is still streaming, that something is the decision-resolved entry —
  // and adopting its reqId on the pull stamped the held turn's remaining
  // chunks AND its turn-end with the continuation's id. The SSE stream on that
  // id (which matches chat:turn-end on payload.reqId, #741) then closed on the
  // held turn's turn-end, before the continuation said a word.
  //
  // So a message pulled while a turn is active parks its reqId, and that
  // turn's `endTurn` hands it over after the last turn-end ships.
  //
  // What the shell can NOT assume is one `endTurn` per pulled message. The
  // Claude Code CLI folds a user message that arrives mid-turn into the
  // running turn (its `queued_command` attachment, drained at a tool
  // boundary), so two pulls can share one `result`. A counting scheme (park a
  // FIFO, hand one over per `endTurn`) would then run one message behind for
  // the rest of the session — every later turn stamped with the previous
  // message's id. So "active" is observed, not counted: a turn is active from
  // the moment it claims `currentReqId` (a pull that adopts at once, or its
  // first chunk) until its `endTurn`. After a hand-over nothing is active until
  // the next turn actually streams, so a message folded into the turn that
  // just ended costs nothing, and the next pull adopts at once. (Nothing here,
  // that is: the folded message's own reqId still gets no turn-end, which is
  // what `foldedReqIds` below answers — TASK-708.)
  //
  // One slot, latest wins: when several messages are pulled during one turn,
  // the CLI most likely folds them together, and the reply to the fold answers
  // the latest. `keep` is a message that carries no reqId of its own — it
  // inherits whatever id the turn would otherwise have, exactly as an
  // un-parked one does, so it never displaces a parked id.
  type ReqIdAdoption = { reqId: string | undefined } | 'keep';
  let turnActive = false;
  let parkedAdoption: ReqIdAdoption | undefined;
  function adoptReqIdForTurn(adoption: ReqIdAdoption): void {
    if (turnActive) {
      if (adoption !== 'keep' || parkedAdoption === undefined) parkedAdoption = adoption;
      return;
    }
    turnActive = true;
    interruptDelivered = false;
    if (adoption !== 'keep') currentReqId = adoption.reqId;
    // A turn is starting, and the loop may not pull again until it ends (the
    // aisdk loop does not). Keep a read outstanding so a Stop press is heard.
    if (!inboxSealed) void ensureRead();
  }
  function handOverReqIdAtTurnEnd(): void {
    if (parkedAdoption !== undefined && parkedAdoption !== 'keep') {
      currentReqId = parkedAdoption.reqId;
    }
    parkedAdoption = undefined;
    turnActive = false;
    interruptDelivered = false;
    foldedReqIds.clear();
  }

  // TASK-708: which turn ANSWERED a message, as opposed to which turn's id it
  // was stamped with. The hand-over above cannot tell a fold from a message
  // that will get its own turn next — both look like "a message was pulled
  // while a turn ran". The model's SDK can tell, so the loop reports each
  // message as it is consumed (`markMessageConsumed`), and a consumed message
  // whose reqId is not the current turn's was folded into this turn: it is
  // named on this turn's turn-ends, because it will never get one of its own.
  //
  // Observed, never inferred — the same rule as `turnActive`. A message that
  // gets its own turn is consumed AFTER the hand-over made its id current, so
  // it is never listed; one the SDK never reports is never listed either,
  // which is exactly today's behaviour.
  //
  // `messageReqIds` maps the id `nextMessage` minted to the message's reqId,
  // and only for messages that carry one. Bounded: a loop that never reports
  // consumption (one that cannot fold) would otherwise grow it for the life of
  // a warm runner. The oldest entry goes first; a message that old was
  // answered long ago.
  const MAX_TRACKED_MESSAGES = 64;
  const messageReqIds = new Map<string, string>();
  const foldedReqIds = new Set<string>();
  function trackMessage(reqId: string | undefined): string {
    const id = randomUUID();
    if (reqId === undefined) return id;
    messageReqIds.set(id, reqId);
    if (messageReqIds.size > MAX_TRACKED_MESSAGES) {
      const oldest = messageReqIds.keys().next().value;
      if (oldest !== undefined) messageReqIds.delete(oldest);
    }
    return id;
  }
  function markMessageConsumed(id: string): void {
    const reqId = messageReqIds.get(id);
    if (reqId === undefined) return;
    messageReqIds.delete(id);
    // Recorded even when it IS the current id, and filtered at emission: the
    // current id can still move before this turn closes (a message pulled
    // after the hand-over but before the next turn's first chunk adopts at
    // once), and then the consumed message is one this turn answered under
    // another name.
    foldedReqIds.add(reqId);
  }
  /** This turn's folded ids, for its turn-ends — never the turn's own id. */
  function foldedReqIdsForTurnEnd(): { foldedReqIds: string[] } | Record<string, never> {
    const ids = [...foldedReqIds].filter((id) => id !== currentReqId).slice(0, 64);
    return ids.length > 0 ? { foldedReqIds: ids } : {};
  }

  // ---- The single inbox reader, and `interrupt` (TASK-688) ------------------
  //
  // A person pressing Stop queues `{type:'interrupt'}` behind the message it
  // stops. Hearing it is the awkward part: the inbox cursor belongs to ONE
  // reader (two concurrent `inbox.next()` calls share it and would both be
  // handed the same entry), and the loops disagree about when they read. The
  // Claude Agent SDK pulls ahead, so a pull is always pending during its turn;
  // the aisdk loop reads once per turn and then streams. So the shell owns the
  // one reader:
  //
  //   - `nextMessage()` takes from `pulled`, and only when that is empty does it
  //     wait on a read.
  //   - While a turn is active the shell keeps a read outstanding even if the
  //     loop is busy, so an `interrupt` is routed within one long-poll round
  //     trip instead of after the turn it was meant to stop.
  //   - `interrupt` is consumed HERE and handed to `ctx.onInterrupt` handlers;
  //     no loop ever sees the entry, and it never resolves a pending pull.
  //     Everything else is buffered in arrival order.
  //
  // An interrupt read while NO turn is active is dropped: it is a Stop press
  // that lost the race with the turn's own ending, and it must not reach the
  // next turn. Read while a turn IS active but before the loop registered (the
  // cold-spawn deferral queues `[user-message, interrupt]` back to back), it is
  // latched and fires the moment a handler registers.
  //
  // `idle-timeout` needs care because the inbox loop's idle floor runs per
  // `next()` call, and a read that outlives a long turn hits it with nobody
  // waiting. Such an entry is discarded (and re-armed) rather than mistaken for
  // "the host is gone". A waiter only honours a floor from a read that STARTED
  // after it began waiting: otherwise a 14-minute turn would leave the runner
  // one minute of idle floor, not fifteen.
  const pulled: InboxLoopEntry[] = [];
  let readInFlight: Promise<void> | null = null;
  let readSeq = 0;
  let readFailure: { err: unknown } | null = null;
  let waiting = false;
  let waitBoundary = 0;
  // A `cancel` or an honoured `idle-timeout` is buffered: nothing after it is
  // deliverable, so stop reading ahead (also stops a fake that answers
  // `cancel` forever from spinning the watcher).
  let inboxSealed = false;
  let interruptDelivered = false;
  const interruptHandlers = new Set<() => void>();

  function ensureRead(): Promise<void> {
    if (readInFlight !== null) return readInFlight;
    const seq = ++readSeq;
    readInFlight = (async () => inbox.next())().then(
      (entry) => {
        readInFlight = null;
        routePulled(entry, seq);
      },
      (err: unknown) => {
        readInFlight = null;
        // Held for the loop's next pull: a terminal error (session invalid,
        // host gone after retries) is the loop's to hear, in the place it
        // always heard it, not an unhandled rejection in a watcher.
        readFailure = { err };
      },
    );
    return readInFlight;
  }

  function routePulled(entry: InboxLoopEntry, seq: number): void {
    if (entry.type === 'interrupt') {
      deliverInterrupt();
    } else if (entry.type === 'idle-timeout' && !(waiting && seq > waitBoundary)) {
      // Not an idle runner: discard (see above). Re-armed below.
    } else {
      pulled.push(entry);
      if (entry.type === 'cancel' || entry.type === 'idle-timeout') inboxSealed = true;
    }
    if (!inboxSealed && turnActive) void ensureRead();
  }

  async function takePulled(): Promise<InboxLoopEntry> {
    for (;;) {
      const head = pulled.shift();
      if (head !== undefined) return head;
      if (readFailure !== null) {
        const { err } = readFailure;
        readFailure = null;
        throw err;
      }
      waiting = true;
      waitBoundary = readSeq;
      try {
        await ensureRead();
      } finally {
        waiting = false;
      }
    }
  }

  function callInterruptHandler(handler: () => void): void {
    try {
      handler();
    } catch (err) {
      // One loop's Stop handler failing must not stop the others, and must
      // never take the runner down over a bookkeeping call.
      process.stderr.write(
        `runner: interrupt handler threw: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  function deliverInterrupt(): void {
    if (!turnActive) {
      process.stderr.write('runner: interrupt ignored (no turn in flight)\n');
      return;
    }
    // Once per turn: a double click must not stop the turn AFTER this one.
    if (interruptDelivered) return;
    interruptDelivered = true;
    process.stderr.write('runner: interrupt requested; stopping the turn\n');
    for (const handler of [...interruptHandlers]) callInterruptHandler(handler);
  }

  function onInterrupt(handler: () => void): () => void {
    interruptHandlers.add(handler);
    if (interruptDelivered && turnActive) {
      queueMicrotask(() => {
        if (interruptHandlers.has(handler)) callInterruptHandler(handler);
      });
    }
    return () => {
      interruptHandlers.delete(handler);
    };
  }

  // Inbox → loop user-message pull. Resolving null on cancel tells the loop no
  // more user messages are coming, which lets it drain naturally and exit.
  //
  // Phase E (2026-05-09): no more replay-from-DB. The SDK's
  // `resume(sessionId)` rehydrates the transcript from its own on-disk
  // store (`$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<sessionId>.jsonl`,
  // rebuilt from the host store on resume) when `runnerSessionId !== null`. This pull
  // surfaces only live inbox messages; prior turns are the loop's
  // responsibility to surface to the model.
  async function nextMessage(): Promise<LoopUserMessage | null> {
    for (;;) {
      const entry = await takePulled();
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
      if (entry.type === 'decision-resolved') {
        // AW-6. A call this agent held earlier has been answered by a person
        // while this session stayed warm. Start a turn whose opening message is
        // HOST-AUTHORED.
        //
        // The agent may now re-issue its held call — and we do not trust it to
        // reproduce that call faithfully, we CHECK. @ax/decisions holds a
        // standing approval keyed on the call fingerprint (AW-4), so an
        // unchanged call passes the gate exactly once and any change to it
        // holds again. This message is a prompt, never an authorisation.
        const content = decisionResolvedTurn(entry.note ?? '');
        if (content === null) {
          // Nothing to say. Waking the model with a blank prompt would burn a
          // turn and produce a reply about nothing; re-poll instead. (The wire
          // schema requires a non-empty note, so this is unreachable in
          // practice — it is the belt to that pair of braces.)
          process.stderr.write('runner: decision-resolved delivery had an empty note; ignoring\n');
          continue;
        }
        // Correlate this HOST-initiated turn. TASK-278: when the approval
        // carried a continuation id, a client IS waiting on a reqId now — the
        // open thread attached (or is attaching) a stream consumer to it — so
        // adopt it and every chunk and turn-end of this turn routes there.
        // Without one, clear the handle: no agent:invoke is in flight, and a
        // stale id (the previous turn's, already completed) would stamp chunks
        // at a closed door — worse than none, because `undefined` makes the
        // shell skip the emission outright (see `currentReqId` above) while
        // the turn's content still reaches the user via `event.turn-end`
        // through @ax/conversations' display event log.
        //
        // TASK-573: adopted at the turn boundary, not at this pull — see
        // `adoptReqIdForTurn`. A person who approves mid-reply is answered while
        // the held turn is still streaming, and those chunks are the held turn's.
        const continuationReqId =
          typeof entry.reqId === 'string' && entry.reqId.length > 0 ? entry.reqId : undefined;
        adoptReqIdForTurn({ reqId: continuationReqId });
        chatEndHistory.push({ role: 'user', content });
        return { content, id: trackMessage(continuationReqId) };
      }
      if (entry.payload === undefined) continue;
      // Capture the host-minted reqId so subsequent stream-chunk
      // emissions correlate back to the originating request. Both fields
      // are set on `user-message` entries by the InboxLoop layer. Adopted at
      // the turn boundary when a turn is still in flight (TASK-573).
      const messageReqId =
        typeof entry.reqId === 'string' && entry.reqId.length > 0 ? entry.reqId : undefined;
      adoptReqIdForTurn(messageReqId !== undefined ? { reqId: messageReqId } : 'keep');
      const hasBlocks =
        entry.payload.contentBlocks !== undefined &&
        entry.payload.contentBlocks.length > 0;

      // Warm-runner rebind (TASK-78, TASK-995): boot-time materialization only
      // covers uploads that existed when this runner started. When this turn
      // names an attachment with no copy yet, copy what is new before
      // translating. Uploads already copied are left exactly as they are.
      // Best-effort: the helper swallows its own errors, and translation tells
      // the model a file could not be loaded if it still has no copy.
      const needsUploads =
        hasBlocks &&
        entry.payload.contentBlocks!.some(
          (b) => b.type === 'attachment' && !knownUploads.has(b.attachmentId),
        );
      if (needsUploads) {
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
              uploads: knownUploads,
              supportsDocumentBlocks: SUPPORTS_DOCUMENT_BLOCKS,
            })),
          ]
        : userText;

      // The final event carries a bounded recent-text projection. Include a
      // short blocks summary rather than copying raw attachment bytes. Full
      // history remains in the persisted transcript/display log.
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

      return { content: messageContent, id: trackMessage(messageReqId) };
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
  // The transcript lives as rows in the host store (TASK-67), its source of
  // truth. So on resume we REBUILD the transcript from the store FIRST —
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
  // any, is the one the loop's transcript source finds on local disk.
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
  // after the host first ACCEPTS this transcript (an appended or resynced
  // turn-end ship) — NOT at the loop's init. Binding at init persisted
  // `runner_session_id` ~1s into the turn, BEFORE the transcript was durable on
  // the host. A turn killed in that window left a binding that points at
  // nothing, so the retry's `query({ resume })` crashed with "No conversation
  // found". Deferring the bind to a host-accepted ship makes
  // `runner_session_id` set IFF a resumable transcript exists → a turn killed
  // before its ship leaves it NULL → the retry starts fresh cleanly. Gated to
  // the fresh-boot case (`runnerSessionId` null); a resumed session is already
  // bound on the host.
  //
  // Failure handling distinguishes two cases:
  //   - definitive host rejection (4xx IpcRequestError — don't-retry per the
  //     IPC taxonomy): the conversation can't be bound to this id. The chief
  //     case is 409 conflict (HOOK_REJECTED) — the host already bound this
  //     conversation to a DIFFERENT id, a concurrent fresh-boot race in which
  //     another runner won; we are the loser and continuing to stream and ship
  //     under our orphan transcript would diverge the conversation. (404/400
  //     are likewise unrecoverable.) RE-THROW so the run terminates (host
  //     chat:end outcome `terminated`, surfaced by F2b) rather than silently
  //     shipping an orphan. The host's once-only bind invariant relies on
  //     the loser stopping here.
  //   - anything else (network / 5xx / timeout): transient — leave the flag
  //     unset so the next accepted ship (or the final one) retries; the
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
      // not retryable; terminate rather than orphan. 5xx was already retried by
      // the client.
      if (
        err instanceof IpcRequestError &&
        err.status >= 400 &&
        err.status < 500
      ) {
        throw err;
      }
      process.stderr.write(
        `runner: conversation.store-runner-session failed (will retry on the next transcript ship): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // filestore-user-files Phase 2 (TASK-164) — the agent's home.
  //
  // The loop's SDK subprocess runs with cwd + HOME = the durable per-agent
  // user-files mount (AX_USERFILES_ROOT, e.g. `/files`), so relative-path file
  // work, builds, `git clone .` and `~/bin` all land on durable NFS. TASK-995
  // made the mount required: there is no fallback home and no second tree the
  // runner manages. A file with a configuration-looking name (`CLAUDE.md`,
  // `.claude/settings.json`) is an ordinary file here that nothing loads: the
  // SDK reads settings only from CLAUDE_CONFIG_DIR, which
  // `assertConfigDirOutsideAgentHome` keeps out of the home.
  const homeDir = runnerHomeDir(env);
  // New files the turn left in the home are attached to it (the home is where
  // the notes tell the model to put finished files), BY REFERENCE (TASK-1012):
  // the chip names the file by its key in the agent's files and the person
  // downloads the file itself, live. No bytes move, so nothing is uploaded and
  // nothing is charged twice.
  //
  // Each chip still goes through the policy gate a model's own artifact_publish
  // call gets, so a person's "publish a file for you to open" setting means the
  // same for automatic chips: a denied or held call attaches nothing and never
  // sidesteps an approval. The gate's `updatedInput` is ignored on purpose: a
  // reference names the file the turn created, never a substitute.
  const generatedFilePolicy = createToolPolicy({ client });
  const canPublishGenerated = conversationId !== null &&
    localDispatcher.has(ARTIFACT_PUBLISH_TOOL_NAME);
  const generatedFiles = canPublishGenerated
    ? await trackGeneratedFiles({
        root: homeDir,
        warn: reason => process.stderr.write(`runner: could not attach a generated file (${reason})\n`),
        admit: async call => {
          const verdict = await generatedFilePolicy.preToolUse(call.name, call.input, call.id);
          if (verdict.decision !== 'allow') throw new Error('attachment not allowed');
        },
        attached: async (call, chip) => {
          await generatedFilePolicy.postToolUse(call.name, call.id, call.input, chip, false);
        },
      })
    : null;

  // Conversational-agent-identity (TASK-989): the prompt-engine composes the
  // system prompt for THIS spawn from the frozen session config — it reads no
  // files. `agentConfig.identity` carries the agent's identity and soul and its
  // people's Instructions from @ax/agents, plus the host's bootstrap-mode
  // decision (bootstrap pending AND a person present). Bootstrap mode is the
  // canonical bootstrap script then the Instructions; normal mode is the safety
  // floor + defaults + Instructions + identity + soul + evolution guidance (only
  // when `update_identity` survived the catalog filters above) + operational
  // notes. A session config without `identity` passes `undefined` and the
  // engine's default applies: normal mode with the displayName identity line.
  // `agentConfig.systemPromptAugment` carries the host `system-prompt:augment:*`
  // contributions, prepended on top in normal mode (and their bootstrap-safe
  // `rules` and `brief` sections, `systemPromptBootstrapAugment`, are prepended
  // in bootstrap mode). All of it is prose for the LLM, never interpolated into
  // shell, paths, or HTML. The identity and soul are model-written (untrusted
  // even though the host scans every write): the hardcoded safety floor sits
  // above them in normal mode and nothing in them can suppress it.
  const composedSystemPrompt = await buildSystemPrompt(
    agentConfig.displayName,
    agentConfig.systemPromptAugment,
    // The agent's home (its cwd) and the scratch root whose `uploads/` holds
    // the files people share in this conversation (TASK-995).
    homeDir,
    env.ephemeralRoot,
    pythonVenvReady,
    env.memoryRoot,
    // TASK-524: the bootstrap-safe slice of the augment (the kernel `rules`
    // and `brief` sections; people's Instructions now arrive in
    // `agentConfig.identity` instead, TASK-989), the ONLY augment content
    // bootstrap mode admits. Optional on the wire —
    // a session frozen before TASK-524 carries none, which means none.
    agentConfig.systemPromptBootstrapAugment ?? '',
    tools.some(tool => ['routine_list', 'routine_get', 'routine_create', 'routine_update', 'routine_delete', 'routine_fire_now'].includes(tool.name)),
    // TASK-989: the identity frozen at spawn — possibly absent (session rows
    // from before the field, or a host with no identity store).
    agentConfig.identity,
    // The evolution guidance names `update_identity`, so it follows the
    // FILTERED catalog: a session that isn't offered the tool (an unattended
    // run, a restrictive allow-list) is never told about it.
    tools.some((tool) => tool.name === UPDATE_IDENTITY_TOOL_NAME),
  );

  /**
   * `LoopContext.replaceTranscript` — see its doc comment for the contract.
   *
   * Deliberately does NOT bind the runner session (`bindRunnerSessionIfNeeded`)
   * even though it, like `endTurn`, makes the transcript durable. A rewrite can
   * only happen to a conversation that already has turns in it, which means the
   * bind already happened; calling it here would add a second, subtler path to
   * a piece of state whose whole point is that one path owns it.
   */
  async function replaceTranscript(): Promise<void> {
    if (transcriptSessionId === null || conversationId === null) return;
    try {
      const shipped = await replaceWholeTranscript({
        client,
        source: transcriptSource,
        sessionId: transcriptSessionId,
      });
      if (shipped.outcome === 'no-transcript') return;
      transcriptShipState = {
        sentOffset: shipped.sentOffset,
        sentSeq: shipped.sentSeq,
      };
      commitTrace(
        `[commit-trace] replaceTranscript → ${shipped.outcome} sentSeq=${shipped.sentSeq} sentOffset=${shipped.sentOffset}\n`,
      );
    } catch (err) {
      // Loud but not fatal. The state is left UNADVANCED on purpose: the next
      // `endTurn` then ships a delta whose `prefixHash` is computed over bytes
      // the source no longer has, the host disagrees, and the existing
      // resync-required path replaces the whole transcript. The safety net
      // catches the explicit path's failure, which is the whole reason it is
      // still there.
      process.stderr.write(
        `runner: transcript replace failed (${err instanceof Error ? err.message : String(err)}); ` +
          `the next turn's delta will resync\n`,
      );
    }
  }

  // The turn boundary. Every turn-end this turn emits is stamped with the
  // turn's own reqId, and only once the last has shipped does the next pulled
  // message's reqId take over (TASK-573). `finally`: a turn whose close threw
  // is still over, and the next one must not inherit its id.
  async function endTurn(input: EndTurnInput): Promise<void> {
    try {
      await closeTurn(input);
    } finally {
      handOverReqIdAtTurnEnd();
    }
  }

  async function closeTurn(input: EndTurnInput): Promise<void> {
    const explicitFiles = publishedAttachments(input.contentBlocks, input.toolResultBlocks);
    const generatedBlocks = await generatedFiles?.collect(explicitFiles.paths) ?? [];
    // Attach to the FIRST persisted turn-end: that is the one that closes SSE
    // and triggers the live client's history re-read. No new wire/event shape.
    const toolResultBlocks = [...input.toolResultBlocks, ...explicitFiles.blocks, ...generatedBlocks];
    try {
      commitTrace(
        `[commit-trace] per-turn result: session=${transcriptSessionId ?? 'null'} contentBlocks=${input.contentBlocks.length} toolResults=${input.toolResultBlocks.length} finalAsstUuid=${input.lastAssistantUuid ?? '-'}\n`,
      );
      // Let the loop wait for its own delayed transcript write to land so this
      // turn's closing reply is in the ship below.
      if (input.beforeTranscriptShip !== undefined) {
        await input.beforeTranscriptShip();
      }
      // TASK-67: ship the resume-transcript DELTA (the loop's transcript). The
      // new lines append as opaque rows in the host store, its source of truth,
      // O(1) per turn. The transcript is durable once the host accepts the
      // append/resync, so that is when the runner session binds (F2a).
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
    } catch (err) {
      // A 4xx IpcRequestError is a definitive host refusal (don't-retry per
      // the IPC taxonomy) — chiefly bindRunnerSessionIfNeeded's, when another
      // runner already bound this conversation. It is terminal: propagate it
      // past this best-effort catch so the run ends `terminated` instead of
      // silently orphaning.
      if (
        err instanceof IpcRequestError &&
        err.status >= 400 &&
        err.status < 500
      ) {
        throw err;
      }
      // Anything else (the loop's wait threw, the host was unreachable after
      // retries) is non-fatal: the next ship re-sends everything past the last
      // accepted offset, and the final ship after the loop drains is the
      // safety net.
      process.stderr.write(
        `runner: turn-end transcript ship failed: ${err instanceof Error ? err.message : String(err)}\n`,
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
    if (toolResultBlocks.length > 0) {
      // Ask for the TOOL turn's id in the host's own display-role vocabulary
      // — the same `role` this event carries. How a given loop stores a tool
      // turn (the Claude SDK echoes them back as `user` jsonl lines; the aisdk
      // runner stores them as role 'tool') is the loop's business, resolved
      // inside its `readTurnId`. Best-effort: undefined-on-miss is
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
          ? await input.readTurnId(transcriptSessionId, 'tool')
          : undefined;
      await client
        .event('event.turn-end', {
          reason: 'user-message-wait',
          role: 'tool',
          contentBlocks: toolResultBlocks,
          // Forward the inbox message's reqId so host-side per-request
          // subscribers (e.g., @ax/routines `pending.get(reqId)`) can
          // correlate this turn-end back to the originating request.
          // Without this the host fires `chat:turn-end` with the IPC
          // request's freshly-minted reqId, dead to those subscribers.
          ...(currentReqId !== undefined ? { reqId: currentReqId } : {}),
          ...(turnId !== undefined ? { turnId } : {}),
          // TASK-708: messages this turn answered that have no turn-end of
          // their own. On both turn-ends, like the reqId, so a subscriber
          // that acts on the first one sees them.
          ...foldedReqIdsForTurnEnd(),
        })
        .catch(error => logEventRefusal('event.turn-end', error));
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
    // Normalized at the last moment, on the assistant event ONLY: the role='tool'
    // turn-end above is the same turn's tool results, so metering both would
    // double-charge it. `undefined` (no usage / unusable model) sends no key.
    const turnUsage = normalizeTurnUsage(input.usage);
    await client
      .event('event.turn-end', {
        reason: 'user-message-wait',
        role: 'assistant',
        ...(input.contentBlocks.length > 0
          ? { contentBlocks: input.contentBlocks }
          : {}),
        ...(turnUsage !== undefined ? { usage: turnUsage } : {}),
        // See reqId rationale on the tool turn-end above.
        ...(currentReqId !== undefined ? { reqId: currentReqId } : {}),
        ...(assistantTurnId !== undefined ? { turnId: assistantTurnId } : {}),
        ...foldedReqIdsForTurnEnd(),
      })
      .catch(error => logEventRefusal('event.turn-end', error));
  }

  const ctx: LoopContext = {
    nextMessage,
    onInterrupt,
    emitChunk: async (chunk: StreamChunk): Promise<void> => {
      // Per-block streaming (Task 6 / J9). The loop forwards each block as
      // the model produces it; we ship it as `event.stream-chunk` so the
      // host's chat:stream-chunk subscriber (Task 5) can fan out to waiting
      // clients (Task 7). Failure is non-fatal: the host may be tearing down,
      // and the canonical transcript/display log still flows through the
      // transcript sync and event.turn-end. Untrusted (J2): the text is model output and reaches
      // the host verbatim — host-side renderers sanitize.
      // A chunk means a turn is streaming: from here a pulled message parks
      // (TASK-573). Marked before the skip — a turn with no id to route to is
      // still the turn in flight.
      turnActive = true;
      if (currentReqId === undefined) return;
      await client
        .event('event.stream-chunk', { reqId: currentReqId, ...chunk })
        .catch(() => {
          /* host may be tearing down; non-fatal */
        });
    },
    endTurn,
    replaceTranscript,
    recordAssistantText: (text: string): void => {
      chatEndHistory.push({ role: 'assistant', content: text });
    },
    getTranscriptSessionId: () => transcriptSessionId,
    setTranscriptSessionId: (sessionId: string): void => {
      transcriptSessionId = sessionId;
    },
    markMessageConsumed,
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

    // Final transcript ship: the loop's SDK subprocess may write the closing
    // assistant line AFTER yielding `result` to Node.js, so a per-turn ship can
    // race it. Shipping once more here — after the loop fully drains —
    // captures that tail.
    commitTrace('[commit-trace] for-await drained → final transcript ship\n');
    try {
      // TASK-67: `shipTranscriptDelta` is a noop when the per-turn ship already
      // sent everything (no new complete line past sentOffset).
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
      process.stderr.write(`runner: final transcript ship failed: ${err instanceof Error ? err.message : String(err)}\n`);
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
      ? { kind: 'complete' as const, messages: chatEndHistory.messages() }
      : {
          kind: 'terminated' as const,
          reason: (terminatedReason ?? 'unknown').slice(0, 4096),
          ...(terminatedError !== undefined ? { error: {
            name: terminatedError.name.slice(0, 128),
            message: terminatedError.message.slice(0, 4096),
            ...(terminatedError.stack !== undefined ? { stack: terminatedError.stack.slice(0, 8192) } : {}),
          } } : {}),
        };
  if (chatEndHistory.dropped > 0 || chatEndHistory.shortened > 0) {
    try {
      process.stderr.write(JSON.stringify({ event: 'chat_end_history_bounded', sessionId: env.sessionId.slice(0, 128), dropped: chatEndHistory.dropped, shortened: chatEndHistory.shortened }) + '\n');
    } catch { /* best-effort diagnostic */ }
  }
  await client
    .event('event.chat-end', { outcome })
    .catch(error => logEventRefusal('event.chat-end', error));
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
