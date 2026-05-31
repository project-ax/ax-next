import { PluginError, type AgentContext, type AgentMessage, type AgentOutcome, type HookBus } from '@ax/core';
// Shared `sandbox:open-session` contract. The orchestrator CONSTRUCTS the
// payload (it doesn't validate — trust comes from skills:resolve / agents:resolve
// having parsed upstream), so it imports the inferred TYPES only. Type-only
// imports across plugins are allowed (erased at compile time); this keeps the
// orchestrator's `AgentConfig` / `ProxyConfig` shapes pinned to the same
// definition the sandbox backends validate against. See @ax/sandbox-protocol.
import type { AgentConfig, ProxyConfig } from '@ax/sandbox-protocol';
import { foldAuthoredSkillCaps } from './authored-egress.js';
import { buildAuthoredCardPayload, authoredCardDedupKey, hasShownDelta } from './authored-card.js';
import {
  skillCredentialEnvName,
  projectEnvMapToBareNames,
} from './credential-namespace.js';
import {
  resolveEffectiveConnectors,
  foldConnectorCaps,
  connectorCredentialEnvName,
  type FoldConnectorResult,
} from './connector-union.js';

// ---------------------------------------------------------------------------
// @ax/chat-orchestrator — per-chat control plane
//
// Registers the host-side `agent:invoke` service hook. One agent:invoke call =
//
//   1. fire chat:start (veto-capable)
//   2. agents:resolve (Week 9.5 ACL gate)
//   3. Decide: route to existing live sandbox, or open fresh? (Task 16, J6)
//        - `ctx.conversationId` set AND its `active_session_id` is alive
//          → route into THAT session's inbox, skip sandbox:open-session.
//        - otherwise → open a fresh sandbox.
//   4. (fresh path) sandbox:open-session — bind IPC listener, spawn runner.
//        The sandbox plugin internally calls `session:create` to mint the
//        session + bearer token (the token flows only into the runner's
//        env, never back to us — I9). We do NOT call session:create here;
//        `session:create` is not idempotent on sessionId and a double-create
//        would throw `duplicate-session`. The orchestrator's contract with
//        the sandbox plugin is: "you own session minting, I own the chat
//        lifecycle above it."
//   5. conversations:bind-session (when ctx.conversationId set) — write
//        active_session_id + active_req_id atomically. The SSE handler
//        (Task 7) keys off active_req_id to find the in-flight stream.
//   6. session:queue-work — enqueue the initial user message
//   7. await chat:end event (runner-driven, via IPC server)
//   8. cleanup — kill handle if still alive (only on the fresh path)
//
// The IPC server (Task 4) fires `chat:end` when the runner POSTs
// /event.chat-end. The orchestrator's own subscriber captures the outcome
// and resolves the awaiting deferred. Error-ish paths (chat:start rejection,
// sandbox-open failure, queue-work failure, chat timeout, sandbox early
// exit) synthesize a terminated outcome and fire chat:end themselves —
// audit-log style subscribers always see exactly one chat:end per agent:invoke.
// Happy-path chat:end is fired by the IPC server, NOT the orchestrator;
// double-firing would double-count in audit-log.
//
// Invariants:
//   I1 — Hook payloads are backend-agnostic. Input is `{ message, maxTurns? }`,
//        output is AgentOutcome — no transport / storage vocabulary (no
//        runnerEndpoint, sessionId leakage, etc.). sessionId exists on
//        AgentContext already, which is the kernel-level primitive.
//   I5 — Capabilities explicit. The orchestrator only calls the exact hooks
//        in its manifest (session:queue-work / session:terminate /
//        sandbox:open-session). It does NOT spawn, it does NOT
//        touch the filesystem, it does NOT open sockets. Those are
//        sandbox-subprocess / ipc-server's jobs.
// ---------------------------------------------------------------------------

export const KNOWN_PROVIDERS = [
  {
    provider: 'anthropic' as const,
    name: 'Anthropic',
    slot: 'ANTHROPIC_API_KEY' as const,
    description: 'API key from console.anthropic.com.',
  },
] as const;

export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

export interface ChatOrchestratorConfig {
  // Absolute path to the runner's dist/main.js. Passed through to
  // sandbox:open-session — we don't validate here; the sandbox plugin does.
  runnerBinary: string;
  // Bounded wait for chat:end. Defaults to 10 min. If the runner crashes or
  // hangs without emitting chat-end, we synthesize a terminated outcome
  // after this elapses.
  chatTimeoutMs?: number;
  // One-shot mode (default true for 6.5a): on the first `chat:turn-end` the
  // orchestrator queues a `cancel` entry into the runner's inbox, so the
  // runner exits cleanly after processing the single user message and emits
  // its final `event.chat-end`. Callers driving multi-message sessions set
  // this to false and queue additional user messages themselves.
  //
  // Why this lives here: the runner is persistent by design (design doc
  // §"Runner comparison") so it can service future multi-message flows.
  // Week 6.5a's only caller (the CLI) is one-shot. Rather than bifurcate the
  // runner's behavior, the orchestrator owns the "this chat is done" signal.
  oneShot?: boolean;
  /**
   * Keepalive mode (default false). When true, a turn completes on
   * `chat:turn-end` and the runner is LEFT WARM instead of cancelled; a
   * per-session idle timer reaps it later (graceful cancel → force kill).
   * The channel-web/k8s preset sets this; the CLI canary stays one-shot.
   * Mutually exclusive in spirit with `oneShot` — when keepAlive is true the
   * one-shot cancel path is not taken.
   */
  keepAlive?: boolean;
  /** Idle window before the reaper queues a graceful cancel (ms). Default 5 min. */
  idleWindowMs?: number;
  /** Grace after the cancel before a force handle.kill() (ms). Default 10 s. */
  idleGraceMs?: number;
  /** System/built-in skills materialized into every session at LOWEST precedence
   *  (an explicit or default-attached skill of the same id wins). Empty by default. */
  builtinSkills?: ResolvedSkillForOrch[];
}

export interface AgentInvokeInput {
  message: AgentMessage;
  // Forwarded to the runner's turn loop eventually. For 6.5a the runner has
  // its own default; the orchestrator currently ignores maxTurns for dispatch
  // but preserves the field name so the shape lines up with Week 4-6's
  // chat-loop.ts caller contract.
  maxTurns?: number;
}

// JIT (design §7/§11.5) — apply a user-approved capability grant. All fields
// are domain identifiers (a `skillId` is a catalog id); NO backend vocabulary
// (sha/pod/socket/bucket/generation/session-row) and NO secret. The grant
// widens only the user's OWN sandbox by exactly the vetted skill's declared
// hosts/slots (decision #3); the secret lives in the host credential store
// (TASK-35) and never enters this payload, the model, the transcript, or SSE.
export interface ApplyCapabilityGrantInput {
  conversationId: string;
  userId: string;
  agentId: string;
  skillId: string;
}
export interface ApplyCapabilityGrantOutput {
  attached: boolean;
}

// Phase 4 PR-B — authored-grant I/O. Structurally mirrors channel-web's local
// copy (no cross-plugin import, I2). `applied:false, reason:'not-authored'`
// signals the channel-web route to fall back to the catalog grant path.
//
// FIX 1 (TOCTOU guard): `shown?` carries what the card displayed at render
// time. When present, the grant intersects the re-resolved current
// proposalDelta with `shown` before writing approval rows — so an agent that
// widens its draft between card render and user click can never sneak in caps
// the user never saw. Anything in the current delta but NOT in `shown` is
// silently skipped (it remains unapproved; the next spawn re-evaluates the
// now-smaller delta and fires its own card for the remainder). The server
// stays authoritative: a cap is approved IFF it is in the current proposal
// (re-resolved server-side) AND in `shown`. The client `shown` can only
// NARROW, never expand — anything not in the current proposal is rejected
// regardless.
export interface ApplyAuthoredCapabilityGrantInput {
  /**
   * The conversation whose warm session this grant retires (so the next turn
   * re-spawns with the now-approved caps). OPTIONAL (TASK-83): the in-chat card
   * always supplies it, but the My Skills "approve early" path has no
   * conversation — it approves a pending cap-skill BEFORE first use. When absent,
   * the grant still writes the approval rows + flips the skill active; it simply
   * skips the warm-session retire / live-widen (there's nothing live to widen),
   * and the user's next turn cold-spawns with the skill already approved.
   */
  conversationId?: string;
  userId: string;
  agentId: string;
  skillId: string;
  /** What the card displayed — absent ⟹ approve the full current delta (back-compat). */
  shown?: { hosts: string[]; slots: string[]; npm: string[]; pypi: string[] };
}
export type ApplyAuthoredCapabilityGrantOutput =
  | { applied: true; respawned: boolean }
  | { applied: false; reason: 'not-authored' };

// Shapes of the peer hooks we bus.call. Duplicated structurally on purpose —
// I2 forbids cross-plugin imports. Drift would surface as a runtime shape
// error at call time.
interface SessionQueueWorkInput {
  sessionId: string;
  // `reqId` on user-message entries is REQUIRED (J9): the runner stamps
  // it onto every `event.stream-chunk` so the host-side stream router
  // (Task 5/7) can deliver chunks back to the originating request. We
  // forward `ctx.reqId` from the agent:invoke call (which is itself the
  // host-handled request).
  entry:
    | { type: 'user-message'; payload: AgentMessage; reqId: string }
    | { type: 'cancel' };
}
interface SessionQueueWorkOutput {
  cursor: number;
}
interface SessionTerminateInput {
  sessionId: string;
}

// agents:resolve — registered by @ax/agents. The orchestrator hard-depends
// on this hook now; with the multi-tenant slice every chat goes through an
// agent, including dev/test paths (the test harness mocks the hook). I2:
// no @ax/agents import — the shape is duplicated here.
interface AgentsResolveInput {
  agentId: string;
  userId: string;
}
interface AgentRecord {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
  visibility: 'personal' | 'team';
  displayName: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  workspaceRef: string | null;
  /**
   * Phase 2 — egress allowlist. Hostnames the per-session proxy permits the
   * runner to reach (exact match). Empty/undefined means "no egress" (the
   * proxy denies every CONNECT/HTTP request that doesn't appear in the
   * list). The dev-agents-stub seeds `['api.anthropic.com']` so the SDK
   * runner can call Anthropic; production agents grow per-row allowlists
   * in Phase 9.5+.
   */
  allowedHosts?: string[];
  /**
   * Phase 2 — per-session credential refs. The orchestrator passes these
   * to `proxy:open-session`, which resolves each ref via `credentials:get`
   * and registers a `ax-cred:<hex>` placeholder in the listener's
   * substitution registry. The runner only ever sees the placeholder
   * inside its env map (I1: real credentials never enter the sandbox).
   */
  requiredCredentials?: Record<string, { ref: string; kind: string }>;
  /**
   * Phase 1 (skill-install) — admin-managed skills attached to this agent.
   * The orchestrator resolves each via `skills:resolve` before
   * `proxy:open-session` and unions their allowedHosts + merges
   * credentialBindings into the proxy call. Empty/absent means no
   * installed skills (back-compat for older agent rows that pre-date
   * the skill_attachments column).
   */
  skillAttachments?: Array<{
    skillId: string;
    credentialBindings: Record<string, string>;
  }>;
}
interface AgentsResolveOutput {
  agent: AgentRecord;
}

// skills:resolve — registered by @ax/skills. Duplicated structurally per I2
// (no @ax/skills import). The orchestrator calls this when the agent has
// skillAttachments and the service is registered.
interface SkillsResolveInput {
  skillIds: string[];
  /** When provided, user-scoped skills for this user override same-id globals. */
  ownerUserId?: string;
}
// Structural mirror of @ax/skills McpServerSpec (I2 — no cross-plugin imports).
// The orchestrator does NOT re-validate; trust comes from skills:resolve having
// already parsed the manifest. The sandbox schemas (k8s + subprocess) do the
// boundary re-validation downstream.
interface McpServerSpecForOrch {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  allowedHosts: string[];
  credentials: Array<{ slot: string; kind: string; description?: string; account?: string }>;
}
export interface ResolvedSkillForOrch {
  id: string;
  capabilities: {
    allowedHosts: string[];
    credentials: Array<{ slot: string; kind: string; description?: string; account?: string }>;
    mcpServers: McpServerSpecForOrch[];
    packages?: { npm?: string[]; pypi?: string[] };
  };
  bodyMd: string;
  manifestYaml: string;
  // JIT Phase 1a — extra (non-SKILL.md) bundle files from skills:resolve.
  // Optional + `?? []` at the construction site for back-compat with a
  // skills:resolve impl that predates the bundle field.
  files?: { path: string; contents: string }[];
}
interface SkillsResolveOutput {
  skills: ResolvedSkillForOrch[];
}

// agents:resolve-authored-skills — registered by @ax/agents (Phase 3 A2).
// Returns the agent's own self-authored draft skills (quarantine-filtered,
// EMPTY capabilities — instruction-only; lazy approval is Phase 4). Duplicated
// structurally per I2 (no @ax/agents import). Conditionally called via
// bus.hasService — NOT declared in the manifest, same convention as
// skills:resolve / skills:list-defaults.
/** Authored-draft projection mirror (structurally mirrors @ax/agents'
 * AuthoredResolvedSkill — NOT an import, per invariant #2). Adds the Phase-4
 * fields the orchestrator consumes: `proposalDelta` (the unapproved remainder,
 * drives the upfront card) and `description` (the card body). `capabilities` is
 * the APPROVED subset PC-1 folds into egress. */
export interface AuthoredResolvedSkillForOrch extends ResolvedSkillForOrch {
  proposalDelta: ResolvedSkillForOrch['capabilities'];
  description: string;
  /** Gate verdict (TASK-76, §D3). Only `active` skills materialize their bytes
   * into the spawn union; a `pending` skill projects NOTHING (no body, no
   * name/description in context, no caps) but still drives the approval card —
   * the card reads description+proposalDelta, never bodyMd, so withholding the
   * body doesn't break it. Optional for back-compat with an agents projection
   * that predates the field (defaults to `active`, the pre-TASK-76 behavior). */
  status?: 'active' | 'pending';
}
interface AgentsResolveAuthoredSkillsOutput {
  skills: AuthoredResolvedSkillForOrch[];
}

// skills:list-user-attachments — registered by @ax/skills (TASK-33).
// Duplicated structurally per I2 (no @ax/skills import). Conditionally called
// via bus.hasService — NOT declared in the manifest, same convention as
// skills:resolve / skills:list-defaults.
interface SkillsListUserAttachmentsInput {
  userId: string;
  agentId: string;
}
interface SkillsListUserAttachmentsOutput {
  attachments: Array<{ skillId: string; credentialBindings: Record<string, string> }>;
}

// proxy:* shapes — duplicated structurally per I2. The orchestrator does
// NOT import from @ax/credential-proxy; calls flow through bus.call.
interface ProxyOpenSessionInput {
  sessionId: string;
  userId: string;
  agentId: string;
  /** Hostnames this session may reach (exact match). */
  allowlist: string[];
  /** envName → { ref to credentials store, kind hint for downstream policy }. */
  credentials: Record<string, { ref: string; kind: string }>;
}
interface ProxyOpenSessionOutput {
  /** `unix:///path/to/sock` OR `tcp://127.0.0.1:<port>` — translated below. */
  proxyEndpoint: string;
  /** Root CA cert PEM the sandbox must trust. */
  caCertPem: string;
  /** envName → opaque placeholder token (`ax-cred:<32-hex>`). */
  envMap: Record<string, string>;
  /**
   * Per-session proxy token (TASK-52). Threaded onto `proxyConfig` so the
   * sandbox carries it as Proxy-Authorization for egress attribution.
   * Attribution label only — never an authz input. Optional for back-compat
   * with a proxy plugin build that predates the token.
   */
  proxyAuthToken?: string;
}
interface ProxyCloseSessionInput {
  sessionId: string;
}

// Public subset of @ax/credential-proxy's `event.http-egress` payload the
// reactive egress wall (TASK-37) keys off. Re-declared locally (I2 — no
// cross-plugin import); only the storage-agnostic fields we read. The proxy's
// full HttpEgressEvent carries more, but a subscriber must never key off
// backend-specific fields — `host`/`sessionId`/`blockedReason` are all public.
interface HttpEgressEventLike {
  sessionId: string;
  userId: string;
  host: string;
  blockedReason?:
    | 'allowlist'
    | 'private-ip'
    | 'canary'
    | 'tls-error'
    | 'request-body-too-large';
}

// Minimal structural view of @ax/core's `WorkspaceDelta` — the B3
// workspace:applied subscriber only reads the committing session and the
// changed paths. Structural (no @ax/core type import) per the file's
// hook-payload-shape convention; @ax/core's WorkspaceDelta is the canonical
// shape, validated upstream at the fire site.
// TASK-74 — the `skills:proposed` notify the host fires after a successful
// skills:propose write. Storage-agnostic ids; the orchestrator marks the
// PROPOSING session (read from ctx.sessionId, stamped by the IPC server from the
// runner's bearer token) for re-spawn next turn. Re-declared here per I2 (no
// @ax/skills import); the field shape mirrors @ax/skills' SkillsProposedEvent.
interface SkillsProposedLike {
  ownerUserId: string;
  agentId: string;
  skillId: string;
  status: 'active' | 'pending' | 'quarantined';
}

// AgentConfig (sent through sandbox:open-session and persisted on the session
// row) now comes from @ax/sandbox-protocol (type-only import above). The
// session-postgres / session-inmemory plugins declare the same shape; drift is
// caught at the bus call site.

// conversations:* shapes — Week 10–12 Tasks 14 + 16. Duplicated here per I2
// (no cross-plugin imports). The orchestrator reads `activeSessionId` to
// decide whether to route the message into an existing sandbox session or
// open a fresh one, and binds the conversation row on either path.
interface ConversationsGetInput {
  conversationId: string;
  userId: string;
}
interface ConversationsGetOutput {
  conversation: {
    conversationId: string;
    userId: string;
    agentId: string;
    activeSessionId: string | null;
    activeReqId: string | null;
  };
}
interface ConversationsBindSessionInput {
  conversationId: string;
  sessionId: string;
  reqId: string;
}
type ConversationsBindSessionOutput = void;

// session:is-alive — Task 16 (J6). Host-internal liveness probe registered
// by both session backends. True iff the row exists and `terminated = false`;
// nonexistent sessionIds return `{ alive: false }` (no throw).
interface SessionIsAliveInput {
  sessionId: string;
}
interface SessionIsAliveOutput {
  alive: boolean;
}

// system-prompt:augment — registered by @ax/memory-strata (Phase 2B), and
// potentially other plugins in the future (personalization, tenant policy).
// Returns markdown contributions that the orchestrator prepends to the
// system prompt envelope before fresh-spawning the sandbox.
//
// Single-provider service hook (one registration); the orchestrator dispatches
// only when `bus.hasService('system-prompt:augment')`. When absent, the
// orchestrator is a no-op — no augmentation, identical to today.
//
// Note: augmentation applies ONLY on the fresh-spawn path. The routed-into-
// existing-sandbox path reuses the originally-frozen `agentConfig.systemPrompt`
// that was baked into the runner's session at first spawn — re-augmenting
// mid-conversation would silently shift the prompt under the running agent,
// which neither matches caller expectations nor improves anything (the
// runner already has its prompt context).
// Provider reads from ctx (userId, agentId, sessionId, etc.) — payload is empty.
type SystemPromptAugmentInput = Record<string, never>;
interface SystemPromptAugmentOutput {
  contributions: Array<{ source: string; body: string }>;
}

/**
 * Proxy-session blob threaded from the orchestrator into the sandbox plugin.
 * The orchestrator opens a `proxy:open-session` BEFORE `sandbox:open-session`
 * (when @ax/credential-proxy is loaded) and packs the resolved endpoint, CA
 * cert PEM, and per-session credential placeholder envMap into this shape.
 *
 * The shape (`ProxyConfig`) is the shared `sandbox:open-session` contract from
 * @ax/sandbox-protocol (type-only import above). Field naming is deliberately
 * backend-agnostic (I3): `endpoint` (TCP loopback, subprocess) and
 * `unixSocketPath` (k8s) are mutually exclusive — `endpointToProxyConfig`
 * below sets exactly one, which is exactly what the shared schema's refine
 * enforces at the sandbox boundary. `caCertPem` is the PEM bytes; the sandbox
 * plugin owns "where on disk to write this." The orchestrator never knows.
 */
// (ProxyConfig type imported from @ax/sandbox-protocol — see import above.)

interface InstalledSkillForSandbox {
  id: string;
  /**
   * JIT Phase 1a — the skill bundle as a FILE TREE. The first file is the
   * reconstructed `SKILL.md` ('---\n' + manifestYaml + '---\n' + bodyMd);
   * any extra (non-SKILL.md) files resolved from the store ride after it.
   * Replaces the former single `skillMd` string so a skill can carry scripts /
   * data / templates, not just instructions.
   */
  files: { path: string; contents: string }[];
  /**
   * Phase B (capabilities.mcpServers) — bundled MCP servers declared by the
   * skill's manifest. Sandbox plugins materialize one `.mcp.json` per skill
   * alongside SKILL.md so the SDK auto-discovers bundled MCP servers via
   * its `'project'` setting source. Empty array when the manifest omits
   * `capabilities.mcpServers` — every entry stays grouped per-skill (no
   * cross-skill union; the `.mcp.json` shape is per-directory).
   */
  mcpServers: McpServerSpecForOrch[];
  /**
   * TASK-14 (CLI-1 part 2) — the skill's top-level `capabilities.allowedHosts`
   * + `capabilities.credentials` slots, forwarded so the runner can wire
   * skill-declared credentials into `git`'s HTTP Basic auth (a host-scoped
   * `url.<base>.insteadOf` rewrite carrying the `ax-cred:<hex>` placeholder for
   * each credentialed host). Without this, `git clone https://<host>/...` over
   * the proxy bails with "could not read Username" because git — unlike the
   * model's explicit `$SLOT` curl usage — never sends the placeholder. Only the
   * opaque placeholder is wired (real secrets stay host-side, I1); the rewrite
   * is scoped to the declared hosts only (I5). The orchestrator already has
   * both arrays from `skills:resolve`; threading them avoids re-parsing the
   * SKILL.md YAML at the runner's trust boundary.
   */
  allowedHosts: string[];
  /**
   * TASK-86 — `slot` is the BARE env-var name the skill reads (e.g.
   * `LINEAR_API_KEY`); `placeholder` is the skill's OWN resolved
   * `ax-cred:<hex>` token, threaded so git HTTP-Basic wiring uses the skill's
   * own credential even when another skill won the flat-env stamp for the same
   * bare name. Optional + back-compat: when absent, git wiring falls back to
   * `envMap[slot]` (the pre-TASK-86 path).
   */
  credentials: Array<{ slot: string; kind: 'api-key'; placeholder?: string | undefined }>;
}

interface OpenSessionInput {
  sessionId: string;
  workspaceRoot: string;
  runnerBinary: string;
  /**
   * Owner triple — userId / agentId / agentConfig. Resolved by the
   * orchestrator from agents:resolve and forwarded through the sandbox
   * plugin so the v2 session row can be written atomically with the
   * session itself. The runner reads this back via session:get-config
   * (Task 6d). `conversationId` is forwarded the same way when the
   * inbound request carried one (channel-web SSE flow); the runner uses
   * it to choose resume-vs-fresh-spawn without a separate lookup.
   */
  owner: {
    userId: string;
    agentId: string;
    agentConfig: AgentConfig;
    conversationId?: string;
  };
  /**
   * Per-session proxy blob. Populated only when @ax/credential-proxy is
   * loaded; otherwise undefined and sandbox:open-session injects no
   * proxy env, leaving the runner to fail at boot when no AX_PROXY_* is
   * set. Presets that want a working runner load @ax/credential-proxy.
   */
  proxyConfig?: ProxyConfig;
  /**
   * Phase 1 (skill-install) — installed-skill SKILL.md files to materialize
   * inside the sandbox at $CLAUDE_CONFIG_DIR/skills/<id>/SKILL.md. The
   * sandbox plugin writes them BEFORE spawning the runner; the SDK's
   * 'user' source discovers them at boot. Empty/absent means no skills
   * to materialize (Phase 0's empty skills/ dir is left as-is).
   */
  installedSkills?: InstalledSkillForSandbox[];
}
interface OpenSessionHandle {
  kill(): Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}
interface OpenSessionResult {
  // Opaque URI describing how the runner reaches the host. The orchestrator
  // never dereferences this — it's the runner's problem to parse the scheme
  // and dispatch transport. See @ax/sandbox-subprocess's open-session.ts
  // for the contract.
  runnerEndpoint: string;
  handle: OpenSessionHandle;
}

// ---------------------------------------------------------------------------
// Deferred — a Promise we can resolve/reject externally, with an idempotent
// `settled` guard. Using this (vs. wiring promise executors by hand) keeps
// the orchestrator flow readable.
// ---------------------------------------------------------------------------

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
  readonly settled: boolean;
}

function newDeferred<T>(): Deferred<T> {
  let resolveFn: (v: T) => void = () => undefined;
  let rejectFn: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  let settled = false;
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolveFn(value);
    },
    reject(err) {
      if (settled) return;
      settled = true;
      rejectFn(err);
    },
    get settled() {
      return settled;
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestrator instance. One Map-keyed-by-sessionId for in-flight waiters:
// chat:end subscriber looks up the session and resolves its deferred with
// the runner-emitted outcome. Keyed by sessionId (not reqId) because the
// IPC server's per-request ctx is built from the token → session lookup and
// carries the SAME sessionId that the orchestrator minted — that's the
// stable join key across the host ⇄ runner boundary.
// ---------------------------------------------------------------------------

export const PLUGIN_NAME = '@ax/chat-orchestrator';
const DEFAULT_CHAT_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// JIT smart-defaults (Part II §P4, TASK-51) — the always-on broker host-tools.
//
// `search_catalog` (read-only catalog search) + `request_capability`
// (shape-validated, human-in-the-loop capability request) ship in
// `@ax/skill-broker` (TASK-34/35) and are wired into presets/k8s. To make
// just-in-time capability acquisition a real DEFAULT, we lock them into every
// MULTI-TENANT agent's effective `allowedTools` at session-open below.
//
// I2 (no cross-plugin imports): the orchestrator deps are only `@ax/core` +
// `@ax/sandbox-protocol`, so these are a LOCAL mirror of the broker's
// `SEARCH_CATALOG_DESCRIPTOR.name` / `REQUEST_CAPABILITY_DESCRIPTOR.name` and
// @ax/tool-skill-propose's `SKILL_PROPOSE_TOOL_NAME` (the sources of truth) —
// duplicated structurally with this comment, the same posture TASK-34 used to
// mirror the candidate shape. `install_authored_skill` (the broker's open-mode
// 3rd tool, gated behind allow_user_installed_skills) is intentionally EXCLUDED.
//
// TASK-76: `skill_propose` is added here so a NON-WILDCARD tenant agent can
// author skills too. The descriptor is registered host-side via tool:register;
// a wildcard agent already sees the whole catalog (incl. skill_propose), but a
// non-wildcard agent sees only its explicit list + these always-on tools — so
// without this it could never invoke skill_propose. The host `skills:propose`
// gate (re-validate + scan + classify) is the real boundary; tool visibility
// isn't a grant.
const ALWAYS_ON_BROKER_TOOLS = ['search_catalog', 'request_capability', 'skill_propose'] as const;

/**
 * "default+locked" broker tools, computed at session-open (TASK-51).
 *
 * Returns the agent's `allowedTools` with the always-on broker tools unioned
 * in (append-only, order-stable, deduped) — UNLESS the agent's scope is the
 * empty-empty WILDCARD (`allowedTools` AND `mcpConfigIds` both empty), which
 * the tool-dispatcher scope filter (`@ax/mcp-client` `filterByAgentScope`)
 * already reads as "expose the entire catalog" (incl. the broker tools). For
 * a wildcard agent we return `allowedTools` UNCHANGED — injecting the names
 * would flip "see everything" into "see only the two broker tools", shrinking
 * the dev/single-tenant loop's reachable catalog (a regression).
 *
 * So: inject iff the scope is already non-wildcard. That is exactly the gap —
 * a multi-tenant agent that carries any explicit tool or MCP config currently
 * can't see the broker; a wildcard agent already can.
 *
 * "locked" falls out of this being a session-open UNION (not a stored value):
 * a tenant editing the agent row (e.g. PATCH /admin/agents removing a broker
 * tool) is overridden here at the next open. It does NOT imply a UI list entry
 * (TASK-46 — surfacing org-defaults as skill-list rows — was closed).
 */
export function withBrokerDefaults(
  allowedTools: readonly string[],
  mcpConfigIds: readonly string[],
): string[] {
  // Wildcard sentinel — leave it alone (see above). Mirrors the empty-empty
  // check in `@ax/mcp-client` `filterByAgentScope`.
  if (allowedTools.length === 0 && mcpConfigIds.length === 0) {
    return [...allowedTools];
  }
  const out = [...allowedTools];
  const present = new Set(allowedTools);
  for (const tool of ALWAYS_ON_BROKER_TOOLS) {
    if (!present.has(tool)) {
      out.push(tool);
      present.add(tool);
    }
  }
  return out;
}

export function createOrchestrator(
  bus: HookBus,
  config: ChatOrchestratorConfig,
): {
  runAgentInvoke(ctx: AgentContext, input: AgentInvokeInput): Promise<AgentOutcome>;
  onChatEnd(ctx: AgentContext, payload: { outcome: AgentOutcome }): Promise<void>;
  onTurnEnd(ctx: AgentContext, payload?: { reqId?: string }): void;
  onSessionTerminate(ctx: AgentContext, payload: { sessionId?: string }): Promise<void>;
  applyCapabilityGrant(
    ctx: AgentContext,
    input: ApplyCapabilityGrantInput,
  ): Promise<ApplyCapabilityGrantOutput>;
  applyAuthoredCapabilityGrant(
    ctx: AgentContext,
    input: ApplyAuthoredCapabilityGrantInput,
  ): Promise<ApplyAuthoredCapabilityGrantOutput>;
  onHttpEgress(ctx: AgentContext, payload: HttpEgressEventLike): Promise<void>;
  onSkillsProposed(ctx: AgentContext, event: SkillsProposedLike): Promise<void>;
} {
  // Waiters are tracked by ctx.reqId (server-minted, J9, unique per
  // agent:invoke). On the J6 routed path, two concurrent agent:invokes for the
  // same conversation share a sessionId — keying by sessionId would let
  // the second agent:invoke overwrite the first's waiter (causing the first
  // to time out and the second to resolve with the wrong outcome).
  //
  // Resolution paths:
  //   - chat:end fired by the orchestrator itself (error paths) carries
  //     the agent:invoke ctx → ctx.reqId matches directly.
  //   - chat:end fired by the IPC server (runner POSTs /event.chat-end)
  //     stamps a fresh per-request ctx.reqId, so the reqId lookup
  //     misses. We fall back via `reqIdsBySession`: when only one
  //     waiter exists for a given sessionId, resolve THAT waiter; when
  //     multiple exist (the routed-collision case), the reqId-keyed
  //     entry from the orchestrator self-fire wins. The fresh-spawn
  //     path always has exactly one waiter per sessionId.
  const waitersByReqId = new Map<string, Deferred<AgentOutcome>>();
  const reqIdsBySession = new Map<string, Set<string>>();
  // Reactive egress wall (TASK-37) — dedup raised host-grant cards per
  // (sessionId, host) so repeated 403s to the same blocked host don't spam the
  // stream with duplicate cards. Cleared per session in onSessionTerminate (the
  // session's egress is gone, so any future block under a reused id is new).
  const wallCardsByHost = new Map<string, Set<string>>(); // sessionId → hosts already carded
  // Phase 4 PR-B — upfront authored-skill approval cards already fired, keyed by
  // conversationId → set of shown-delta dedup keys. Conversation-scoped so it
  // SURVIVES a re-spawn within the conversation (do NOT clear on chat:end —
  // that's per-turn). Cleared by applyAuthoredCapabilityGrant on apply so a
  // post-approve spawn re-evaluates the smaller delta. In-memory, single-replica
  // (same posture as wallCardsByHost / respawnSessions).
  const upfrontCardsByConv = new Map<string, Set<string>>();
  // TASK-86 — the conversation that PROPOSED each still-pending authored skill.
  // A pending cap-skill's upfront "Connect …" card used to fire in EVERY
  // conversation (the projection resolves the user's pending skills on every
  // turn, regardless of conversation), so a single pending skill papered its card
  // across unrelated chats. We only fire a PENDING skill's card in the
  // conversation it was proposed in. Set in the skills:proposed subscriber (which
  // carries ctx.conversationId); evicted on approve / conversation-delete.
  // ACTIVE skills and catalog skills are unaffected. In-memory, single-replica
  // (same posture as upfrontCardsByConv / respawnSessions).
  const pendingSkillConversation = new Map<string, string>(); // skillId → conversationId
  function registerWaiter(
    sessionId: string,
    reqId: string,
    deferred: Deferred<AgentOutcome>,
  ): void {
    waitersByReqId.set(reqId, deferred);
    let set = reqIdsBySession.get(sessionId);
    if (set === undefined) {
      set = new Set();
      reqIdsBySession.set(sessionId, set);
    }
    set.add(reqId);
  }
  function unregisterWaiter(sessionId: string, reqId: string): void {
    waitersByReqId.delete(reqId);
    const set = reqIdsBySession.get(sessionId);
    if (set !== undefined) {
      set.delete(reqId);
      if (set.size === 0) reqIdsBySession.delete(sessionId);
    }
  }
  // Resolve the waiting deferred for a turn/chat completion. Prefer the
  // originating reqId; fall back to the session index (the IPC server stamps
  // a fresh ctx.reqId on runner-driven events, so the reqId lookup misses and
  // we resolve the oldest waiter for the session — FIFO matches emit order).
  //
  // Returns the ORIGINAL waiter reqId iff this call resolved a previously-
  // UNSETTLED waiter — i.e. this chat:end was the one that ended a turn the
  // caller/SSE was still waiting on (undefined otherwise). onChatEnd (F2b)
  // surfaces a turn-error keyed on this:
  //   - the original reqId lets it fire chat:turn-error with the PRECISE
  //     per-turn key even when the IPC server restamped ctx.reqId — so the SSE
  //     matches the exact turn, not the whole conversation (two concurrent
  //     invokes can share a sessionId — see the waiter-map comment above).
  //   - undefined (no live waiter) means a late chat:end — the chokepoint
  //     already settled the deferred + fired its own turn-error, or a reaped
  //     warm runner POSTed after a completed turn — so no (spurious) re-fire.
  function resolveWaiterFor(
    reqId: string | undefined,
    sessionId: string,
    outcome: AgentOutcome,
  ): string | undefined {
    let resolvedReqId = reqId;
    let deferred = reqId !== undefined ? waitersByReqId.get(reqId) : undefined;
    if (deferred === undefined) {
      const reqIds = reqIdsBySession.get(sessionId);
      if (reqIds !== undefined && reqIds.size > 0) {
        resolvedReqId = reqIds.values().next().value as string;
        deferred = waitersByReqId.get(resolvedReqId);
      }
    }
    if (deferred !== undefined && !deferred.settled) {
      deferred.resolve(outcome);
      return resolvedReqId;
    }
    return undefined;
  }

  // Fault A — signal the channel SSE that a turn ended abnormally (the
  // runner died mid-turn or wedged past the chat timeout) so the client
  // flips out of the "Thinking…" spinner into an error+retry state. Without
  // this the SSE only ever gets a terminal frame on a NORMAL chat:turn-end;
  // a terminated turn fires chat:end (audit) but no turn-end, so the stream
  // hangs forever (the 25 s SSE keepalive keeps it open). The subscriber is
  // @ax/channel-web's per-connection SSE handler, which matches by reqId — so
  // `reqId` must be the originating agent:invoke reqId. Every fire site honors
  // that: the chokepoints / session:terminate / early-spawn returns hold the
  // original ctx.reqId, and the F2b onChatEnd path passes the original reqId
  // that resolveWaiterFor recovered (ctx.reqId there is IPC-restamped).
  // Observation-only broadcast; a no-op when no SSE is attached.
  async function fireTurnError(
    ctx: AgentContext,
    reqId: string,
    reason: string,
  ): Promise<void> {
    // Log so operators can confirm the host detected the abnormal end and
    // signalled the client — the previously-silent path is what made Fault A
    // hard to diagnose. (The `reason` is orchestrator vocabulary, e.g.
    // `sandbox-terminated`; the matching `pod_exited`/`pod_killed` lines come
    // from the sandbox provider's own exit watcher.)
    ctx.logger.info('chat_turn_error', { reqId, reason });
    await bus.fire('chat:turn-error', ctx, { reqId, reason });
  }

  // Fault A (routed/warm path) — a sandbox that dies mid-turn re-broadcasts
  // session:terminate (the session store fires it after the teardown service
  // work; see session-postgres/session-inmemory). The fresh-spawn path
  // catches death promptly via handle.exited, but the routed path does NOT
  // watch exited (the handle isn't ours) — it would otherwise hang until the
  // 10-min chatTimeoutMs. So surface the error promptly for any in-flight
  // (unsettled) turn on this session.
  //
  // We do NOT resolve/reject the deferred here: the existing bounded-timeout
  // path still produces the single chat:end (audit invariant). The SSE
  // closes on the first error frame, so the later duplicate turn-error from
  // that timeout path is a harmless no-op. Completed turns whose waiter is
  // already settled (or unregistered) are skipped — no spurious error.
  async function onSessionTerminate(
    ctx: AgentContext,
    payload: { sessionId?: string },
  ): Promise<void> {
    const sessionId = payload?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const reqIds = reqIdsBySession.get(sessionId);
    if (reqIds === undefined) return;
    // Snapshot — fireTurnError must not be confused by concurrent mutation
    // of the live Set during the await.
    for (const reqId of [...reqIds]) {
      const deferred = waitersByReqId.get(reqId);
      if (deferred === undefined || deferred.settled) continue;
      await fireTurnError(ctx, reqId, 'sandbox-terminated');
    }
    // The session's egress is gone — drop its host-grant dedup set so a reused
    // sessionId starts fresh (TASK-37).
    wallCardsByHost.delete(sessionId);
    // If this session was marked dirty (draft-skills changed, awaiting re-spawn
    // next turn), prune it now — the session is gone so the entry would never
    // be consumed and would leak indefinitely.
    respawnSessions.delete(sessionId);
  }

  // Reactive egress wall (TASK-37) — turn an allowlist-MISS 403 into the
  // in-chat "Allow access to <host>?" card (design §6B, decision #4). The
  // credential proxy attributes blocked egress to its session via a per-session
  // proxy token (TASK-52), so `event.http-egress` carries a real sessionId. We
  // resolve it to the in-flight reqId(s) via reqIdsBySession — the SAME map
  // Fault A uses — and fire the TASK-35 `chat:permission-request` hook with the
  // host-grant variant, stamped with reqId so the SSE matches the precise turn
  // (the host variant matches by payload.reqId, like chat:turn-error; the skill
  // variant matches by ctx.conversationId). Observation-only: a no-op when
  // nothing is attributed (empty sessionId) or no turn is in flight. Dedups per
  // (session, host) so a tight retry loop on the same blocked host raises ONE
  // card. This never affects the egress allow/deny decision — the proxy already
  // returned 403; this only surfaces the option to grant.
  async function onHttpEgress(ctx: AgentContext, payload: HttpEgressEventLike): Promise<void> {
    if (payload?.blockedReason !== 'allowlist') return;
    const sessionId = payload.sessionId;
    const host = payload.host;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return; // unattributed
    if (typeof host !== 'string' || host.length === 0) return;
    const reqIds = reqIdsBySession.get(sessionId);
    if (reqIds === undefined || reqIds.size === 0) return; // no in-flight turn to surface on
    // Only raise a card if at least one in-flight (unsettled) waiter exists —
    // a settled-but-not-yet-unregistered reqId shouldn't surface a card on a
    // turn that's already done.
    const liveReqIds = [...reqIds].filter((reqId) => {
      const deferred = waitersByReqId.get(reqId);
      return deferred !== undefined && !deferred.settled;
    });
    if (liveReqIds.length === 0) return;
    let carded = wallCardsByHost.get(sessionId);
    if (carded === undefined) {
      carded = new Set();
      wallCardsByHost.set(sessionId, carded);
    }
    if (carded.has(host)) return; // already surfaced this host for this session
    carded.add(host);
    for (const reqId of liveReqIds) {
      ctx.logger.info('reactive_wall_card', { sessionId, host, reqId });
      // The bus isolates subscriber throws (HookBus.fire), so a misbehaving
      // SSE handler can't break the egress audit path.
      await bus.fire('chat:permission-request', ctx, {
        kind: 'host',
        host,
        sessionId,
        reqId,
      });
    }
  }

  // TASK-74 — skills:proposed subscriber. The host fires this after a successful
  // skills:propose write (the agent authored a skill THIS turn). A skill becomes
  // visible only at the NEXT spawn (the runner freezes the projection at spawn,
  // design §D6), so we MARK the proposing session dirty and let the next turn's
  // routing retire it + fresh-spawn (safe between turns; a mid-turn terminate
  // would hang the SSE — the Fault-A class bug). This REPLACES the old
  // workspace:applied `.ax/draft-skills` trigger (skill authoring left git).
  //
  // The proposing session is `ctx.sessionId` — the IPC server stamped the
  // runner's bearer-resolved session onto ctx before the skill.propose handler
  // ran, and skills:propose fires this notify on that same ctx. We mark on ANY
  // status: an `active` free-path skill must re-spawn to load; a `pending` skill
  // re-spawns after the approval grant ALSO terminates the warm session
  // (belt-and-suspenders — applyAuthoredCapabilityGrant already terminates on
  // approve, and marking here covers the case where the human approves on the
  // SAME turn boundary). A `quarantined` skill won't project, but a harmless
  // re-spawn is cheaper than special-casing.
  async function onSkillsProposed(
    ctx: AgentContext,
    event: SkillsProposedLike,
  ): Promise<void> {
    const sid = ctx.sessionId;
    if (sid !== undefined && sid.length > 0 && sid !== 'ipc-server') {
      respawnSessions.add(sid);
    }
    // TASK-86 — remember which conversation proposed a PENDING cap-skill so its
    // upfront "Connect …" card only fires there (not across every chat). An
    // `active` (free-path) skill needs no card; a `quarantined` one never
    // projects. Best-effort: needs a conversationId to scope against.
    const convId = ctx.conversationId;
    if (event.status === 'pending' && convId !== undefined && convId.length > 0) {
      pendingSkillConversation.set(event.skillId, convId);
    }
  }

  const chatTimeoutMs = config.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  const oneShot = config.oneShot ?? true;
  const keepAlive = config.keepAlive ?? false;
  const idleWindowMs = config.idleWindowMs ?? 5 * 60 * 1000;
  const idleGraceMs = config.idleGraceMs ?? 10 * 1000;
  // Sessions that have already been cancelled — prevents a second
  // chat:turn-end (from a misbehaving runner) from queueing a duplicate
  // cancel entry.
  const cancelledSessions = new Set<string>();

  // Keepalive: warm sandboxes whose runner is left alive between turns. The
  // entry outlives the agent:invoke that opened it; reaped by the idle timer
  // (Task 5), the runner floor, the force-kill, or the pod ceiling.
  interface WarmEntry {
    handle: OpenSessionHandle;
    idleTimer: ReturnType<typeof setTimeout> | null;
    graceTimer: ReturnType<typeof setTimeout> | null;
  }
  const warmSessions = new Map<string, WarmEntry>();
  function clearReapTimers(sessionId: string): void {
    const entry = warmSessions.get(sessionId);
    if (entry === undefined) return;
    if (entry.idleTimer !== null) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    if (entry.graceTimer !== null) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
  }

  function armReapTimer(ctx: AgentContext): void {
    const sessionId = ctx.sessionId;
    const entry = warmSessions.get(sessionId);
    // No warm handle (e.g. routed into a session this host process didn't
    // open — after a restart). Nothing to reap from here; the runner floor /
    // pod ceiling cover it.
    if (entry === undefined) return;
    clearReapTimers(sessionId);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      // Graceful first: queue a cancel so a HEALTHY runner drains and emits
      // its single chat:end (memory-strata's consolidation trigger). Dedup so
      // a re-arm race can't double-queue.
      if (!cancelledSessions.has(sessionId)) {
        cancelledSessions.add(sessionId);
        void bus
          .call<SessionQueueWorkInput, SessionQueueWorkOutput>(
            'session:queue-work', ctx, { sessionId, entry: { type: 'cancel' } },
          )
          .catch((err) => {
            ctx.logger.warn('keepalive_reap_cancel_failed', { sessionId, err });
          });
      }
      // Force after grace: a WEDGED runner can't process the cancel.
      // handle.kill() (→ killPod → kubelet SIGKILL) doesn't trust the runner.
      entry.graceTimer = setTimeout(() => {
        entry.graceTimer = null;
        void entry.handle.kill().catch(() => undefined);
      }, idleGraceMs);
      entry.graceTimer.unref?.();
    }, idleWindowMs);
    entry.idleTimer.unref?.();
  }

  // Phase 3 / I10 — sessions whose agent has at least one non-`api-key`
  // credential get `proxy:rotate-session` fired between turns. api-key-only
  // sessions stay in coarse mode (no rotation, identical to Phase 2).
  // Membership is added after a successful proxy:open-session and removed in
  // the runAgentInvoke finally that fires proxy:close-session.
  const sessionsNeedingRotation = new Set<string>();

  // Sessions that proposed a skill this turn must re-spawn next turn (the runner
  // reads skills only at spawn, "frozen at spawn", design §D6). Populated by the
  // skills:proposed subscriber (MARK-ONLY — see onSkillsProposed; TASK-74
  // replaced the old workspace:applied .ax/draft-skills trigger), consumed
  // (terminate + fresh spawn) at the next turn's routing decision. In-memory +
  // single-replica — same posture as the warm-session map.
  const respawnSessions = new Set<string>();

  async function runAgentInvoke(
    ctx: AgentContext,
    input: AgentInvokeInput,
  ): Promise<AgentOutcome> {
    // 1. chat:start — subscribers can veto.
    const startResult = await bus.fire('chat:start', ctx, {
      message: input.message,
    });
    if (startResult.rejected) {
      const outcome: AgentOutcome = {
        kind: 'terminated',
        reason: `chat:start:${startResult.reason}`,
      };
      // TASK-22 — pre-waiter early-return: surface on the SSE so the client
      // doesn't hang. channel-web dispatches agent:invoke fire-and-forget and
      // returns 202; the synchronous outcome here never reaches the client, so
      // the SSE is the only signal. Without fireTurnError a vetoed chat:start
      // would leave the client spinning on "Thinking…" forever.
      await fireTurnError(ctx, ctx.reqId, outcome.reason);
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
    }

    // 2. agents:resolve — Week 9.5 ACL gate. EVERY chat goes through here.
    //    The agents plugin throws PluginError('forbidden' | 'not-found')
    //    when the user can't reach the named agent; we map that to a
    //    `terminated` outcome with `reason: 'agent-resolve:<code>'` so
    //    audit-log subscribers see exactly one chat:end and the call
    //    site can branch on the prefix.
    //
    //    A non-PluginError throw (impl bug, transport blip) gets the
    //    same shape with `reason: 'agent-resolve:internal'` rather than
    //    leaking through — agent:invoke's contract is "always returns a
    //    AgentOutcome", and we'd rather degrade visibly than 500 the
    //    whole bus.call chain.
    let agent: AgentRecord;
    try {
      const resolved = await bus.call<AgentsResolveInput, AgentsResolveOutput>(
        'agents:resolve',
        ctx,
        { agentId: ctx.agentId, userId: ctx.userId },
      );
      agent = resolved.agent;
    } catch (err) {
      const code = err instanceof PluginError ? err.code : 'internal';
      const outcome: AgentOutcome = {
        kind: 'terminated',
        reason: `agent-resolve:${code}`,
        error: err,
      };
      // TASK-22 — pre-waiter early-return: surface on the SSE so the client
      // doesn't hang (coarse `reason` only — the ACL code, not the raw err;
      // see the chat:start note above).
      await fireTurnError(ctx, ctx.reqId, outcome.reason);
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
    }

    // 3. Build the agent config snapshot we'll freeze on the session.
    //    Per Invariant I10: this is captured ONCE at session creation;
    //    live edits to the agent row (via /admin/agents PATCH in Task 9)
    //    do not affect in-flight sessions.
    const agentConfig: AgentConfig = {
      systemPrompt: agent.systemPrompt,
      // TASK-51 (JIT §P4): lock the always-on broker tools into every
      // multi-tenant agent's effective allowedTools (default+locked). For a
      // wildcard agent (empty allowedTools+mcpConfigIds) this is a no-op — it
      // already sees the whole catalog. See withBrokerDefaults.
      allowedTools: withBrokerDefaults(agent.allowedTools, agent.mcpConfigIds),
      mcpConfigIds: agent.mcpConfigIds,
      model: agent.model,
    };

    // TASK-66 (out-of-git Part B / B1): persist the USER turn into the display
    // event log (the redisplay SoT) host-side, ONCE per agent:invoke, before
    // the route/spawn decision. The runner's `event.turn-end` only ships
    // tool/assistant turns, and a runner-side user turn-end would trip the
    // host's turn-end side effects (the SSE done-frame closer keyed by
    // conversationId, one-shot keep-warm, clear-active-req-id) — closing the
    // live stream before the turn runs. Persisting here, off the turn-end
    // path, captures the user's own message for redisplay with no side
    // effects. Gated on `conversations:append-event` being registered (same
    // hasService posture as the conversations:* peers above); best-effort —
    // a persist failure must not block the chat (the runner still streams the
    // reply; only this turn's redisplay loses the user bubble). conversationId
    // is host-stamped on ctx.
    await persistUserDisplayTurn(bus, ctx, input.message);

    // 4. Decide: route to existing sandbox session, or open a fresh one?
    //
    //    Task 16 (J6 — one sandbox per conversation at a time). When
    //    `ctx.conversationId` is set AND the row's `activeSessionId` points
    //    at a session that's still alive, we enqueue the new user message
    //    into THAT session's inbox. The runner is already attached and
    //    will pick it up via its long-poll `tool.inbox-pull` — no new
    //    sandbox spawn needed.
    //
    //    Why the orchestrator does this (not the channel layer): every
    //    agent:invoke already passes through the agents:resolve gate and the
    //    chat:start veto here. Gating routing decisions in the same place
    //    keeps the conversation-binding policy in ONE plugin (I4 — one
    //    source of truth: the conversation row's active_session_id IS
    //    "which sandbox is in flight").
    let routedSessionId: string | null = null;
    // Gate on the peer hooks being actually registered. CLI canary and
    // mcp-client e2e drive the orchestrator without @ax/conversations
    // loaded; in those presets we skip routing entirely. See
    // plugin.ts manifest comment for the full rationale.
    const conversationsLoaded =
      bus.hasService('conversations:get') &&
      bus.hasService('conversations:bind-session') &&
      bus.hasService('session:is-alive');
    if (ctx.conversationId !== undefined && conversationsLoaded) {
      // Look up the conversation row. If it's gone or foreign, fall through
      // to the fresh-sandbox path; the channel-web layer's get-or-create
      // already runs at request entry, so a not-found here is unusual but
      // not load-bearing for the orchestrator's logic.
      try {
        const conv = await bus.call<
          ConversationsGetInput,
          ConversationsGetOutput
        >('conversations:get', ctx, {
          conversationId: ctx.conversationId,
          userId: ctx.userId,
        });
        const candidate = conv.conversation.activeSessionId;
        if (candidate !== null && candidate.length > 0) {
          const aliveResult = await bus.call<
            SessionIsAliveInput,
            SessionIsAliveOutput
          >('session:is-alive', ctx, { sessionId: candidate });
          if (aliveResult.alive) {
            if (respawnSessions.has(candidate)) {
              // B3: this session's agent's draft-skills changed since it
              // spawned (the runner freezes the projection at spawn). Retire it
              // and fall through to a fresh spawn that re-derives the
              // projection. Safe HERE (between turns), unlike a mid-commit
              // terminate in the workspace:applied subscriber.
              respawnSessions.delete(candidate);
              try {
                await bus.call('session:terminate', ctx, { sessionId: candidate });
              } catch (err) {
                ctx.logger.warn('respawn_terminate_failed', {
                  sessionId: candidate,
                  err: err instanceof Error ? err.message : String(err),
                });
              }
              // routedSessionId stays null → fresh-spawn path below.
            } else {
              routedSessionId = candidate;
            }
          }
          // else: stale pointer (sandbox torn down without clearing the
          // row, or session:terminate subscriber not yet observed). Fall
          // through to fresh-sandbox spawn.
        }
      } catch (err) {
        // not-found → fall through to fresh spawn. Anything else, log
        // and fall through too — J6 routing is best-effort; if the
        // lookup itself blows up we'd rather degrade by opening a fresh
        // sandbox than abort the chat.
        ctx.logger.warn('conversation_route_lookup_failed', {
          conversationId: ctx.conversationId,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    if (routedSessionId !== null) {
      // ----- Route into existing live sandbox session -----
      //
      // J6: the runner is already running. We only need to:
      //   1. Bind reqId on the conversation row (active_session_id stays
      //      the same, active_req_id updates so the SSE handler at Task 7
      //      can locate the in-flight stream by reqId).
      //   2. Register a waiter on the live sessionId.
      //   3. Enqueue the user message into the existing inbox.
      //   4. Wait for the runner to emit chat:turn-end (and chat:end on
      //      one-shot teardown).
      //
      // We do NOT call sandbox:open-session, do NOT call session:create,
      // and do NOT register a NEW handle.exited watcher — the existing
      // sandbox's lifecycle is owned by whoever opened it originally.
      const sessionId = routedSessionId;

      // Turn starting on a warm session: cancel any pending idle reap. It is
      // re-armed on this turn's chat:turn-end. (Narrow race: if the idle timer
      // already fired and queued a cancel during its grace window, that cancel
      // is in the inbox FIFO ahead of this message; the runner exits, this
      // turn resolves terminated, and the next turn re-spawns fresh. Accepted
      // for the simplest single-user slice.)
      if (keepAlive) clearReapTimers(sessionId);

      // (1) Bind reqId on the conversation row. ctx.conversationId is
      //     known non-undefined here because we entered this branch.
      try {
        await bus.call<
          ConversationsBindSessionInput,
          ConversationsBindSessionOutput
        >('conversations:bind-session', ctx, {
          conversationId: ctx.conversationId!,
          sessionId,
          reqId: ctx.reqId,
        });
      } catch (err) {
        // bind-session failures shouldn't be fatal — the row may have
        // been deleted between the lookup and now (rare race). Log and
        // proceed: the chat still completes; just the SSE-by-reqId
        // lookup may miss. Audit-log subscribers see chat:end normally.
        ctx.logger.warn('conversation_bind_failed_routed', {
          conversationId: ctx.conversationId,
          sessionId,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }

      // (2) Register the waiter BEFORE enqueueing — the runner may emit
      //     chat:turn-end almost immediately on a fast model. Keyed by
      //     ctx.reqId (J9, unique per agent:invoke) — see waitersByReqId
      //     declaration for the rationale.
      const deferred = newDeferred<AgentOutcome>();
      registerWaiter(sessionId, ctx.reqId, deferred);

      // (3) Enqueue the user message.
      try {
        await bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
          'session:queue-work',
          ctx,
          {
            sessionId,
            entry: {
              type: 'user-message',
              payload: input.message,
              reqId: ctx.reqId,
            },
          },
        );
      } catch (err) {
        unregisterWaiter(sessionId, ctx.reqId);
        const outcome: AgentOutcome = {
          kind: 'terminated',
          reason: 'queue-work-failed',
          error: err,
        };
        // F2b — surface on the SSE (waiter already unregistered above, so
        // onChatEnd skips it; original ctx.reqId → SSE matches by reqId).
        await fireTurnError(ctx, ctx.reqId, outcome.reason);
        await bus.fire('chat:end', ctx, { outcome });
        return outcome;
      }

      // (4) Wait for the runner. We do NOT watch `exited` here: the sandbox
      //     handle isn't ours. If the sandbox dies mid-turn, session:terminate
      //     fires, the conversations subscriber clears active_session_id, and
      //     the next agent:invoke on this conversation routes to fresh. The
      //     in-flight chat will time out via the bounded chatTimeoutMs path.
      let resolvedByChatEndSubscriber = true;
      const timeoutHandle = setTimeout(() => {
        deferred.reject(new ChatTimeoutError(chatTimeoutMs));
      }, chatTimeoutMs);
      timeoutHandle.unref?.();

      let outcome: AgentOutcome;
      try {
        outcome = await deferred.promise;
      } catch (err) {
        resolvedByChatEndSubscriber = false;
        outcome = {
          kind: 'terminated',
          reason: err instanceof ChatTimeoutError ? 'chat-run-timeout' : 'chat-run-error',
          error: err,
        };
      } finally {
        clearTimeout(timeoutHandle);
        unregisterWaiter(sessionId, ctx.reqId);
      }

      if (!resolvedByChatEndSubscriber) {
        // Fault A — surface the abnormal end on the SSE (e.g. the routed
        // turn timed out waiting for a runner that wedged). session:terminate
        // covers the prompt pod-death case; this covers the timeout/error
        // case where no session:terminate fires.
        if (outcome.kind === 'terminated') {
          await fireTurnError(ctx, ctx.reqId, outcome.reason);
        }
        await bus.fire('chat:end', ctx, { outcome });
      }
      // No handle.kill() — we did not open this sandbox.
      return outcome;
    }

    // Phase 2B — system-prompt:augment. Fresh-spawn path only: a routed
    // agent:invoke reuses an existing live sandbox whose systemPrompt was
    // baked into the runner at first spawn; re-augmenting mid-conversation
    // would silently shift the prompt under the running agent (and the
    // runner doesn't reload it anyway).
    //
    // Single-provider service hook (one registration at MVP; promoted to
    // a subscriber chain in Phase 5+ if a second provider lands). When
    // unregistered: no-op — identical to pre-Phase-2B behavior.
    //
    // Failure-mode: augmentation is fire-and-degrade. A throw doesn't abort
    // the chat; we log and fall through with the un-augmented prompt. The
    // alternative — surfacing as `terminated` — would couple the chat's
    // success to a soft-dep auxiliary, which is the wrong shape.
    if (bus.hasService('system-prompt:augment')) {
      try {
        const out = await bus.call<
          SystemPromptAugmentInput,
          SystemPromptAugmentOutput
        >('system-prompt:augment', ctx, {});
        const extra = out.contributions
          .map((c) => c.body)
          .filter((b) => b.length > 0)
          .join('\n\n');
        if (extra.length > 0) {
          // Mutate the struct's field, not the binding. agentConfig is still
          // a const reference to the same object; only the systemPrompt
          // property changes before it gets frozen on the new session.
          agentConfig.systemPrompt = `${extra}\n\n${agentConfig.systemPrompt}`;
        }
      } catch (err) {
        ctx.logger.warn('system_prompt_augment_failed', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    // 4.5 — proxy:open-session. Fresh-spawn path only: a routed
    //       agent:invoke reuses an existing live sandbox whose proxy
    //       session was opened by the orchestrator that originally
    //       spawned it.
    //
    //       Phase 6 made @ax/credential-proxy mandatory. Without it,
    //       proxyConfig would stay undefined and sandbox:open-session
    //       would inject no proxy env — the runner would fail at boot
    //       with MissingEnvError, which is a worse error path than a
    //       structured outcome at agent:invoke time. Fail loud here.
    //
    //       I7 — `proxy:close-session` always fires once per `proxy:open-
    //       session`. We track that with `proxyOpened`; the finally below
    //       fires close exactly once when the flag is set, regardless of
    //       which exit path won. The `proxy-not-loaded` exit below runs
    //       BEFORE proxyOpened can be set — nothing to close.
    //
    //       Both hooks must be registered before we enable proxy mode. A
    //       skewed preset that wired only one would otherwise either open
    //       sessions it can never close (open-only) or never reach the
    //       proxy at all (close-only) — neither is recoverable at runtime.
    //       Fail loud at agent:invoke time with a structured outcome so
    //       audit-log surfaces the misconfiguration.
    const proxyOpenLoaded = bus.hasService('proxy:open-session');
    const proxyCloseLoaded = bus.hasService('proxy:close-session');
    if (proxyOpenLoaded !== proxyCloseLoaded) {
      const outcome: AgentOutcome = {
        kind: 'terminated',
        reason: 'proxy-hooks-misconfigured',
      };
      // TASK-22 — surface on the SSE BEFORE chat:end. These pre-waiter
      // early-returns run before registerWaiter below, so onChatEnd's F2b
      // fallback can't recover them (no live waiter) — without an explicit
      // fireTurnError the client would hang on "Thinking…" forever. ctx.reqId
      // is the originating agent:invoke reqId (never IPC-restamped on this
      // synchronous path), so the SSE matches the exact turn.
      await fireTurnError(ctx, ctx.reqId, outcome.reason);
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
    }
    if (!proxyOpenLoaded) {
      // I18 — distinct from skew-misconfigured. Phase 6 made the
      // credential-proxy mandatory; running without it would force real
      // credentials into the sandbox env, breaking I1 (the same defense
      // the open-session catch block carries). Terminate at agent:invoke
      // time with a clear outcome instead of letting the runner fail at
      // boot with MissingEnvError.
      const outcome: AgentOutcome = {
        kind: 'terminated',
        reason: 'proxy-not-loaded',
      };
      // TASK-22 — pre-waiter early-return: surface on the SSE so the client
      // doesn't hang (see the proxy-hooks-misconfigured note above).
      await fireTurnError(ctx, ctx.reqId, outcome.reason);
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
    }
    let proxyConfig: ProxyConfig;
    let proxyOpened = false;
    let proxyCloseDeferredToHandle = false;
    // Default to the api.anthropic.com allowlist + the canonical
    // ANTHROPIC_API_KEY → 'provider:anthropic' credential ref when the agent
    // record carries no explicit per-row entries. The production agents
    // plugin (`@ax/agents`) doesn't yet persist these fields; without a
    // default the runner boots without an API key and crashes at
    // proxy-startup with `missing ANTHROPIC_API_KEY`.
    //
    // Coupled defaults (all-or-nothing): a partially-populated agent
    // record (e.g. allowedHosts:['api.openai.com'] but no
    // requiredCredentials) used to mix and match — the OpenAI allowlist
    // would land alongside the Anthropic credential ref, either
    // over-permitting egress or breaking the agent's real provider.
    // We fall back to the Anthropic pair only when BOTH fields are
    // missing; a partial config raises loud at agent:invoke time as
    // a structured outcome rather than at proxy-startup with a stale
    // credential map.
    const allowedHostsMissing = agent.allowedHosts === undefined;
    const requiredCredsMissing = agent.requiredCredentials === undefined;
    if (allowedHostsMissing !== requiredCredsMissing) {
      const outcome: AgentOutcome = {
        kind: 'terminated',
        reason: 'agent-proxy-config-incomplete',
      };
      // TASK-22 — pre-waiter early-return: surface on the SSE so the client
      // doesn't hang (see the proxy-hooks-misconfigured note above).
      await fireTurnError(ctx, ctx.reqId, outcome.reason);
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
    }
    const useAnthropicDefaults = allowedHostsMissing; // and therefore both

    // Phase 1 (skill-install): resolve installed skills attached to this agent
    // and union their declared allowedHosts + credentialBindings into the
    // proxy open-session call. Skills are the v1 primary path by which an
    // agent gains access to a new credentialed host; see
    // docs/plans/2026-05-17-skill-install-workflow-design.md.
    let resolvedSkills: ResolvedSkillForOrch[] = [];

    // TASK-33 — per-user skill attachments: a self-serve layer above the
    // admin-managed agent-global attachments, fetched per (user, agent).
    // Union precedence is per-user > agent-global > default-attached. Gated by
    // hasService (same convention as skills:resolve / skills:list-defaults —
    // conditionally called, NOT declared in the manifest): stripped presets
    // without @ax/skills no-op.
    //
    // This read is CREDENTIAL-BEARING: it decides which credential refs reach
    // proxy:open-session and the per-user > agent-global precedence on slot
    // collision. So a throw FAILS CLOSED (terminate the turn), matching the
    // skills:resolve precedent below — NOT the skills:list-defaults fail-open
    // path (defaults are instruction-only and can't carry credentials). Failing
    // open here could silently spawn the session with the agent-global ref for a
    // slot the user activated a per-user override on — a credential the user
    // never chose for their session. (Codex P1.)
    let userAttachments: Array<{
      skillId: string;
      credentialBindings: Record<string, string>;
    }> = [];
    if (bus.hasService('skills:list-user-attachments')) {
      try {
        const r = await bus.call<
          SkillsListUserAttachmentsInput,
          SkillsListUserAttachmentsOutput
        >('skills:list-user-attachments', ctx, {
          userId: ctx.userId,
          agentId: agent.id,
        });
        userAttachments = r.attachments;
      } catch (err) {
        const outcome: AgentOutcome = {
          kind: 'terminated',
          reason: 'user-attachments-failed',
          error: err,
        };
        // TASK-22 — pre-waiter early-return: surface on the SSE so the client
        // doesn't hang (coarse `reason` only; the raw `err` stays on the audit
        // chat:end outcome — same pattern as skill-resolve-failed below).
        await fireTurnError(ctx, ctx.reqId, outcome.reason);
        await bus.fire('chat:end', ctx, { outcome });
        return outcome;
      }
    }

    // Per-user wins over agent-global on skill-id collision: drop any
    // agent-global attachment whose skillId a per-user attachment already
    // covers, then list per-user FIRST so the credential/host merge loop below
    // resolves it as the slot owner. The downstream resolve + credential loop +
    // defaults filter all key off this single `attachments` list unchanged, so
    // the three-source union and per-user-binding-wins precedence fall out here.
    const userAttachedSkillIds = new Set(userAttachments.map((a) => a.skillId));
    const attachments = [
      ...userAttachments,
      ...(agent.skillAttachments ?? []).filter(
        (a) => !userAttachedSkillIds.has(a.skillId),
      ),
    ];
    if (attachments.length > 0 && bus.hasService('skills:resolve')) {
      try {
        const r = await bus.call<SkillsResolveInput, SkillsResolveOutput>(
          'skills:resolve', ctx, { skillIds: attachments.map((a) => a.skillId), ownerUserId: ctx.userId },
        );
        resolvedSkills = r.skills;
      } catch (err) {
        const outcome: AgentOutcome = {
          kind: 'terminated',
          reason: 'skill-resolve-failed',
          error: err,
        };
        // TASK-22 — pre-waiter early-return: surface on the SSE so the client
        // doesn't hang (see the proxy-hooks-misconfigured note above). Only the
        // coarse `reason` crosses to the client; the raw `err` stays on the
        // audit chat:end outcome.
        await fireTurnError(ctx, ctx.reqId, outcome.reason);
        await bus.fire('chat:end', ctx, { outcome });
        return outcome;
      }
    }

    const skillById = new Map(resolvedSkills.map((s) => [s.id, s]));

    // Build the union allowlist + credentials, starting from agent defaults.
    const baseAllowSet = useAnthropicDefaults
      ? new Set<string>(['api.anthropic.com'])
      : new Set<string>(agent.allowedHosts ?? []);
    const baseCreds: Record<string, { ref: string; kind: string }> = useAnthropicDefaults
      ? { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } }
      : { ...(agent.requiredCredentials ?? {}) };

    // TASK-86 — the bare env-var names a TRUSTED source owns (agent defaults).
    // These ALWAYS win the sandbox flat-env stamp; a skill can never overwrite
    // them. Skill slots are namespaced (`skill:<id>:<slot>`) so they coexist in
    // the host-side credential map instead of fatally colliding.
    const trustedBareNames = new Set<string>(Object.keys(baseCreds));

    // Track slot ownership (now keyed by the NAMESPACED env name for skill slots,
    // the bare name for trusted base creds) — purely diagnostic / idempotence.
    const slotOwners = new Map<string, string>(
      [...trustedBareNames].map((slot) => [slot, '<agent.requiredCredentials>']),
    );

    // TASK-86 — ordered (highest precedence first) skill-slot descriptors driving
    // the namespaced→bare env projection. `attachments` is already in per-user >
    // agent-global precedence order; authored drafts (folded below) append after,
    // so the FIRST writer of a shared bare name wins the flat-env stamp.
    const skillSlotEnvNames: Array<{ envName: string; bareSlot: string }> = [];

    for (const attachment of attachments) {
      const skill = skillById.get(attachment.skillId);
      if (skill === undefined) continue; // deleted-skill-still-attached — drop silently
      for (const host of skill.capabilities.allowedHosts) {
        baseAllowSet.add(host);
      }
      for (const slotDef of skill.capabilities.credentials) {
        const ref = attachment.credentialBindings[slotDef.slot];
        if (ref === undefined) {
          const outcome: AgentOutcome = {
            kind: 'terminated',
            reason: 'skill-binding-missing',
            error: new Error(`skill '${skill.id}' attachment is missing binding for slot '${slotDef.slot}'`),
          };
          // TASK-22 — pre-waiter early-return: surface on the SSE so the client
          // doesn't hang (coarse `reason` only; see note above).
          await fireTurnError(ctx, ctx.reqId, outcome.reason);
          await bus.fire('chat:end', ctx, { outcome });
          return outcome;
        }
        // TASK-86 — key the catalog skill's slot by its PER-SKILL namespace so
        // two skills wanting the same bare slot (e.g. both `LINEAR_API_KEY`)
        // coexist instead of the old fatal `skill-slot-collision` lockout. The
        // bare env-var name the skill reads is restored by the env projection
        // after proxy:open-session. Idempotent on a duplicate slot within one
        // skill; a different skill can never collide (the key carries the id).
        const envName = skillCredentialEnvName(skill.id, slotDef.slot);
        if (slotOwners.has(envName)) continue;
        baseCreds[envName] = { ref, kind: slotDef.kind };
        slotOwners.set(envName, skill.id);
        skillSlotEnvNames.push({ envName, bareSlot: slotDef.slot });
      }
    }

    const unionedCreds = baseCreds;

    // 2026-05-19 defaults — union admin-curated default skills into the
    // installedSkills set. Soft-coupled via hasService: stripped presets
    // without @ax/skills no-op (I-S6). Throws are non-fatal (I-S5) — log
    // + treat as empty; the session still opens. Explicit attachments win
    // on id collision (I-S4) — we filter defaults by ids already present
    // in resolvedSkills.
    //
    // Phase 3 — self-authored workspace drafts are the highest-precedence
    // discovery source (the agent's own current authoring wins over a stale
    // catalog/default of the same id). Instruction-only here (empty caps; lazy
    // approval is Phase 4), so a throw FAILS OPEN — fewer skills, never wider
    // reach (same posture as skills:list-defaults below).
    let authoredDraftSkills: AuthoredResolvedSkillForOrch[] = [];
    if (bus.hasService('agents:resolve-authored-skills')) {
      try {
        const r = await bus.call<
          { ownerUserId: string; agentId: string },
          AgentsResolveAuthoredSkillsOutput
        >('agents:resolve-authored-skills', ctx, { ownerUserId: ctx.userId, agentId: agent.id });
        authoredDraftSkills = r.skills;
      } catch (err) {
        ctx.logger.warn('resolve_authored_skills_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        authoredDraftSkills = [];
      }
    }

    // §D3 "no bytes project, no caps inject" (TASK-76). A `pending` authored
    // skill — one whose declared caps a human hasn't approved yet — must
    // contribute NOTHING to this spawn: not its SKILL.md body, not its
    // name/description in context, not its caps. Only `active` skills (zero-cap
    // free-path, or a gated skill the user approved → status flipped to active)
    // materialize. The full `authoredDraftSkills` list is still used below to
    // fire the approval card (the card reads description+proposalDelta, never the
    // body), so a pending skill is invisible to the model yet still promptable.
    // A projection that predates the `status` field (back-compat) defaults to
    // active — the pre-TASK-76 behavior.
    const activeAuthoredDraftSkills = authoredDraftSkills.filter(
      (s) => (s.status ?? 'active') === 'active',
    );

    // PC-1 — fold APPROVED authored-draft caps into the egress allowlist +
    // credential map (Phase 4 PR-B). baseCreds is aliased by unionedCreds and
    // baseAllowSet is frozen into unionedAllowlist below, so mutating them here
    // reaches proxy:open-session. TASK-86 — authored skill slots are namespaced
    // (`skill:<id>:<slot>`) like catalog slots, so two skills wanting the same
    // bare slot coexist and a skill can't hijack a trusted credential (the env
    // projection makes the trusted bare name win) — no more fatal collision.
    // Only ACTIVE skills fold (§D3 "no caps inject" for pending; a pending
    // skill's proposal∩approved is empty anyway, so this is belt-and-suspenders).
    foldAuthoredSkillCaps(
      activeAuthoredDraftSkills,
      baseAllowSet,
      baseCreds,
      slotOwners,
    );
    // Append the authored skills' namespaced slots AFTER the catalog attachments
    // so the projection's first-writer-wins precedence holds (catalog > authored
    // on a shared bare name). Mirror the fold's account/untagged ref derivation
    // for the bare-name mapping (the ref itself is already in baseCreds).
    for (const s of activeAuthoredDraftSkills) {
      for (const c of s.capabilities.credentials) {
        skillSlotEnvNames.push({
          envName: skillCredentialEnvName(s.id, c.slot),
          bareSlot: c.slot,
        });
      }
    }

    let defaultSkillsForUnion: ResolvedSkillForOrch[] = [];
    if (bus.hasService('skills:list-defaults')) {
      try {
        const r = await bus.call<
          { ownerUserId?: string },
          { skills: ResolvedSkillForOrch[] }
        >('skills:list-defaults', ctx, { ownerUserId: ctx.userId });
        defaultSkillsForUnion = r.skills;
      } catch (err) {
        // Matches the existing `ctx.logger.warn(event, fields)` convention in
        // this file (see e.g. proxy_close_session_failed).
        ctx.logger.warn('skills_list_defaults_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        defaultSkillsForUnion = [];
      }
    }
    // §D3 (TASK-76): only ACTIVE authored skills enter the union (and therefore
    // shadow same-id attachments). A `pending` draft must project nothing — and
    // it must NOT suppress an explicit/default skill of the same id either (else
    // an unapproved draft would blank out a real attachment), so the shadow set
    // is the ACTIVE ids, not the full authored list.
    const authoredIds = new Set(activeAuthoredDraftSkills.map((s) => s.id));
    // Union construction order: authored drafts (highest) → explicit
    // attachments → defaults → builtins (lowest). De-duped by id so the
    // higher-precedence entry wins.
    //
    // M2 — shadowed-id caps note: when an authored draft shares an id with
    // an explicit/global attachment, the DRAFT wins this union (the model
    // reads the draft's SKILL.md body) but creds/hosts are still wired from
    // the attachment's resolved capabilities (the credential loop above keys
    // off `resolvedSkills` / `attachments`, independent of `unionedSkills`).
    // So this union decides only which instruction BODY the model sees
    // (precedence). Egress hosts/creds are separate: an authored draft's
    // APPROVED caps were already folded into baseAllowSet/baseCreds by
    // foldAuthoredSkillCaps (PC-1, just above), so its egress is live
    // regardless of what shadows its body here.
    const withAuthored = [
      ...activeAuthoredDraftSkills,
      ...resolvedSkills.filter((s) => !authoredIds.has(s.id)),
    ];
    const explicitIds = new Set(withAuthored.map((s) => s.id));
    const withDefaults = [
      ...withAuthored,
      ...defaultSkillsForUnion.filter((s) => !explicitIds.has(s.id)),
    ];
    const presentIds = new Set(withDefaults.map((s) => s.id));
    const unionedSkills = [
      ...withDefaults,
      ...(config.builtinSkills ?? []).filter((s) => !presentIds.has(s.id)),
    ];

    // TASK-97 — CONNECTOR union. Resolve the agent's effective connector set
    // (workspace defaults ∪ the owner's own connectors; see connector-union.ts on
    // why manager-added attachment is a deferred follow-up) and fold each
    // connector's Capabilities through the SAME materialization path skills use:
    // hosts → baseAllowSet, credential slots → baseCreds (namespaced
    // `connector:<id>:<slot>`), packages → the registry auto-allow below,
    // mcpServers → installed-skill entries (synthetic SKILL.md + per-dir
    // `.mcp.json`). Deduped against skill caps: hosts via the shared Set, slots via
    // the per-subject namespace. NON-FATAL throughout — a connector resolve failure
    // yields fewer connectors, never terminates (connectors are additive reach).
    const effectiveConnectors = await resolveEffectiveConnectors(bus, ctx);
    const connectorFold: FoldConnectorResult = foldConnectorCaps(
      effectiveConnectors,
      baseAllowSet,
      baseCreds,
      slotOwners,
    );
    // Append connector slots AFTER the skill slots so the bare-env projection's
    // first-writer-wins keeps SKILL precedence on a shared bare name (a connector
    // and a skill both reading `LINEAR_API_KEY` → the skill wins the flat-env
    // stamp; the connector's own credential still reaches the proxy under its
    // namespaced placeholder).
    for (const slot of connectorFold.connectorSlotEnvNames) {
      skillSlotEnvNames.push(slot);
    }

    // D: auto-allowlist public package registries for any skill OR connector in
    // the union — explicit attachments AND default-attached skills AND connectors
    // (all are materialized into the sandbox, so the agent may run npx/uvx for
    // any). Specific hosts only, gated on installation (I5 — no blanket egress).
    // Computed here (after the defaults union + connector fold) so every declared
    // ecosystem is covered.
    let needsNpmRegistry = connectorFold.needsNpmRegistry;
    let needsPypiRegistry = connectorFold.needsPypiRegistry;
    for (const skill of unionedSkills) {
      const pkgs = skill.capabilities.packages;
      if (pkgs?.npm?.length) needsNpmRegistry = true;
      if (pkgs?.pypi?.length) needsPypiRegistry = true;
    }
    if (needsNpmRegistry) baseAllowSet.add('registry.npmjs.org');
    if (needsPypiRegistry) {
      baseAllowSet.add('pypi.org');
      baseAllowSet.add('files.pythonhosted.org');
    }
    // TASK-44 — persistent per-(user, agent) host grants ("always allow", design
    // §6B / §P7.3 / decision #12). The durable twin of the LIVE proxy:add-host
    // grant (TASK-37): hosts the user previously chose "Always for this agent"
    // for are loaded into THIS session's egress allowlist at open. Gated by
    // hasService (conditionally called, NOT declared in the manifest — same
    // convention as skills:list-user-attachments above): stripped presets without
    // @ax/host-grants no-op. CREDENTIAL-FREE (hosts only), so a throw FAILS OPEN
    // (log + empty) — an empty result yields FEWER hosts (user re-hits the wall),
    // never more, so it can't widen egress.
    if (bus.hasService('host-grants:list')) {
      try {
        const r = await bus.call<
          { ownerUserId: string; agentId: string },
          { hosts: Array<{ host: string; grantedAt: string }> }
        >('host-grants:list', ctx, { ownerUserId: ctx.userId, agentId: agent.id });
        for (const g of r.hosts) baseAllowSet.add(g.host);
      } catch (err) {
        ctx.logger.warn('host_grants_list_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const unionedAllowlist = [...baseAllowSet];

    const installedSkillsForSandbox: InstalledSkillForSandbox[] = unionedSkills.map((s) => ({
      id: s.id,
      // JIT Phase 1a — the bundle as a file tree: SKILL.md (reconstructed from
      // the manifest columns) first, then any extra files resolved from the
      // store, verbatim. `?? []` is the back-compat defense for a skills:resolve
      // that predates the `files` field.
      files: [
        {
          path: 'SKILL.md',
          contents:
            '---\n' +
            s.manifestYaml +
            (s.manifestYaml.endsWith('\n') ? '' : '\n') +
            '---\n' +
            s.bodyMd,
        },
        ...(s.files ?? []).map((f) => ({ path: f.path, contents: f.contents })),
      ],
      // Phase B — per-skill MCP server bundle. Defense-in-depth `?? []` in
      // case skills:resolve returned a ResolvedSkill without the field
      // (older impl, structural shape mismatch). No cross-skill union — each
      // skill stays its own group because `.mcp.json` is per-directory.
      mcpServers: s.capabilities.mcpServers ?? [],
      // TASK-14 — top-level allowedHosts + credential slots so the runner can
      // wire git HTTP Basic auth for the skill's credentialed hosts. The only
      // credential kind the manifest grammar permits is 'api-key' (see
      // @ax/skills CapabilitySlotSchema), so narrow the forwarded kind.
      allowedHosts: s.capabilities.allowedHosts ?? [],
      // TASK-86 — `slot` is the BARE env-var name the skill reads. The skill's
      // OWN `ax-cred:<hex>` placeholder is stamped below (after proxy:open-session
      // resolves the namespaced credential map) so git HTTP-Basic wiring uses the
      // skill's own credential even when another skill won the flat-env stamp for
      // the same bare name.
      credentials: (s.capabilities.credentials ?? []).map((c) => ({
        slot: c.slot,
        kind: 'api-key' as const,
      })),
    }));

    // TASK-97 — connector installed-skill entries (synthetic SKILL.md +
    // mcpServers) from the connector fold. Kept SEPARATE from the skill entries
    // because a connector entry's credential placeholders key off
    // `connector:<connectorId>:<slot>` (not `skill:<id>:<slot>`), so they need
    // their own stamping loop below. The entry `id` is the sandbox-safe derived
    // dir id; `connectorId` is the original id used for the namespaced lookup.
    const connectorInstalledEntries: Array<
      InstalledSkillForSandbox & { connectorId: string }
    > = connectorFold.installedEntries.map((e) => ({
      id: e.id,
      files: e.files,
      mcpServers: e.mcpServers,
      allowedHosts: e.allowedHosts,
      credentials: e.credentials,
      connectorId: e.connectorId,
    }));

    try {
      const opened = await bus.call<ProxyOpenSessionInput, ProxyOpenSessionOutput>(
        'proxy:open-session',
        ctx,
        {
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          agentId: agent.id,
          allowlist: unionedAllowlist,
          credentials: unionedCreds,
        },
      );
      // Mark opened BEFORE endpointToProxyConfig — that helper throws on
      // unrecognized scheme, and we still owe the proxy a close in that
      // case (the session was minted before the throw).
      proxyOpened = true;
      // TASK-86 — stamp each skill's OWN placeholder onto its sandbox credential
      // entry (looked up by the skill's namespaced env name), so per-skill git
      // wiring resolves the right credential regardless of the flat-env winner.
      for (const skill of installedSkillsForSandbox) {
        for (const cred of skill.credentials) {
          const ph = opened.envMap[skillCredentialEnvName(skill.id, cred.slot)];
          if (typeof ph === 'string') cred.placeholder = ph;
        }
      }
      // TASK-97 — connector twin of the above: stamp each connector's OWN
      // placeholder (keyed `connector:<connectorId>:<slot>`) onto its sandbox
      // credential entry, so connector git HTTP-Basic wiring resolves the right
      // credential regardless of which subject won the flat-env stamp.
      for (const entry of connectorInstalledEntries) {
        for (const cred of entry.credentials) {
          const ph = opened.envMap[connectorCredentialEnvName(entry.connectorId, cred.slot)];
          if (typeof ph === 'string') cred.placeholder = ph;
        }
      }
      // TASK-86 — project the proxy's NAMESPACED envMap back to BARE env-var
      // names for the flat sandbox env (the skill reads `$LINEAR_API_KEY`, not
      // `$skill:linear:LINEAR_API_KEY`). Trusted base names win; among skills
      // sharing a bare name the first writer wins (catalog > authored). The proxy
      // substitution is value-based, so the env-var NAME is only a placeholder
      // vehicle — the dropped duplicates' credentials still reach the proxy.
      const bareEnvMap = projectEnvMapToBareNames({
        namespacedEnvMap: opened.envMap,
        trustedBareNames,
        skillSlots: skillSlotEnvNames,
      });
      proxyConfig = endpointToProxyConfig(
        opened.proxyEndpoint,
        opened.caCertPem,
        bareEnvMap,
        opened.proxyAuthToken,
      );
      // I10 — flag the session for per-turn rotation when ANY required
      // credential has a non-`api-key` kind. The credentials facade's
      // resolve sub-service handles the actual refresh; rotate-session
      // re-resolves through the facade and updates the placeholder map.
      // I11 — the placeholder envMap stays stable across rotations; only
      // the registry's placeholder→real-value mapping updates. We don't
      // propagate the new envMap into the running runner.
      const reqs = agent.requiredCredentials ?? {};
      const hasRefreshableKind = Object.values(reqs).some(
        (c) => c.kind !== 'api-key',
      );
      if (hasRefreshableKind && bus.hasService('proxy:rotate-session')) {
        sessionsNeedingRotation.add(ctx.sessionId);
      }
    } catch (err) {
      // proxy:open-session failed (or endpointToProxyConfig threw). If
      // the open succeeded but translation failed, proxyOpened is true
      // and we need to close before returning. Otherwise nothing to
      // close — the open never settled. We do NOT proceed without the
      // proxy when it's loaded — that would force real credentials
      // into the sandbox env, breaking I1.
      if (proxyOpened) {
        await bus
          .call<ProxyCloseSessionInput, Record<string, never>>(
            'proxy:close-session',
            ctx,
            { sessionId: ctx.sessionId },
          )
          .catch((closeErr: unknown) => {
            ctx.logger.warn('proxy_close_session_failed', {
              sessionId: ctx.sessionId,
              err:
                closeErr instanceof Error
                  ? closeErr
                  : new Error(String(closeErr)),
            });
          });
      }
      const outcome: AgentOutcome = {
        kind: 'terminated',
        reason: 'proxy-open-failed',
        error: err,
      };
      // TASK-22 — credential resolution failure at session-open. This is the
      // path the chat-qa-sweep fault battery hit: `proxy:open-session` throws
      // (the runtime provider key can't be resolved/decrypted), and without an
      // explicit fireTurnError the turn hung at "Thinking…" forever — the
      // waiter isn't registered until AFTER this block, so onChatEnd's F2b
      // fallback finds no live waiter and skips its turn-error fire too.
      // Surface on the SSE BEFORE chat:end so the client flips to error+retry.
      // Only the coarse `reason` crosses to the (untrusted) client; the raw
      // `err` stays on the audit chat:end outcome (no credential/decryption
      // detail leaks).
      await fireTurnError(ctx, ctx.reqId, outcome.reason);
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
    }

    try {
    // 5. Register the waiter BEFORE opening the sandbox — the runner may
    //    emit chat:end before open-session resolves in pathological cases
    //    (extremely fast runner, racey test harness). Map it now so the
    //    subscriber can't miss the fire. The sessionId is `ctx.sessionId`
    //    — the kernel-level id that the sandbox plugin will forward into
    //    the runner's AX_SESSION_ID env; the runner then echoes it back
    //    in every IPC request via the token it holds, and the IPC server
    //    builds ctx.sessionId from that token lookup. Stable join key.
    const sessionId = ctx.sessionId;
    const deferred = newDeferred<AgentOutcome>();
    registerWaiter(sessionId, ctx.reqId, deferred);

    // 6. Open the sandbox. sandbox:open-session internally calls
    //    session:create (minting the session + token AND writing the v2
    //    owner row from the `owner` field below), starts the IPC
    //    listener, and spawns the runner subprocess. The token never
    //    returns here — it flows only into the child env (I9).
    //
    //    Workspace resolution: agent.workspaceRef is currently a
    //    pass-through field. Wiring `workspace:resolve-ref` is a separate
    //    concern that becomes load-bearing only when @ax/workspace-git
    //    grows multi-ref support; for the MVP we use ctx.workspace
    //    (already populated upstream, e.g. from the channel's session
    //    bootstrap) and leave workspaceRef unconsumed. A subscriber
    //    of `agents:resolved` could observe a mismatch — that's a Task
    //    16+ concern, called out here so a future reader doesn't think
    //    workspaceRef is silently dropped.
    let handle: OpenSessionHandle;
    try {
      // TASK-97 — the sandbox materializes skill AND connector entries through
      // the same `installedSkills` field. Strip the connector entries' internal
      // `connectorId` (a stamping-loop join key, not part of the wire shape).
      const allInstalledSkills: InstalledSkillForSandbox[] = [
        ...installedSkillsForSandbox,
        ...connectorInstalledEntries.map(({ connectorId: _cid, ...e }) => e),
      ];
      const sandboxInput: OpenSessionInput = {
        sessionId,
        workspaceRoot: ctx.workspace.rootPath,
        runnerBinary: config.runnerBinary,
        owner: {
          userId: ctx.userId,
          agentId: agent.id,
          agentConfig,
          // Forward ctx.conversationId so session:create writes the v2
          // row's conversation_id column atomically. Omitted (rather than
          // null) when the request had no conversation context — keeps
          // non-orchestrator/CLI callers and tests unaffected.
          ...(ctx.conversationId !== undefined
            ? { conversationId: ctx.conversationId }
            : {}),
        },
        // Phase 6: credential-proxy is mandatory; proxyConfig is always set
        // by the time we reach this point (the !proxyOpenLoaded gate above
        // returns early with `proxy-not-loaded` otherwise).
        proxyConfig,
        ...(allInstalledSkills.length > 0 ? { installedSkills: allInstalledSkills } : {}),
      };
      const opened = await bus.call<OpenSessionInput, OpenSessionResult>(
        'sandbox:open-session',
        ctx,
        sandboxInput,
      );
      handle = opened.handle;
      if (keepAlive) {
        // Warm the session: the runner outlives this request. One handle.exited
        // cleanup covers every reap path (graceful cancel, force kill, runner
        // floor, ceiling): close the proxy session once and drop the registry
        // entry. This is also why the per-invoke finally must NOT close the
        // proxy in keepalive mode (see the finally below).
        warmSessions.set(sessionId, { handle, idleTimer: null, graceTimer: null });
        proxyCloseDeferredToHandle = proxyOpened;
        const warmCtx = ctx;
        void handle.exited
          .then(() => {
            const entry = warmSessions.get(sessionId);
            if (entry !== undefined) {
              if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
              if (entry.graceTimer !== null) clearTimeout(entry.graceTimer);
            }
            warmSessions.delete(sessionId);
            cancelledSessions.delete(sessionId);
            // Rotation tracking lives as long as the warm session. The
            // per-invoke finally defers its cleanup to here (mirroring the
            // proxy close below) so every turn on this warm session keeps
            // rotating credentials; we drop it only once the runner exits.
            sessionsNeedingRotation.delete(sessionId);
            if (proxyOpened) {
              void bus
                .call<ProxyCloseSessionInput, Record<string, never>>(
                  'proxy:close-session', warmCtx, { sessionId: warmCtx.sessionId },
                )
                .catch((err: unknown) => {
                  warmCtx.logger.warn('proxy_close_session_failed', {
                    sessionId: warmCtx.sessionId,
                    err: err instanceof Error ? err : new Error(String(err)),
                  });
                });
            }
          })
          .catch(() => undefined);
      }
    } catch (err) {
      unregisterWaiter(sessionId, ctx.reqId);
      // Best-effort: terminate the session if sandbox-subprocess managed to
      // create it before the spawn failed. The sandbox plugin ALREADY tears
      // down in most failure modes, but belt-and-suspender for the case
      // where a partial init leaves a token alive with no listener.
      await bus
        .call<SessionTerminateInput, Record<string, never>>(
          'session:terminate',
          ctx,
          { sessionId },
        )
        .catch(() => undefined);
      const outcome: AgentOutcome = {
        kind: 'terminated',
        reason: 'sandbox-open-failed',
        error: err,
      };
      // F2b — surface on the SSE. This early return unregistered the waiter
      // above, so onChatEnd won't fire turn-error for the chat:end below; we
      // hold the original ctx.reqId here, so the SSE matches by reqId.
      await fireTurnError(ctx, ctx.reqId, outcome.reason);
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
    }

    // Phase 4 PR-B (D-B1/D-B3) — fire ONE upfront approval card per authored
    // draft with a non-empty SHOWN delta (hosts/slots/packages; mcp deferred),
    // deduped per (conversation, skillId, shown-delta). conversationId is the
    // SSE match key for skill cards, so guard on it.
    if (ctx.conversationId !== undefined && ctx.conversationId.length > 0) {
      const convId = ctx.conversationId;
      // hasShownDelta is the SINGLE source of truth for "is there anything to
      // card" — shared with buildAuthoredCardPayload's null check so the two
      // can't diverge (it also tolerates the optional packages field).
      const cardable = authoredDraftSkills.filter((s) => {
        if (!hasShownDelta(s.proposalDelta)) return false;
        // TASK-86 — a PENDING cap-skill's card only fires in the conversation
        // that proposed it (tracked in onSkillsProposed), so it stops papering
        // across every unrelated chat. If we never recorded a proposing
        // conversation (e.g. the skill predates this host process / was proposed
        // before restart), fall back to the pre-TASK-86 behavior (fire here) so
        // an approvable skill is never silently un-cardable. ACTIVE skills are
        // exempt — they don't need an approval card anyway (their shown delta is
        // empty post-approval), and the filter must not suppress one.
        if ((s.status ?? 'active') === 'pending') {
          const proposedIn = pendingSkillConversation.get(s.id);
          if (proposedIn !== undefined && proposedIn !== convId) return false;
        }
        return true;
      });
      if (cardable.length > 0) {
        // Vaulted refs → haveExisting on account-tagged slots (mirror request_capability).
        const vaultedRefs = new Set<string>();
        if (bus.hasService('credentials:list')) {
          try {
            const list = await bus.call<
              { scope: 'user'; ownerId: string },
              { credentials: Array<{ ref: string }> }
            >('credentials:list', ctx, { scope: 'user', ownerId: ctx.userId });
            for (const c of list.credentials) vaultedRefs.add(c.ref);
          } catch {
            /* a failed lookup just means the card prompts — never block it */
          }
        }
        const fired = upfrontCardsByConv.get(ctx.conversationId) ?? new Set<string>();
        for (const s of cardable) {
          // buildAuthoredCardPayload/authoredCardDedupKey normalize the optional
          // packages field internally, so proposalDelta passes straight through.
          const key = authoredCardDedupKey(s.id, s.proposalDelta);
          if (fired.has(key)) continue;
          const card = buildAuthoredCardPayload(
            { skillId: s.id, description: s.description, delta: s.proposalDelta },
            vaultedRefs,
          );
          if (card === null) continue;
          fired.add(key);
          await bus.fire('chat:permission-request', ctx, card);
        }
        // Always store back: `fired` is either a new Set or the existing
        // reference (re-set is a harmless no-op), so no size guard is needed.
        upfrontCardsByConv.set(ctx.conversationId, fired);
      }
    }

    // 7. Bind the conversation row to this fresh session (J6). Same
    //    reqId/sessionId pair the SSE handler (Task 7) keys off. We bind
    //    BEFORE enqueue so the SSE GET that races us has a chance of
    //    finding the row. Failures here are best-effort — agent:invoke still
    //    completes; only SSE-by-reqId lookup loses fidelity.
    //
    //    Only attempted when @ax/conversations is loaded (channel-web
    //    preset) — see the routing-decision comment above.
    if (ctx.conversationId !== undefined && conversationsLoaded) {
      try {
        await bus.call<
          ConversationsBindSessionInput,
          ConversationsBindSessionOutput
        >('conversations:bind-session', ctx, {
          conversationId: ctx.conversationId,
          sessionId,
          reqId: ctx.reqId,
        });
      } catch (err) {
        ctx.logger.warn('conversation_bind_failed_fresh', {
          conversationId: ctx.conversationId,
          sessionId,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    // 8. Enqueue the initial user message. If this fails, the sandbox is
    //    running but has nothing to work on — kill it and synthesize
    //    chat:end. session:terminate is fired by sandbox-subprocess's
    //    child-close handler, so we don't double-fire it here.
    try {
      await bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
        'session:queue-work',
        ctx,
        {
          sessionId,
          entry: {
            type: 'user-message',
            payload: input.message,
            // J9: forward the host-minted reqId so the runner can stamp
            // every `event.stream-chunk` it emits while processing this
            // user message. ctx.reqId is created by the kernel at
            // agent:invoke dispatch time.
            reqId: ctx.reqId,
          },
        },
      );
    } catch (err) {
      unregisterWaiter(sessionId, ctx.reqId);
      try {
        await handle.kill();
      } catch {
        // best-effort — exited promise is what drives cleanup anyway.
      }
      const outcome: AgentOutcome = {
        kind: 'terminated',
        reason: 'queue-work-failed',
        error: err,
      };
      // F2b — surface on the SSE (waiter already unregistered above, so
      // onChatEnd skips it; original ctx.reqId → SSE matches by reqId).
      await fireTurnError(ctx, ctx.reqId, outcome.reason);
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
    }

    // 5. Await chat:end with a bounded timeout, or sandbox early-exit.
    //    Both failure modes synthesize a terminated outcome so audit-log
    //    still sees chat:end fire exactly once.
    //
    //    We track three mutually-exclusive resolution paths:
    //      a. chat:end fired via the bus (runner emitted event.chat-end;
    //         IPC server's fire flowed into our subscriber which resolved
    //         the deferred). The IPC server ALREADY fired chat:end — do
    //         not re-fire or audit-log double-counts.
    //      b. sandbox process exited without emitting chat-end. chat:end
    //         was NEVER fired — we must fire it ourselves.
    //      c. timeout. chat:end was NEVER fired — we must fire it ourselves.
    let resolvedByChatEndSubscriber = true; // set to false in the non-(a) paths
    const timeoutHandle = setTimeout(() => {
      deferred.reject(new ChatTimeoutError(chatTimeoutMs));
    }, chatTimeoutMs);
    // Don't keep the host event loop alive on a hung chat.
    timeoutHandle.unref?.();

    // Sandbox exit before chat:end is a terminated outcome. Do NOT reject
    // the deferred — resolve it with a structured outcome so the downstream
    // code path (which expects AgentOutcome, not an error) stays uniform.
    handle.exited
      .then(() => {
        if (!deferred.settled) {
          resolvedByChatEndSubscriber = false;
          deferred.resolve({
            kind: 'terminated',
            reason: 'sandbox-exit-before-chat-end',
          });
        }
      })
      .catch(() => {
        // exited shouldn't reject in practice; swallow to keep the orchestrator
        // from crashing on a pathological sandbox provider.
      });

    let outcome: AgentOutcome;
    try {
      outcome = await deferred.promise;
    } catch (err) {
      // Timeout path (or a reject we triggered explicitly). Synthesize.
      resolvedByChatEndSubscriber = false;
      outcome = {
        kind: 'terminated',
        reason: err instanceof ChatTimeoutError ? 'chat-run-timeout' : 'chat-run-error',
        error: err,
      };
    } finally {
      clearTimeout(timeoutHandle);
      unregisterWaiter(sessionId, ctx.reqId);
    }

    // 6. If the chat:end subscriber path didn't win, the runner never
    //    emitted event.chat-end and the IPC server never fired chat:end.
    //    Fire it ourselves so audit-log etc. always see exactly one
    //    chat:end per agent:invoke.
    if (!resolvedByChatEndSubscriber) {
      // Fault A — the turn ended abnormally (sandbox exited before chat:end,
      // or the runner wedged past chatTimeoutMs). Signal the SSE BEFORE
      // chat:end so the client flips out of the spinner. (session:terminate
      // also covers pod-death promptly; firing here is the harmless dup or
      // the only signal on the timeout/error path.)
      if (outcome.kind === 'terminated') {
        await fireTurnError(ctx, ctx.reqId, outcome.reason);
      }
      await bus.fire('chat:end', ctx, { outcome });
    }

    // 7. Kill the sandbox unless we're deliberately leaving it warm. We keep
    //    it warm ONLY on a keepalive turn that COMPLETED. A terminated outcome
    //    (chat-run-timeout, sandbox-exit, chat-run-error) means the runner is
    //    wedged or already gone — and crucially `armReapTimer` only ran if a
    //    chat:turn-end fired, which it didn't on these paths. Leaving such a
    //    session "warm" would strand it (no idle reaper armed) until the
    //    runner's own idle floor or the pod ceiling. So kill it now.
    //    session:terminate is fired by the sandbox provider's own exit
    //    handler, so we don't call it here — that would double-fire.
    const keepWarm = keepAlive && outcome.kind === 'complete';
    if (!keepWarm) {
      try {
        await handle.kill();
      } catch {
        // best-effort
      }
    }

    return outcome;
    } finally {
      // I7 — proxy:close fires exactly once per opened proxy session. We only
      // reach this block AFTER a successful proxy:open-session (Phase 6 made
      // the proxy mandatory and the open-failure path returns earlier), so
      // `proxyOpened` is invariably true here — the close is gated solely on
      // whether it was deferred to handle.exited. In keepalive mode a
      // SUCCESSFUL spawn defers BOTH the proxy close AND the rotation-tracking
      // cleanup to handle.exited (Step 5), so this per-invoke finally only
      // runs them on the one-shot path and the keepalive-spawn-that-failed-
      // before-warming path. Best-effort: a failing close shouldn't mask the
      // chat outcome.
      if (!proxyCloseDeferredToHandle) {
        await bus
          .call<ProxyCloseSessionInput, Record<string, never>>(
            'proxy:close-session',
            ctx,
            { sessionId: ctx.sessionId },
          )
          .catch((err: unknown) => {
            ctx.logger.warn('proxy_close_session_failed', {
              sessionId: ctx.sessionId,
              err: err instanceof Error ? err : new Error(String(err)),
            });
          });
        // I10 — drop the rotation flag on the non-warm paths only. A warm
        // session must keep rotating across turns, so its cleanup is deferred
        // to handle.exited (Step 5); clearing it here would disable
        // proxy:rotate-session for every turn after the first.
        sessionsNeedingRotation.delete(ctx.sessionId);
      }
    }
  }

  async function onChatEnd(
    ctx: AgentContext,
    payload: { outcome: AgentOutcome },
  ): Promise<void> {
    const resolvedReqId = resolveWaiterFor(ctx.reqId, ctx.sessionId, payload.outcome);
    // F2b — surface a turn-error when the runner itself reports a terminated
    // outcome (e.g. it POSTed event.chat-end{terminated} before crashing on a
    // resume of an interrupted transcript). That path resolves the deferred,
    // so resolvedByChatEndSubscriber stays true and the chokepoint fireTurnError
    // is skipped; no chat:turn-end fires either, so without this the SSE would
    // hang on "Thinking…" / "Starting sandbox…" forever.
    //
    // Gates:
    //   - resolvedReqId !== undefined: only when THIS chat:end ended a turn
    //     that was still in flight. The chokepoint paths settle the deferred
    //     before firing chat:end (→ undefined here, their own explicit
    //     fireTurnError is the one fire), and a reaped warm runner's late
    //     terminated chat:end after a completed turn has no live waiter (→
    //     undefined, no spurious fire).
    //   - kind !== 'complete': a normal completed turn must NEVER surface as
    //     an error.
    //
    // The IPC server RESTAMPS ctx.reqId per request, so ctx.reqId can't join
    // the SSE — but resolveWaiterFor recovered the ORIGINAL agent:invoke reqId
    // (the SSE's precise per-turn key), so we fire with that. Matching by reqId
    // (not conversationId) avoids closing a co-resident turn's stream when two
    // concurrent invokes share a conversation.
    if (resolvedReqId !== undefined && payload.outcome.kind !== 'complete') {
      await fireTurnError(ctx, resolvedReqId, payload.outcome.reason);
    }
    // Forget any cancel bookkeeping for this session (set stays bounded in a
    // long-lived host).
    cancelledSessions.delete(ctx.sessionId);
  }

  function onTurnEnd(ctx: AgentContext, payload?: { reqId?: string }): void {
    // I10 — rotate proxy credentials BEFORE the one-shot cancel, so that any
    // tool-call follow-ups inside the same turn (model→tool→model) pick up
    // the refreshed token. api-key-only sessions skip rotation: their kind
    // never refreshes, and Phase 2's coarse mode is the desired behavior.
    //
    // The rotation is fire-and-forget: a failing rotate (network blip,
    // refresh-failed) shouldn't kill the chat. The credentials facade's
    // resolve sub-service is what decides whether to refresh; if refresh
    // fails the next request through the proxy will fail with 401 and the
    // user sees a clear error path (I9).
    if (sessionsNeedingRotation.has(ctx.sessionId)) {
      void bus
        .call<{ sessionId: string }, { envMap: Record<string, string> }>(
          'proxy:rotate-session',
          ctx,
          { sessionId: ctx.sessionId },
        )
        .catch((err: unknown) => {
          ctx.logger.warn('proxy_rotate_session_failed', {
            sessionId: ctx.sessionId,
            err: err instanceof Error ? err : new Error(String(err)),
          });
        });
    }

    if (keepAlive) {
      // Keepalive: the turn is complete. The real reply already streamed via
      // SSE and persisted via chat:turn-end → conversations; channel-web
      // dispatched agent:invoke fire-and-forget, so this synthesized outcome
      // is unused by the caller. Resolve the per-request waiter, leave the
      // runner WARM (no cancel), and arm the idle reaper (Task 5).
      // Idempotent across the two turn-ends one user message emits.
      resolveWaiterFor(payload?.reqId, ctx.sessionId, { kind: 'complete', messages: [] });
      armReapTimer(ctx);
      return;
    }

    // One-shot mode: the runner just finished processing the single user
    // message and is now waiting on inbox.next() for another. We don't have
    // one, so queue a cancel — the runner's inbox loop will receive it,
    // break out of its outer loop, emit event.chat-end, and exit cleanly.
    //
    // Guards:
    //   - oneShot must be true (multi-message hosts opt out).
    //   - sessionId must be an in-flight agent:invoke (skip unrelated turn-ends).
    //     Waiter map is keyed by ctx.reqId, but the IPC server stamps a
    //     fresh ctx.reqId per request, so we check via the sessionId index.
    //     Cancel target is ctx.sessionId (the session we want to terminate).
    //   - don't double-queue per session (a runner that fires turn-end
    //     twice must not queue two cancels for the same session).
    if (!oneShot) return;
    const liveReqIds = reqIdsBySession.get(ctx.sessionId);
    if (liveReqIds === undefined || liveReqIds.size === 0) return;
    if (cancelledSessions.has(ctx.sessionId)) return;
    cancelledSessions.add(ctx.sessionId);
    // Fire-and-forget. If this fails (e.g. session already terminated), the
    // sandbox-exit path will resolve the deferred as terminated and the chat
    // still completes cleanly — logging is enough.
    void bus
      .call<SessionQueueWorkInput, SessionQueueWorkOutput>(
        'session:queue-work',
        ctx,
        { sessionId: ctx.sessionId, entry: { type: 'cancel' } },
      )
      .catch((err) => {
        ctx.logger.warn('one_shot_cancel_queue_failed', {
          sessionId: ctx.sessionId,
          err,
        });
      });
  }

  // JIT (design §7/§11.5): apply a user-approved capability grant, then retire
  // the conversation's warm session so the NEXT turn re-spawns and resumes
  // (the runner reads skills only at session init — main.ts "frozen at spawn").
  // Host-side only; never an IPC action. The channel re-issues the turn (web:
  // chat.regenerate) — this hook is the control-plane prep, not the answer turn.
  async function applyCapabilityGrant(
    ctx: AgentContext,
    input: ApplyCapabilityGrantInput,
  ): Promise<ApplyCapabilityGrantOutput> {
    // 1. Resolve the catalog skill's declared slots so we can bind every one
    //    (skills:attach-for-user requires a binding for each — see
    //    validateAttachmentBindings; a partially-bound attachment is rejected).
    let declaredSlots: Array<{ slot: string; account?: string }> = [];
    if (bus.hasService('skills:resolve')) {
      const r = await bus.call<SkillsResolveInput, SkillsResolveOutput>(
        'skills:resolve',
        ctx,
        { skillIds: [input.skillId], ownerUserId: input.userId },
      );
      declaredSlots =
        r.skills[0]?.capabilities.credentials.map((c) => ({
          slot: c.slot,
          ...(c.account !== undefined ? { account: c.account } : {}),
        })) ?? [];
    }

    // 2. Derive per-slot bindings. A slot tagged `account: <svc>` binds the
    //    SHARED user vault entry `account:<svc>` (JIT P2/decision #13) — entered
    //    once, reused by every skill naming the same service. An untagged slot
    //    keeps the per-skill `skill:<id>:<slot>` ref (the deterministic ref the
    //    card wrote each key to). The card (request_capability + the
    //    PermissionCard POST) derives the IDENTICAL ref from the same manifest,
    //    so the stored key and this binding always address the same row.
    //    Local re-derivation — no @ax/credentials import (I2), same posture as
    //    credentials-admin-routes inlining refForDestination. A slotless skill
    //    binds {}.
    const credentialBindings: Record<string, string> = {};
    for (const s of declaredSlots) {
      credentialBindings[s.slot] =
        s.account !== undefined ? `account:${s.account}` : `skill:${input.skillId}:${s.slot}`;
    }

    // 3. Attach for the user (TASK-33). Errors propagate as PluginError — the
    //    caller (the decision endpoint) maps them to an HTTP error.
    let attached = false;
    if (bus.hasService('skills:attach-for-user')) {
      const r = await bus.call<
        {
          userId: string;
          agentId: string;
          skillId: string;
          credentialBindings: Record<string, string>;
        },
        { created: boolean }
      >('skills:attach-for-user', ctx, {
        userId: input.userId,
        agentId: input.agentId,
        skillId: input.skillId,
        credentialBindings,
      });
      attached = r.created;
    }

    // 4. Retire the conversation's warm session (if any is alive) so the next
    //    turn takes the fresh path → fresh sandbox + options.resume (it reads
    //    the now-attached skill). session:terminate clears active_session_id
    //    (not runner_session_id), so resume survives. No live waiter exists for
    //    a finished keepAlive turn, so onSessionTerminate fires no turn-error.
    const warm = await activeAliveSession(ctx, input.conversationId, input.userId);
    if (warm !== null) {
      try {
        await bus.call('session:terminate', ctx, { sessionId: warm });
      } catch (err) {
        ctx.logger.warn('apply_capability_grant_retire_failed', {
          conversationId: input.conversationId,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    return { attached };
  }

  // Resolve the conversation's ACTIVE + ALIVE session id (or null). Shared by
  // the catalog + authored grant paths (retire / live-widen). Best-effort: any
  // lookup failure → null (the next turn's route-vs-fresh self-corrects).
  async function activeAliveSession(
    ctx: AgentContext,
    conversationId: string,
    userId: string,
  ): Promise<string | null> {
    if (!bus.hasService('conversations:get') || !bus.hasService('session:is-alive')) return null;
    try {
      const conv = await bus.call<ConversationsGetInput, ConversationsGetOutput>(
        'conversations:get', ctx, { conversationId, userId },
      );
      const candidate = conv.conversation.activeSessionId;
      if (candidate === null || candidate.length === 0) return null;
      const alive = await bus.call<SessionIsAliveInput, SessionIsAliveOutput>(
        'session:is-alive', ctx, { sessionId: candidate },
      );
      return alive.alive ? candidate : null;
    } catch (err) {
      ctx.logger.warn('active_session_lookup_failed', {
        conversationId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return null;
    }
  }

  // Phase 4 PR-B — apply a user-approved authored-skill capability grant. The
  // host re-derives authored-ness (D-B7: server-authoritative); a skillId not
  // found in the agent's drafted skills signals not-authored → the channel-web
  // route falls back to the catalog grant. When it IS a draft, approve its
  // proposalDelta (hosts/slots/packages; mcp deferred — D-B2), write approval
  // rows, then activate: credential delta → re-spawn; host/pkg-only → live widen.
  async function applyAuthoredCapabilityGrant(
    ctx: AgentContext,
    input: ApplyAuthoredCapabilityGrantInput,
  ): Promise<ApplyAuthoredCapabilityGrantOutput> {
    // 1. Re-resolve the agent's authored drafts — the HOST is the authority on
    //    which path runs (D-B7). A skillId that is not a draft is a catalog
    //    skill; signal not-authored so the route falls back to the catalog grant.
    //
    //    FIX 2 (catalog isolation): wrap the bus.call in try/catch. If
    //    agents:resolve-authored-skills throws (workspace:list/read hiccup,
    //    quarantine-get error, etc.) we return not-authored so the route falls
    //    back to the independent catalog grant — catalog approvals must not be
    //    broken by workspace or DB outages that are unrelated to the catalog path.
    let drafts: AuthoredResolvedSkillForOrch[] = [];
    if (bus.hasService('agents:resolve-authored-skills')) {
      try {
        const r = await bus.call<
          { ownerUserId: string; agentId: string },
          AgentsResolveAuthoredSkillsOutput
        >('agents:resolve-authored-skills', ctx, {
          ownerUserId: input.userId,
          agentId: input.agentId,
        });
        drafts = r.skills;
      } catch (err) {
        // Resolve failure: treat as "not an authored skill" so the catalog grant
        // path stays available. A workspace/DB hiccup here must not block
        // catalog-skill approvals (they are independent).
        ctx.logger.warn('authored_grant_resolve_failed', {
          agentId: input.agentId,
          skillId: input.skillId,
          err: err instanceof Error ? err.message : String(err),
        });
        return { applied: false, reason: 'not-authored' };
      }
    }
    const draft = drafts.find((s) => s.id === input.skillId);
    if (draft === undefined) return { applied: false, reason: 'not-authored' };

    // 2. Build the approval rows from the re-resolved CURRENT proposalDelta
    //    (hosts/slots/packages; mcp deferred — D-B2).
    //
    //    FIX 1 (TOCTOU guard): if `shown` is present, filter each kind to only
    //    entries that were ALSO present in `shown` (what the user saw on the
    //    card). An agent that widens its draft mid-flight cannot sneak in
    //    unshown caps — anything in the current delta but not in `shown` is
    //    silently skipped (it remains unapproved; the next spawn fires its own
    //    card for the remainder). When `shown` is absent (back-compat), the
    //    full current delta is approved unchanged.
    const delta = draft.proposalDelta;
    const deltaNpm = delta.packages?.npm ?? [];
    const deltaPypi = delta.packages?.pypi ?? [];

    // Intersection helpers — present only when `shown` is provided.
    const shownHostSet = input.shown !== undefined ? new Set(input.shown.hosts) : null;
    const shownSlotSet = input.shown !== undefined ? new Set(input.shown.slots) : null;
    const shownNpmSet  = input.shown !== undefined ? new Set(input.shown.npm)   : null;
    const shownPypiSet = input.shown !== undefined ? new Set(input.shown.pypi)  : null;

    const approvedHosts = shownHostSet !== null
      ? delta.allowedHosts.filter((h) => shownHostSet.has(h))
      : delta.allowedHosts;
    const approvedCreds = shownSlotSet !== null
      ? delta.credentials.filter((c) => shownSlotSet.has(c.slot))
      : delta.credentials;
    const approvedNpm = shownNpmSet !== null
      ? deltaNpm.filter((p) => shownNpmSet.has(p))
      : deltaNpm;
    const approvedPypi = shownPypiSet !== null
      ? deltaPypi.filter((p) => shownPypiSet.has(p))
      : deltaPypi;

    const rows: Array<{
      kind: 'host' | 'slot' | 'npm' | 'pypi';
      value: string;
      detail?: { kind: 'api-key'; account?: string };
    }> = [
      ...approvedHosts.map((h) => ({ kind: 'host' as const, value: h })),
      ...approvedCreds.map((c) => ({
        kind: 'slot' as const,
        value: c.slot,
        detail: { kind: 'api-key' as const, ...(c.account !== undefined ? { account: c.account } : {}) },
      })),
      ...approvedNpm.map((p) => ({ kind: 'npm' as const, value: p })),
      ...approvedPypi.map((p) => ({ kind: 'pypi' as const, value: p })),
    ];

    // 3. Write the approval rows (host-side store, outside the agent's reach).
    //    DELIBERATE fail-loud: a write error PROPAGATES (the route returns 500),
    //    NOT best-effort-swallow. Swallowing would report `applied:true` while
    //    silently failing to approve a cap — an "approved" host would stay
    //    unreachable (a silent failure the user never sees). Propagating surfaces
    //    it; `skills:approved-caps-set` is idempotent, so a retry re-writes the
    //    (now-smaller) delta and converges. Do NOT "fix" this into a swallow.
    if (bus.hasService('skills:approved-caps-set')) {
      for (const row of rows) {
        await bus.call('skills:approved-caps-set', ctx, {
          ownerUserId: input.userId,
          agentId: input.agentId,
          skillId: input.skillId,
          kind: row.kind,
          value: row.value,
          ...(row.detail !== undefined ? { detail: row.detail } : {}),
        });
      }
    }

    // 3b. Flip the authored row pending→active (TASK-76, §D3 "on approve … flips
    //     to active"). A human just approved this skill at the card, so it stops
    //     being a pending "no bytes project" draft — the next spawn's projection
    //     now includes its body bytes + the approved caps. Status-guarded in the
    //     store (only a pending row flips; quarantined stays quarantined). Same
    //     fail-loud posture as the caps writes above: a flip error propagates
    //     rather than silently leaving the skill stuck pending after an approval.
    //     hasService-guarded — a preset without @ax/skills (CLI stub) no-ops.
    if (bus.hasService('skills:authored-activate')) {
      await bus.call('skills:authored-activate', ctx, {
        ownerUserId: input.userId,
        agentId: input.agentId,
        skillId: input.skillId,
      });
    }

    // 4. Drop the upfront-card dedup for this conversation so the next spawn
    //    re-evaluates the now-smaller delta (re-fires only if something remains).
    //    TASK-83: the My Skills "approve early" path has no conversation — there's
    //    no per-conversation card to dedup-drop, so skip this when absent.
    const convId = input.conversationId;
    if (convId !== undefined) upfrontCardsByConv.delete(convId);
    // TASK-86 — the skill is no longer pending (it just flipped to active), so
    // drop its proposing-conversation scope record (bounded-map hygiene).
    pendingSkillConversation.delete(input.skillId);

    // 5. Activate per the asymmetry (design table): ANY SHOWN credential slot →
    //    env var frozen at spawn → re-spawn. Else host/package-only → live widen.
    //    FIX 1: use `approvedCreds` (shown-intersection) so an unshown credential
    //    slot does NOT trigger a re-spawn that the user never approved.
    //    TASK-83: with no conversation (early approval) there is no warm session
    //    to retire or widen — the approval rows + activate above are the whole
    //    effect, and the user's next turn cold-spawns with the skill approved.
    const needsRespawn = approvedCreds.length > 0;
    if (needsRespawn) {
      const warm =
        convId !== undefined
          ? await activeAliveSession(ctx, convId, input.userId)
          : null;
      let respawned = false;
      if (warm !== null) {
        try {
          await bus.call('session:terminate', ctx, { sessionId: warm });
          respawned = true;
        } catch (err) {
          ctx.logger.warn('authored_grant_retire_failed', {
            conversationId: input.conversationId,
            err: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
      // `respawned` reports "did we retire a warm session THIS call", NOT "is a
      // respawn needed". When there's no warm session (warm === null),
      // respawned:false is correct/expected: the next turn has no warm session
      // to reuse, so it cold-spawns fresh and PC-1 folds the now-approved
      // credential into that spawn — the credential activates on the next turn
      // regardless of whether we retired anything here.
      return { applied: true, respawned };
    }

    // Host/package-only → live widen on the conversation's warm session.
    // FIX 1: use `approvedHosts`/`approvedNpm`/`approvedPypi` (shown-filtered)
    // so only hosts the user saw on the card get live-added.
    const liveHosts = [...approvedHosts];
    if (approvedNpm.length > 0) liveHosts.push('registry.npmjs.org');
    if (approvedPypi.length > 0) liveHosts.push('pypi.org', 'files.pythonhosted.org');
    if (liveHosts.length > 0 && bus.hasService('proxy:add-host') && convId !== undefined) {
      const warm = await activeAliveSession(ctx, convId, input.userId);
      if (warm !== null) {
        for (const host of liveHosts) {
          try {
            await bus.call('proxy:add-host', ctx, { sessionId: warm, host });
          } catch (err) {
            ctx.logger.warn('authored_grant_add_host_failed', {
              host,
              err: err instanceof Error ? err : new Error(String(err)),
            });
          }
        }
      }
    }
    return { applied: true, respawned: false };
  }

  return {
    runAgentInvoke,
    onChatEnd,
    onTurnEnd,
    onSessionTerminate,
    applyCapabilityGrant,
    applyAuthoredCapabilityGrant,
    onHttpEgress,
    onSkillsProposed,
  };
}

// A distinct error type so the runAgentInvoke finally block can tell "we timed out"
// apart from "something else went wrong awaiting the deferred."
class ChatTimeoutError extends Error {
  constructor(ms: number) {
    super(`agent:invoke timed out after ${ms}ms`);
    this.name = 'ChatTimeoutError';
  }
}

/**
 * Translate `@ax/credential-proxy`'s `proxyEndpoint` (either `unix:///path/to/sock`
 * or `tcp://host:port`) into the boundary-agnostic `ProxyConfig` shape that
 * threads into `sandbox:open-session`. Subprocess sandbox uses the TCP
 * loopback URL as `endpoint`; k8s sandbox passes through the Unix socket
 * path so the runner-side bridge can convert it to a local TCP port inside
 * the sandbox (where the runner has no other network reach).
 */
function endpointToProxyConfig(
  rawEndpoint: string,
  caCertPem: string,
  envMap: Record<string, string>,
  proxyAuthToken?: string,
): ProxyConfig {
  // Spread the token in conditionally so `exactOptionalPropertyTypes` doesn't
  // reject `proxyAuthToken: undefined` (TASK-52). It's an attribution label;
  // when the proxy plugin omits it, proxyConfig stays as it was before.
  const token = proxyAuthToken !== undefined ? { proxyAuthToken } : {};
  if (rawEndpoint.startsWith('unix://')) {
    return {
      unixSocketPath: rawEndpoint.slice('unix://'.length),
      caCertPem,
      envMap,
      ...token,
    };
  }
  if (rawEndpoint.startsWith('tcp://')) {
    return {
      endpoint: 'http://' + rawEndpoint.slice('tcp://'.length),
      caCertPem,
      envMap,
      ...token,
    };
  }
  throw new PluginError({
    code: 'invalid-proxy-endpoint',
    plugin: PLUGIN_NAME,
    message: `unrecognized proxy endpoint scheme: ${rawEndpoint}`,
  });
}

// ---------------------------------------------------------------------------
// TASK-66 (out-of-git Part B / B1) — persist the user turn into the display
// event log host-side.
//
// The display event log (the redisplay SoT) needs the user's own message so a
// reloaded chat renders the user's bubble. The runner's `event.turn-end` only
// ships tool/assistant turns; firing a runner-side user turn-end would trip
// the host's turn-end side effects (the conversationId-keyed SSE done-frame
// closer, one-shot keep-warm, clear-active-req-id). So the host persists the
// user turn here instead, off the turn-end path.
//
// The display content = the typed text as a text block + any attachment
// contentBlocks (the chat UI renders an `attachment` block as a download
// chip). I2: we call `conversations:append-event` over the bus with a
// duck-typed payload (no @ax/conversations import). Gated on the hook being
// registered; best-effort — a persist failure logs + returns (the chat still
// runs; only this turn's redisplay loses the user bubble). conversationId is
// host-stamped on ctx.
// ---------------------------------------------------------------------------
interface AppendEventCall {
  conversationId: string;
  kind: 'turn';
  role: 'user';
  payload: { blocks: unknown[] };
}

async function persistUserDisplayTurn(
  bus: HookBus,
  ctx: AgentContext,
  message: AgentMessage,
): Promise<void> {
  const conversationId = ctx.conversationId;
  if (conversationId === undefined) return;
  if (!bus.hasService('conversations:append-event')) return;

  const text = typeof message.content === 'string' ? message.content : '';
  const attachmentBlocks = Array.isArray(message.contentBlocks)
    ? message.contentBlocks
    : [];
  const blocks: unknown[] = [
    ...(text.length > 0 ? [{ type: 'text', text }] : []),
    ...attachmentBlocks,
  ];
  // Nothing displayable (no text, no blocks) → nothing to persist.
  if (blocks.length === 0) return;

  try {
    await bus.call<AppendEventCall, void>(
      'conversations:append-event',
      ctx,
      { conversationId, kind: 'turn', role: 'user', payload: { blocks } },
    );
  } catch (err) {
    ctx.logger.warn('orchestrator_persist_user_turn_failed', {
      conversationId,
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
