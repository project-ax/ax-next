import {
  PluginError,
  PROVIDER_ENDPOINTS,
  parseModelRef,
  providerEndpointFor,
  type AgentContext,
  type AgentMessage,
  type AgentOutcome,
  type FireResult,
  type HookBus,
} from '@ax/core';
// Shared `sandbox:open-session` contract. The orchestrator CONSTRUCTS the
// payload (it doesn't validate — trust comes from skills:resolve / agents:resolve
// having parsed upstream), so it imports the inferred TYPES only. Type-only
// imports across plugins are allowed (erased at compile time); this keeps the
// orchestrator's `AgentConfig` / `ProxyConfig` shapes pinned to the same
// definition the sandbox backends validate against. See @ax/sandbox-protocol.
import { formatServiceDiagnosis } from '@ax/sandbox-protocol';
import type { AgentConfig, ProxyConfig, ServiceDescriptorParsed } from '@ax/sandbox-protocol';
import {
  buildAuthoredConnectorCard,
  authoredConnectorCardDedupKey,
  hasConnectorShownSurface,
} from './connector-card.js';
import {
  skillCredentialEnvName,
  projectEnvMapToBareNames,
} from './credential-namespace.js';
import {
  resolveEffectiveConnectors,
  resolveSkillReferencedConnectors,
  copyConnectorDefaultsForSession,
  partitionConnectorsBySignIn,
  skippedConnectorsPromptLine,
  foldConnectorCaps,
  stampConnectorHeaders,
  connectorCredentialEnvName,
  reconnectDetail,
  connectorSetFingerprint,
  type ResolvedConnectorForOrch,
  ConnectorServiceCollisionError,
  type FoldConnectorResult,
} from './connector-union.js';
import {
  isNeedsReconnect,
  isCredentialNotFound,
  failedCredentialEnvName,
  credentialResolveFailures,
  errorLogFields,
} from './proxy-errors.js';
import {
  classifyRunnerExit,
  runnerExitLogFields,
  type RunnerExitInfo,
} from './runner-exit.js';

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

/**
 * One row of the admin "Providers" panel: which model provider exists, what to
 * call it, and which credential slot holds its API key.
 *
 * NOTE — `packages/channel-web/src/components/admin/ProvidersPanel.tsx` keeps a
 * HAND-WRITTEN MIRROR of this list (invariant 2 forbids the cross-plugin
 * import, and @ax/core is server-side-only in channel-web today). Adding a
 * provider to `PROVIDER_ENDPOINTS` therefore means adding the matching row
 * there too — the field names below are the mirror's contract.
 */
export interface KnownProvider {
  /** Provider id — the first segment of a `provider/model-id` ref. */
  provider: string;
  /** Human label for admin surfaces. */
  name: string;
  /** Credential slot (env var) that carries this provider's API key. */
  slot: string;
  /** One line of help text under the row. */
  description: string;
}

/**
 * Derived from @ax/core's `PROVIDER_ENDPOINTS` — the single table both sides of
 * the sandbox boundary read (see `packages/core/src/providers.ts`). Deriving it
 * rather than restating it means a new provider can't be reachable-but-invisible
 * (or visible-but-unreachable) in the admin UI.
 */
export const KNOWN_PROVIDERS: readonly KnownProvider[] = Object.freeze(
  Object.values(PROVIDER_ENDPOINTS).map((ep) =>
    Object.freeze({
      provider: ep.id,
      name: ep.name,
      slot: ep.credentialEnvVar,
      description: ep.description,
    }),
  ),
);

export interface ChatOrchestratorConfig {
  /**
   * Runner id → absolute path to that runner's dist/main.js.
   *
   * PR 2 (design doc `2026-08-18-provider-agnostic-runner-design.md` §1): the
   * agent row carries a runner **id** (`'claude-sdk'`, …), never a path. The
   * id → path mapping is host config and lives here alone; only the resolved
   * absolute path crosses `sandbox:open-session`, exactly as before. That
   * boundary is the point of the change — see the PR's boundary review.
   *
   * Not validated here (the sandbox plugin does that). An agent whose runner
   * id has no entry fails the turn: silently falling back to some other
   * runner would run the agent on a runner the operator did not select.
   */
  runnerBinaries: Readonly<Record<string, string>>;
  // Bounded wait for chat:end. Defaults to 10 min. If the runner crashes or
  // hangs without emitting chat-end, we synthesize a terminated outcome
  // after this elapses.
  chatTimeoutMs?: number;
  /**
   * Bound on each `chat:start` subscriber, in ms. Defaults to
   * `CHAT_START_SUBSCRIBER_TIMEOUT_MS` (60 s); a subscriber past it is skipped
   * and the turn proceeds. Exposed so tests need not wait a minute.
   */
  chatStartSubscriberTimeoutMs?: number;
  /**
   * Bound on each subscriber of the `chat:end`, `chat:turn-error` and
   * `chat:permission-request` fires THIS plugin makes, in ms. Defaults to
   * `CHAT_EVENT_SUBSCRIBER_TIMEOUT_MS` (30 s). Exposed so tests need not wait.
   */
  chatEventSubscriberTimeoutMs?: number;
  /**
   * TASK-878 — how long a caller waits on `proxy:close-session` before it
   * logs `proxy_close_session_timeout` and moves on (to `session:terminate`,
   * to the fresh spawn, to returning the turn's outcome). Defaults to
   * `PROXY_CLOSE_TIMEOUT_MS` (10 s). `Infinity` waits for the bus's own
   * service timeout. Exposed so tests need not wait.
   */
  proxyCloseTimeoutMs?: number;
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

// TASK-688 — Stop cancels the in-flight turn. Domain identifiers in, a boolean
// out: NO backend vocabulary (session ids, inbox cursors, pod names) crosses
// this hook. `interrupted:true` means "a stop is on its way to the turn" (queued
// now, or deferred behind a user message that is still being queued);
// `interrupted:false` means there was nothing to stop (no turn in flight, or its
// session is already gone).
export interface AgentInterruptInput {
  conversationId: string;
  userId: string;
}
export interface AgentInterruptOutput {
  interrupted: boolean;
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

// TASK-94 — authored-CONNECTOR approval grant I/O. Mirrors the authored-skill
// grant exactly (the same TOCTOU `shown` guard semantics), but the SUBJECT is a
// connector: the grant writes connector-subject approved-caps rows (the TASK-93
// wall, `skills:approved-caps-set` with `connectorId`) and flips the connector
// draft pending→active (`connectors:activate-authored`). `applied:false,
// reason:'not-authored'` signals an unknown connectorId (not one of this
// agent's authored drafts).
export interface ApplyAuthoredConnectorGrantInput {
  /** OPTIONAL — present for the in-chat card (retires the warm session so the
   *  next turn re-spawns with the now-active connector); absent for an
   *  approve-ahead path that has no live conversation. */
  conversationId?: string;
  userId: string;
  agentId: string;
  connectorId: string;
  /** What the card displayed — absent ⟹ approve the full current proposal. */
  shown?: { hosts: string[]; slots: string[]; npm: string[]; pypi: string[] };
}
export type ApplyAuthoredConnectorGrantOutput =
  | { applied: true; respawned: boolean }
  | { applied: false; reason: 'not-authored' };

// connectors:list-authored — registered by @ax/connectors (TASK-94). Duplicated
// structurally per I2 (no @ax/connectors import). Conditionally called via
// bus.hasService — NOT declared in the manifest, same convention as the
// authored-skill / conversations peers.
interface ConnectorsListAuthoredOutput {
  drafts: Array<{
    connectorId: string;
    name: string;
    usageNote: string;
    keyMode: 'personal' | 'workspace';
    status: 'pending' | 'active';
    proposal: {
      allowedHosts: string[];
      credentials: Array<{ slot: string; kind: string; account?: string; description?: string }>;
      mcpServers: unknown[];
      packages: { npm: string[]; pypi: string[] };
    };
  }>;
}

// connectors:upsert — registered by @ax/connectors (TASK-97). Duplicated
// structurally per I2 (no @ax/connectors import). Conditionally called via
// bus.hasService — NOT declared in the manifest, same convention as the peers
// above. TASK-113 — on approval the grant PROMOTES the approved authored
// connector into the curated registry through this hook, so the EXISTING
// registry read paths (resolveEffectiveConnectors → foldConnectorCaps, the UI
// surfaces) pick it up with NO further changes (invariant #4 — one source of
// truth; the authored table stays draft/proposal staging only).
interface ConnectorsUpsertInput {
  userId: string;
  connectorId: string;
  name: string;
  description: string;
  usageNote: string;
  keyMode: 'personal' | 'workspace';
  visibility: 'private' | 'shared';
  capabilities: {
    allowedHosts: string[];
    credentials: Array<{ slot: string; kind: string; account?: string; description?: string }>;
    mcpServers: unknown[];
    packages: { npm: string[]; pypi: string[] };
  };
}

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
  //
  // `cancel` and `interrupt` are DIFFERENT and must never be confused:
  //   - `cancel`    ends the SESSION (the runner drains and exits).
  //   - `interrupt` stops the RUNNING TURN and leaves the runner warm (Stop
  //     button, TASK-688). It carries no payload.
  entry:
    | { type: 'user-message'; payload: AgentMessage; reqId: string }
    | { type: 'cancel' }
    | { type: 'interrupt' };
}
interface SessionQueueWorkOutput {
  cursor: number;
}
interface SessionTerminateInput {
  sessionId: string;
}

// `tool-policy:list-agent-overrides` — the agent's stored per-tool verdicts.
// Shape duplicated here (no cross-plugin import); the response is validated
// defensively by `deniedToolKeys` because it is read as `unknown`.
interface ToolPolicyListAgentOverridesInput {
  agentId: string;
}

/**
 * Canonical tool keys the agent's policy DENIES — a row whose `verdict` OR
 * `ceiling` is `'deny'` (a ceiling of deny means the tool can never be
 * allowed, so offering it is pointless). Deduped + sorted for a stable
 * snapshot. Anything malformed (non-object response, non-array `overrides`,
 * a row without a string `toolKey`) contributes nothing — this feeds catalog
 * hygiene, never enforcement, so the safe failure is "no extra denies".
 */
export function deniedToolKeys(out: unknown): string[] {
  if (typeof out !== 'object' || out === null) return [];
  const overrides = (out as { overrides?: unknown }).overrides;
  if (!Array.isArray(overrides)) return [];
  const keys = new Set<string>();
  for (const row of overrides) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as { toolKey?: unknown; verdict?: unknown; ceiling?: unknown };
    if (typeof r.toolKey !== 'string' || r.toolKey.length === 0) continue;
    if (r.verdict === 'deny' || r.ceiling === 'deny') keys.add(r.toolKey);
  }
  return [...keys].sort();
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
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  /**
   * PR 2 — runner selection. An **id** (`'claude-sdk'`, `'aisdk'`), never a
   * path or module specifier: the orchestrator maps it to a binary through
   * `ChatOrchestratorConfig.runnerBinaries`. @ax/agents owns the allow-list;
   * this side only looks the id up and fails loudly on a miss.
   */
  runner: string;
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
  /**
   * TASK-107 — the connector ids this agent is attached to (the agent row's
   * `connector_attachments` store, replacing TASK-98's `mcpConfigIds` stopgap).
   * Forwarded to `connectors:list-effective`, which resolves each; the
   * orchestrator folds its Capabilities into the session (one source of the
   * effective set, alongside the owner's legacy items). Opaque connector-id slugs — no
   * backing mechanism vocab. Empty/absent ⟹ no attached connectors (back-compat with a
   * resolve impl predating the field).
   */
  connectorAttachments?: string[];
  /**
   * TASK-739 — connector ids removed from this agent that would otherwise
   * arrive as a legacy-owned item (the agent row's `connector_exclusions`).
   * Forwarded to `connectors:list-effective`. Absent ⟹ no exclusions.
   */
  connectorExclusions?: string[];
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
  transport: 'http';
  url?: string;
  allowedHosts: string[];
  credentials: Array<{ slot: string; kind: string; description?: string; account?: string }>;
  headers?: Record<string, string>;
}
export interface ResolvedSkillForOrch {
  id: string;
  bodyMd: string;
  manifestYaml: string;
  // JIT Phase 1a — extra (non-SKILL.md) bundle files from skills:resolve.
  // Optional + `?? []` at the construction site for back-compat with a
  // skills:resolve impl that predates the bundle field.
  files?: { path: string; contents: string }[];
  // TASK-92 / TASK-111 — the skill's top-level `connectors[]` soft-dependency
  // reference list (a flat list of opaque connector-id slugs). @ax/skills'
  // `skills:resolve` returns this (ResolvedSkill.connectors); the mirror surfaces
  // it so the orchestrator resolves each referenced connector into sandbox caps
  // via `connectors:resolve` (the skill→connector cap-resolution bridge — see
  // resolveSkillReferencedConnectors). TASK-100 — this is the ONLY reach a skill
  // declares now (the capability block was removed). Optional + `?? []` at the
  // read site for back-compat with a projection that predates the field. NEVER
  // carries backing-mechanism vocab (just connector-id slugs).
  connectors?: string[];
}
interface SkillsResolveOutput {
  skills: ResolvedSkillForOrch[];
}

// agents:resolve-authored-skills — registered by @ax/agents (Phase 3 A2).
// Returns the agent's own self-authored draft skills (quarantine-filtered).
// Duplicated structurally per I2 (no @ax/agents import). Conditionally called via
// bus.hasService — NOT declared in the manifest, same convention as
// skills:resolve / skills:list-defaults.
/** Authored-draft projection mirror (structurally mirrors @ax/agents'
 * AuthoredResolvedSkill — NOT an import, per invariant #2). Adds `description`
 * (used for context/logging).
 *
 * TASK-100 — a skill declares no capabilities, so there is no per-skill
 * `proposalDelta` and no per-skill capability approval card: a model-authored
 * skill is zero-reach instruction scaffolding, and its connectors' reach is
 * gated by the connector approval card. The skill's connectors[] (inherited from
 * ResolvedSkillForOrch) feed the skill→connector bridge. */
export interface AuthoredResolvedSkillForOrch extends ResolvedSkillForOrch {
  description: string;
  /** Gate verdict (TASK-76, §D3). Only `active` skills materialize their bytes
   * into the spawn union; a `pending` skill projects NOTHING (no body, no
   * name/description in context). Optional for back-compat with an agents
   * projection that predates the field (defaults to `active`). */
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
  /**
   * envName → { ref to credentials store, kind hint for downstream policy,
   * allowedHosts: the hosts this credential's placeholder may be SUBSTITUTED
   * for }.
   *
   * `allowedHosts` is the credential BINDING (TASK-687): independent of
   * `allowlist` above. The allowlist answers "where may this session reach";
   * the binding answers "where may THIS credential's real value be sent".
   * The proxy substitutes a placeholder only on egress to a host in its own
   * credential's `allowedHosts`; absent/empty => never substituted (default
   * deny). The orchestrator fills it only from sources the model/user cannot
   * set for the session — never from the (user-widenable) allowlist.
   */
  credentials: Record<string, ProxyCredentialEntry>;
}

/**
 * One credential in the `proxy:open-session` input.
 *
 * `metered` (TASK-715) marks the MODEL-PROVIDER key: the operator pays for what
 * it spends, and code in the sandbox can drive it just as the runner does. When
 * present, the proxy (a) splices this credential only into requests matching
 * `requests` (`"METHOD /path"`, from the provider table) and (b) counts what
 * those calls use and stops splicing once the user is over their limit. Only the
 * provider-default path sets it, from `PROVIDER_ENDPOINTS` (code, not a store
 * row); nothing the model or the user typed can add or widen it.
 */
interface ProxyCredentialEntry {
  ref: string;
  kind: string;
  allowedHosts?: string[];
  metered?: { requests: string[] };
}
interface ProxyOpenSessionOutput {
  /** `unix:///path/to/sock` OR `tcp://127.0.0.1:<port>` — translated below. */
  proxyEndpoint: string;
  /** Root CA cert PEM the sandbox must trust. */
  caCertPem: string;
  /** envName → opaque placeholder token (`ax-cred:<32-hex>`). */
  envMap: Record<string, string>;
  /**
   * Per-session proxy token (TASK-52; the proxy's caller-authentication
   * credential since TASK-158). Threaded onto `proxyConfig` so the sandbox
   * carries it as Proxy-Authorization; the proxy refuses a request without it.
   * Required (TASK-784): a missing or malformed token fails the turn at
   * session-open (`proxy-open-failed`) instead of spawning a runner that then
   * dies at boot. Stub proxies (test harness) mint a dummy 32-hex token.
   */
  proxyAuthToken: string;
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
    | 'request-body-too-large'
    | 'proxy-auth';
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

// The `connectors:proposed` notify @ax/connectors fires after a successful
// `connectors:install-authored` write of a PENDING draft (the agent authored a
// connector THIS turn via connector_propose). The orchestrator subscribes and
// fires the upfront approval card on the proposing turn's conversation — the
// same mid-turn live-card pattern @ax/skill-broker's request_capability uses —
// so the user sees the card without waiting for their next message (the bug
// this fixes: the card was previously fired only at the START of an
// agent:invoke, so a connector proposed mid-turn was uncarded until a turn the
// user might never send). Storage-agnostic ids; re-declared here per I2 (no
// @ax/connectors import); the shape mirrors @ax/connectors' ConnectorProposedEvent.
interface ConnectorProposedLike {
  ownerUserId: string;
  agentId: string;
  connectorId: string;
  status: 'pending' | 'active';
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
  /**
   * `agents.runner` — recorded onto the conversation so the row says whose
   * format the stored transcript is in. Optional on the wire: a caller that
   * does not know must leave the stored value alone rather than clear it.
   */
  runnerType?: string;
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

// system-prompt:augment — registered by @ax/memory (`augment.ts`), and
// potentially other plugins in the future (personalization, tenant policy).
// Returns markdown contributions that the orchestrator prepends to the
// system prompt envelope before fresh-spawning the sandbox.
//
// Single-provider service hook (one registration); the orchestrator dispatches
// only when `bus.hasService('system-prompt:augment')`. When absent, the
// orchestrator is a no-op — no augmentation, identical to today.
//
// Note: augmentation applies ONLY on the fresh-spawn path. The routed-into-
// existing-sandbox path reuses the originally-frozen `agentConfig.systemPromptAugment`
// that was baked into the runner's session at first spawn; the prompt is never
// shifted under a running runner. When a provider's content changes (a person
// edits Rules), it fires `system-prompt:augment-changed { agentId }` and the
// orchestrator retires that agent's live sessions at their NEXT turn boundary,
// so the fresh spawn re-augments (TASK-612).
// Provider reads from ctx (userId, agentId, sessionId, etc.) — payload is empty.
//
// TASK-524: a contribution may set `bootstrapSafe: true`. Bootstrap mode (the
// agent's first-run identity conversation, decided RUNNER-side by whether the
// workspace still holds the bootstrap script) admits ONLY those — see
// `agentConfig.systemPromptBootstrapAugment`. The flag is for content a PERSON
// authored and no agent can write (e.g. @ax/memory's Rules section); recalled
// or agent-derived content must leave it unset. Anything other than the
// boolean `true` counts as unset, so a sloppy provider fails closed.
type SystemPromptAugmentInput = Record<string, never>;
interface SystemPromptAugmentOutput {
  contributions: Array<{ source: string; body: string; bootstrapSafe?: boolean }>;
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
    /**
     * TASK-181 — host-derived session origin: `'routine'` for a scheduled
     * @ax/routines fire, `'user'`/absent for an interactive turn. Taken from
     * `ctx.source` (set host-side: routines `fire.ts` stamps `'routine'`; user
     * turns leave it unset). Forwarded into session:create so the IPC server
     * can stamp it onto the happy-path runner-completed chat:end ctx.
     * @ax/memory reads it there (and on a routine turn's tool calls): it still
     * stores a routine turn's rows, but with no conversation, so a scheduled
     * run never counts toward the skill-reflection recurrence gate (TASK-616).
     * SECURITY: never sourced from a runner-supplied frame — only from
     * ctx.source on the host.
     */
    source?: 'routine' | 'user';
  };
  /**
   * Per-session proxy blob from `proxy:open-session`. REQUIRED (TASK-838):
   * the sandbox backends' OpenSessionInputSchema refuses an input without
   * one, because the runner cannot boot without the proxy env. The
   * orchestrator never reaches sandbox:open-session without it — a preset
   * missing @ax/credential-proxy ends the turn earlier with
   * `proxy-not-loaded`.
   */
  proxyConfig: ProxyConfig;
  /**
   * Phase 1 (skill-install) — installed-skill SKILL.md files to materialize
   * inside the sandbox at $CLAUDE_CONFIG_DIR/skills/<id>/SKILL.md. The
   * sandbox plugin writes them BEFORE spawning the runner; the SDK's
   * 'user' source discovers them at boot. Empty/absent means no skills
   * to materialize (Phase 0's empty skills/ dir is left as-is).
   */
  installedSkills?: InstalledSkillForSandbox[];
  /**
   * TASK-153 — dev SERVICES folded from the agent's admin-approved connectors'
   * `capabilities.services` (a database, a cache, …). Each is the canonical
   * `ServiceDescriptorParsed` wire shape; both sandbox backends re-validate it at
   * the boundary (digest-pin, caps, no smuggled backend vocab) and render it
   * (k8s native sidecars / subprocess docker-compose). Omitted when no connector
   * declares one. Capped at 8 by the wire schema. Half-wired window stays OPEN
   * until the S7 end-to-end canary closes it.
   */
  services?: ServiceDescriptorParsed[];
}
interface OpenSessionHandle {
  kill(): Promise<void>;
  exited: Promise<RunnerExitInfo>;
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
// TASK-713 / TASK-783 — a session that could not open because a connector's
// sign-in is dead is not a generic failure: the person can fix it by
// reconnecting that connector, and the turn error says WHICH one.
//
// Two shapes count (see ./proxy-errors.ts for how they are read):
//   - the resolver threw an error NAMED `NeedsReconnectError` (the OAuth
//     refresh token was rejected, or there is none) — wherever it failed;
//   - the vault had no row (`credential-not-found`) for a ref the proxy says
//     belongs to a CONNECTOR. Since TASK-806 a connector whose row is absent is
//     skipped before the open (`partitionConnectorsBySignIn`), so this is the
//     race (the row went between the presence read and the open) or a presence
//     read that faulted and kept the connector.
//
// `credential-not-found` on any OTHER ref — the model-provider key — stays
// `proxy-open-failed`: telling that person to reconnect a connector would send
// them the wrong way. Before TASK-783 the proxy's error did not say which ref
// failed, so a bare `credential-not-found` could not be attributed and was
// left unmapped; the proxy now names the failing credential by OUR env key
// (`diagnosis.envName`), which the connector fold maps back to its connector.
// A vault blip or a decrypt failure keeps `proxy-open-failed`.
// ---------------------------------------------------------------------------

/** Turn-error reason: a connector's sign-in expired; reconnect it, then retry. */
const CONNECTOR_NEEDS_RECONNECT = 'connector-needs-reconnect';
/**
 * Turn-error reason (TASK-828): SEVERAL connectors' sign-ins are dead. Its own
 * code so the label can say "some … reconnect them" instead of "one … it".
 */
const CONNECTORS_NEED_RECONNECT = 'connectors-need-reconnect';

/**
 * Classify a failed `proxy:open-session`. `connectorFor(envName)` answers the
 * connector that owns a credential env key, or undefined for the agent's own
 * keys. `detail` is the turn error's untrusted detail line naming the
 * connectors (each label control-stripped and clamped by `connectorLabel`),
 * present only when the failure is attributed to at least one connector.
 *
 * TASK-828 — the proxy reports EVERY credential that failed, so each failure
 * is classified on its own and every connector with a dead sign-in is named
 * (deduped — one connector can own several slots), in the order the proxy
 * reported them. The turn is a reconnect if ANY failure is: that is the part
 * the person can fix now, and anything else left over surfaces on the retry.
 */
function classifyProxyOpenFailure(
  err: unknown,
  connectorFor: (envName: string) => { id: string; name?: unknown } | undefined,
): { reason: string; detail?: string } {
  let reconnect = false;
  const dead = new Map<string, { id: string; name?: unknown }>();
  for (const failure of credentialResolveFailures(err)) {
    const envName = failedCredentialEnvName(failure);
    const connector = envName !== undefined ? connectorFor(envName) : undefined;
    const isReconnect =
      isNeedsReconnect(failure) || (connector !== undefined && isCredentialNotFound(failure));
    if (!isReconnect) continue;
    reconnect = true;
    if (connector !== undefined && !dead.has(connector.id)) dead.set(connector.id, connector);
  }
  if (!reconnect) return { reason: 'proxy-open-failed' };
  const named = [...dead.values()];
  const detail = reconnectDetail(named);
  return {
    reason: named.length > 1 ? CONNECTORS_NEED_RECONNECT : CONNECTOR_NEEDS_RECONNECT,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/** Owner tag for the agent's own credential slots — the model-provider key. */
const AGENT_SLOT_OWNER = '<agent.requiredCredentials>';

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
export const DEFAULT_CHAT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * `agent:invoke` runs with NO HookBus timeout at all (TASK-498).
 *
 * WHAT WAS BROKEN. The hook was registered with no `timeoutMs`, so it used the
 * HookBus default of 120 s — while `chatTimeoutMs` allows a turn ten minutes.
 * `withTimeout` races the handler and does NOT cancel it, so every turn longer
 * than two minutes had its `bus.call('agent:invoke')` rejected WHILE THE TURN
 * WAS ALIVE AND STREAMING. channel-web only logged that rejection
 * (`chat_run_dispatch_failed`), so nobody noticed — and it is why that log line
 * could not be trusted as a failure signal, which is exactly what TASK-498
 * needed it to be.
 *
 * WHY NOT SIMPLY A BIGGER NUMBER, which is where this landed first. The first
 * fix was `chatTimeoutMs + 60 s`, on the reasoning that the bus must never fire
 * before the orchestrator's own bound. A reviewer showed that does not hold:
 * the `chatTimeoutMs` timer is armed only AFTER setup — `chat:start`
 * subscribers, `agents:resolve`, `proxy:open-session` and `sandbox:open-session`
 * (registered `timeoutMs: 300_000` by both providers) — while the bus clock
 * starts at handler entry. A three-minute cold pod spawn therefore still put
 * the bus deadline two minutes AHEAD of the orchestrator's, and now that
 * channel-web surfaces the rejection it would have killed a healthy streaming
 * turn's SSE and persisted a failure that never happened. Any finite slack has
 * that shape: setup is a chain of separately-bounded phases, and no single
 * number measured from handler entry dominates their sum.
 *
 * SO THE ORCHESTRATOR OWNS TURN DURATION, ALONE — which it is built to do, and
 * this is not a backstop being removed so much as a second, wrong clock. Every
 * phase it waits on is bounded by that phase's OWN hook timeout, and every
 * early return fires `chat:turn-error` on the way out (see the `fireTurnError`
 * call sites below); the streaming phase is bounded by `chatTimeoutMs`, which
 * fires `chat:turn-error(chat-run-timeout)`. A turn cannot now be reported dead
 * by a clock that was not watching the thing it timed.
 *
 * The one phase that used to have no bound of its own was `chat:start`:
 * `HookBus.fire` put no clock on subscribers, so a subscriber that hung
 * forever hung the turn with nothing to end it. TASK-514 closed that — see
 * `CHAT_START_SUBSCRIBER_TIMEOUT_MS`.
 *
 * WHAT THIS DOES COST, because "pre-existing" would otherwise read as "nothing
 * changed": the OPERATOR loses a signal. That 120 s rejection did run the
 * caller's `.catch` and wrote `chat_run_dispatch_failed`. With no timeout the
 * call never settles, so the `.catch` never runs — and `agent:invoke` also
 * opts out of TASK-505's stall watch (`stallWarnMs: Infinity`, on the same
 * argument: no threshold separates a healthy long turn from a hung one). So a
 * wedged `agent:invoke` now emits nothing of its own, ever. The diagnosis
 * lives one frame in and is deliberately better there: the subscribers and
 * service calls it awaits keep the default stall watch, so a hang names the
 * plugin responsible instead of reporting the outermost frame — which was
 * only ever the frame an operator already knew was stuck.
 */
export const AGENT_INVOKE_TIMEOUT_MS = Number.POSITIVE_INFINITY;

/**
 * The bound on EACH `chat:start` subscriber (TASK-514), passed to
 * `HookBus.fire` as `subscriberTimeoutMs`.
 *
 * WHY. `fire` puts no clock on subscribers by default, and `chat:start` runs
 * before the turn has any other clock armed — `chatTimeoutMs` starts only once
 * the runner is streaming, and `agent:invoke` itself has none (see above). So
 * one `chat:start` subscriber that never settled left the turn pending forever:
 * no throw, no settle, no timeout, and the person watching got "Thinking…"
 * with nothing ever coming to end it.
 *
 * WHAT HAPPENS AT THE BOUND: the turn PROCEEDS without that subscriber. The
 * bus logs `hook_subscriber_timed_out` (hook + plugin + bound), discards
 * whatever the subscriber eventually returns — including a late veto — and
 * runs the rest. We proceed rather than fail the turn because no `chat:start`
 * subscriber today is load-bearing for the turn's correctness: `@ax/agent-
 * activity` records a status line. (`@ax/memory-strata` used to seed the
 * agent's memory tree here, idempotently; it was deleted in TASK-608.) Losing
 * that for one turn is a degraded turn; failing it would turn a slow
 * observer into a user-facing error. A subscriber that NEEDS to stop a turn
 * vetoes, and a veto that arrives inside the bound still works.
 *
 * WHY 60 s. Four times the 15 s stall watch, so a slow subscriber has already
 * named itself (`hook_subscriber_stalled`) with 45 s of runway before it is
 * cut off. It is a hang backstop, not a latency budget — and it is not
 * measured against a real cold start. It was sized while memory-strata's k8s
 * bootstrap (deleted in TASK-608) was a subscriber — a `workspace:list`, N
 * `workspace:read`s and two `workspace:apply`s, each separately bounded at
 * 120 s with nothing bounding their sum, so a large or cold tier could be cut
 * off while HEALTHY, not hung. No current subscriber does that much. The
 * `hook_subscriber_timed_out` line makes a cut-off countable — if it shows up
 * on healthy first turns, raise this, do not remove it.
 *
 * WHAT IT DOES NOT DO: force the subscriber to stop. At the bound the bus
 * aborts that subscriber's `signal` (TASK-552), and a subscriber that checks
 * it stops; one that ignores it keeps running in the background — JavaScript
 * cannot cancel a promise — so a subscriber that hangs on every turn and
 * ignores its signal leaks one pending task per turn. Its SIDE EFFECTS are
 * therefore possible after the bound unless it honours the signal — only its
 * say over this turn is guaranteed gone.
 */
export const CHAT_START_SUBSCRIBER_TIMEOUT_MS = 60_000;

/**
 * The bound on EACH subscriber of the `chat:end`, `chat:turn-error` and
 * `chat:permission-request` fires this orchestrator makes (TASK-551), passed
 * to `HookBus.fire` as `subscriberTimeoutMs`. Same mechanism as
 * `CHAT_START_SUBSCRIBER_TIMEOUT_MS`: a subscriber past it is skipped and
 * logged `hook_subscriber_timed_out`, and the rest still run.
 *
 * WHO WAITS, AND WHAT A HANG COST before this bound:
 *
 *  - `chat:end` — every fire here is a SYNTHESIZED outcome (a veto, a failed
 *    resolve/spawn/queue, a sandbox that exited early, a wedged runner past
 *    `chatTimeoutMs`), and `agent:invoke` awaits it before it returns. That
 *    call has no deadline of its own (`AGENT_INVOKE_TIMEOUT_MS`), so one hung
 *    subscriber pinned the turn open forever — on the timeout path, AFTER the
 *    turn had already been given its full ten minutes.
 *  - `chat:turn-error` — awaited on the same abnormal-end paths, just before
 *    `chat:end`, so a hang there hung the turn the same way. It is also
 *    awaited inside this plugin's `session:terminate` and `chat:end`
 *    subscribers, where a hang stalled the fire that delivered them.
 *  - `chat:permission-request` — the up-front authored-connector card is
 *    awaited during turn setup (before `chatTimeoutMs` is armed), and the
 *    reactive egress-wall card is awaited inside this plugin's
 *    `event.http-egress` subscriber.
 *
 * Nothing that subscribes to them is load-bearing for the turn's outcome: the
 * subscribers write an SSE frame, persist a display event (@ax/conversations),
 * forget an activity line (@ax/agent-activity), or kick off DETACHED memory
 * extraction that returns to the bus immediately (@ax/memory). So we proceed past a hung one, as chat:start does, and
 * the turn ends with the outcome it already had. The cost of a skip is that
 * one subscriber's view of that event may be missing (e.g. no persisted error
 * row), which the timed-out line makes visible.
 *
 * WHY 30 s. Twice the 15 s stall watch, so a slow subscriber names itself
 * (`hook_subscriber_stalled`) with 15 s of runway. Each subscriber's healthy
 * work is one frame write or one row write, far inside it. Shorter than
 * chat:start's 60 s because nothing here does chat:start's cold-tier fan-out.
 *
 * NOT FIRED HERE: the HAPPY-PATH `chat:end` that @ax/ipc-core fires when the
 * runner POSTs `event.chat-end`. It is bounded there, at the same 30 s
 * (`RUNNER_CHAT_END_SUBSCRIBER_TIMEOUT_MS`, TASK-555), because a hung
 * subscriber registered AHEAD of ours kept our subscriber — the one that
 * resolves the turn's waiter — from ever running, so a turn the runner had
 * finished was reported as `chat-run-timeout` at `chatTimeoutMs`. That fire
 * RACES `agent:invoke` (our subscriber resolves the caller from inside it), so
 * under a bound a later-registered subscriber can run after `agent:invoke` has
 * returned; preset-k8s acceptance's chat:end-once witness now waits for the
 * turn to settle instead of reading on return (the TASK-514 trap).
 *
 * WHAT IS NOT BOUNDED, on purpose, because something else already bounds it:
 * @ax/skill-broker's request_capability card (inside a tool with a 30 s
 * service timeout) and @ax/channel-web's dispatch-failed turn-error
 * (fire-and-forget; nobody awaits it).
 *
 * Like chat:start's bound, it ends the subscriber's say over this fire and
 * aborts its `signal` (TASK-552); stopping its work is up to the subscriber.
 */
export const CHAT_EVENT_SUBSCRIBER_TIMEOUT_MS = 30_000;

/**
 * TASK-878 — bound on how long any caller here WAITS for
 * `proxy:close-session`. Today the proxy is in-process and the close is a few
 * Map deletes, so it settles in microseconds; the bound only matters if the
 * proxy ever goes remote or wedges. Without it the wait is bounded only by
 * the HookBus service timeout (120 s), and on the routing-retire path
 * (TASK-871) that is 120 s of a user's next message going nowhere.
 *
 * What the bound does NOT do: cancel the close. The call keeps running and
 * still revokes the session when it lands (a late failure is still logged).
 * `session:terminate` follows regardless, and the exit watcher's close on
 * `handle.exited` is a second attempt — close is idempotent.
 */
export const PROXY_CLOSE_TIMEOUT_MS = 10_000;

/**
 * Fail at boot, not on every turn: an invalid bound would make each bounded
 * fire reject (HookBus.fire validates it), so catch it here.
 */
function validSubscriberBound(name: string, value: number): number {
  if (value === Number.POSITIVE_INFINITY || (Number.isFinite(value) && value >= 0)) {
    return value;
  }
  throw new PluginError({
    code: 'invalid-payload',
    plugin: PLUGIN_NAME,
    message: `${name} must be a non-negative finite number or Infinity (got ${value})`,
  });
}

// ---------------------------------------------------------------------------
// PR 2 (provider-agnostic runner, design doc §1) — runner id → binary path.
//
// The agent row / AgentConfig / IPC wire all carry a runner **id**. The only
// place that id becomes a filesystem path is here, on the way into
// `sandbox:open-session`, which already carried an absolute path before this
// change. An unknown id is a hard error, NEVER a fallback to some default
// runner: a fallback would quietly run the agent on a runner the operator did
// not select, which is exactly what the id-based boundary exists to prevent.
// ---------------------------------------------------------------------------
function resolveRunnerBinary(
  runnerBinaries: Readonly<Record<string, string>>,
  runnerId: string,
): string {
  const binary = runnerBinaries[runnerId];
  if (binary === undefined) {
    const configured = Object.keys(runnerBinaries);
    throw new PluginError({
      code: 'unknown-runner',
      plugin: PLUGIN_NAME,
      message:
        `agent selects runner '${runnerId}', which has no configured binary; ` +
        `configured runners: ${configured.length > 0 ? configured.join(', ') : '(none)'}`,
    });
  }
  return binary;
}

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
//
// TASK-95: `connector_propose` joins for the SAME reason — a non-wildcard tenant
// agent must be able to author CONNECTORS (the access the connectors-first-class
// split lifts out of skills). The host `connectors:install-authored` hook
// (persists a PENDING draft, zero reach until the one approval card) is the real
// boundary; tool visibility isn't a grant. Mirror of the skill_propose addition.
const ALWAYS_ON_BROKER_TOOLS = [
  'search_catalog',
  'request_capability',
  'skill_propose',
  'connector_propose',
] as const;

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

/**
 * I10 — does this session need per-turn credential rotation?
 *
 * A session is armed for rotation iff ANY credential in its FINAL merged set
 * has a non-`api-key` kind (the kinds whose backing token expires — `oauth`,
 * `mcp-oauth`, …). `api-key` creds never refresh, so an all-`api-key` (or
 * empty) session stays put.
 *
 * IMPORTANT — this must run over the MERGED session credential set
 * (`unionedCreds` after `foldConnectorCaps`), NOT `agent.requiredCredentials`.
 * A connector-sourced `mcp-oauth` credential lands in the merged set via the
 * connector fold, never on the agent row — so gating on
 * `agent.requiredCredentials` would silently never arm rotation for a
 * connector-only OAuth session, and the proxy would substitute a stale access
 * token after ~1h (warm sessions persist under `keepAlive:true`). Connector
 * OAuth creds are refreshable too; the gate must consider the merged set.
 */
export function sessionNeedsCredentialRotation(
  creds: Record<string, { kind: string }>,
): boolean {
  return Object.values(creds).some((c) => c.kind !== 'api-key');
}

export function createOrchestrator(
  bus: HookBus,
  config: ChatOrchestratorConfig,
): {
  runAgentInvoke(ctx: AgentContext, input: AgentInvokeInput): Promise<AgentOutcome>;
  onChatEnd(ctx: AgentContext, payload: { outcome: AgentOutcome }): Promise<void>;
  onTurnEnd(ctx: AgentContext, payload?: { reqId?: string; foldedReqIds?: unknown }): void;
  onSessionTerminate(ctx: AgentContext, payload: { sessionId?: string }): Promise<void>;
  applyCapabilityGrant(
    ctx: AgentContext,
    input: ApplyCapabilityGrantInput,
  ): Promise<ApplyCapabilityGrantOutput>;
  interruptTurn(
    ctx: AgentContext,
    input: AgentInterruptInput,
  ): Promise<AgentInterruptOutput>;
  applyAuthoredCapabilityGrant(
    ctx: AgentContext,
    input: ApplyAuthoredCapabilityGrantInput,
  ): Promise<ApplyAuthoredCapabilityGrantOutput>;
  applyAuthoredConnectorGrant(
    ctx: AgentContext,
    input: ApplyAuthoredConnectorGrantInput,
  ): Promise<ApplyAuthoredConnectorGrantOutput>;
  onHttpEgress(ctx: AgentContext, payload: HttpEgressEventLike): Promise<void>;
  onSkillsProposed(ctx: AgentContext, event: SkillsProposedLike): Promise<void>;
  onConnectorProposed(ctx: AgentContext, event: ConnectorProposedLike): Promise<void>;
  onSystemPromptAugmentChanged(ctx: AgentContext, payload: unknown): void;
  onAgentDeleted(ctx: AgentContext, payload: unknown): Promise<void>;
  onConnectorDeleted(ctx: AgentContext, payload: unknown): void;
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
  // TASK-688 — Stop during a COLD SPAWN. `active_req_id` is bound at POST time,
  // so a Stop can arrive for a reqId whose user message is not in any inbox yet
  // (a fresh pod takes 10+ s to spawn; there is no session to interrupt).
  // Dropping that Stop would leave the turn running; queueing `interrupt`
  // straight into a warm inbox would put it AHEAD of the message it is meant to
  // stop, where an idle runner drops it. So `agent:interrupt` records the
  // request here and `runAgentInvoke` queues it BEHIND the message the moment
  // that lands.
  //   - pendingMessageReqIds: reqIds of an agent:invoke in flight whose user
  //     message has NOT yet been successfully queued with session:queue-work.
  //   - stopRequestedReqIds: those of them a Stop has been requested for.
  // Both are bounded by the runAgentInvoke wrapper's finally (a reqId never
  // outlives its invoke). In-memory + single-replica — same posture as
  // waitersByReqId above; a second host replica would not see a Stop handled by
  // another replica (the k8s chart refuses replicas > 1 for the same reason).
  const pendingMessageReqIds = new Set<string>();
  const stopRequestedReqIds = new Set<string>();
  // Reactive egress wall (TASK-37) — dedup raised host-grant cards per
  // (sessionId, host) so repeated 403s to the same blocked host don't spam the
  // stream with duplicate cards. Cleared per session in onSessionTerminate (the
  // session's egress is gone, so any future block under a reused id is new).
  const wallCardsByHost = new Map<string, Set<string>>(); // sessionId → hosts already carded
  // TASK-94 — upfront authored-CONNECTOR approval cards already fired, keyed by
  // conversationId → set of shown-surface dedup keys. Conversation-scoped so it
  // SURVIVES a re-spawn within the conversation; cleared by the connector grant
  // path on apply so a post-approve spawn re-evaluates. In-memory, single-replica
  // (same posture as wallCardsByHost / respawnSessions). TASK-100 — the
  // authored-SKILL upfront card was removed (a skill declares no caps), so there
  // is no longer a per-skill card-dedup map or a proposing-conversation map.
  const upfrontConnectorCardsByConv = new Map<string, Set<string>>();

  // TASK-94 / TASK-112 — fire ONE upfront approval card per PENDING authored
  // connector draft with a non-empty shown surface (hosts/slots/packages; mcp
  // deferred — the wall rejects kind:'mcp'), deduped per (conversation,
  // connectorId, shown-surface). Single source of truth shared by BOTH the
  // fresh-spawn path AND the warm/routed path (TASK-112 Bug 2: a draft proposed
  // mid-turn must be carded on the next warm turn — the routed branch returns
  // before the fresh-spawn block, so without this the warm turn surfaces a
  // reactive egress wall instead of the card). Best-effort + hasService-gated;
  // a resolve failure fires NO card (fewer cards, never a wrong one) and never
  // blocks the turn. conversationId is the SSE match key.
  async function fireUpfrontConnectorCards(
    ctx: AgentContext,
    agentId: string,
  ): Promise<void> {
    if (ctx.conversationId === undefined || ctx.conversationId.length === 0) return;
    if (!bus.hasService('connectors:list-authored')) return;

    let drafts: ConnectorsListAuthoredOutput['drafts'] = [];
    try {
      const r = await bus.call<
        { ownerUserId: string; agentId: string },
        ConnectorsListAuthoredOutput
      >('connectors:list-authored', ctx, { ownerUserId: ctx.userId, agentId });
      drafts = r.drafts;
    } catch (err) {
      ctx.logger.warn('resolve_authored_connectors_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const cardable = drafts.filter(
      (d) => d.status === 'pending' && hasConnectorShownSurface(d.proposal),
    );
    if (cardable.length === 0) return;

    // Vaulted refs → haveExisting on account-tagged slots (mirror the skill
    // card). Best-effort: a failed lookup just means the card prompts.
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

    const fired = upfrontConnectorCardsByConv.get(ctx.conversationId) ?? new Set<string>();
    for (const d of cardable) {
      const key = authoredConnectorCardDedupKey(d.connectorId, d.proposal);
      if (fired.has(key)) continue;
      const card = buildAuthoredConnectorCard(
        { connectorId: d.connectorId, name: d.name, proposal: d.proposal, keyMode: d.keyMode },
        vaultedRefs,
      );
      if (card === null) continue;
      fired.add(key);
      await fireChatEvent('chat:permission-request', ctx, card);
    }
    upfrontConnectorCardsByConv.set(ctx.conversationId, fired);
  }

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

  // TASK-785 — a message sent while a reply is still running can be FOLDED
  // into that running turn by the model's CLI: the turn answers both and ends
  // under the running message's reqId, so the folded message never gets a
  // turn-end of its own and its waiter would sit out the whole chat timeout
  // (then fire a chat-run-timeout turn-error at a reply that already arrived).
  // The runner lists folded reqIds on the turn-ends of the turn that answered
  // them; resolve those waiters too.
  //
  // Exact reqIds only, and only waiters registered to THIS session: the list is
  // runner-written and untrusted, and a runner must not be able to end another
  // session's turn by naming its reqId. No session-FIFO fallback either — an id
  // nobody waits on (already settled, or never ours) resolves nothing.
  function resolveFoldedWaiters(sessionId: string, foldedReqIds: unknown): void {
    if (!Array.isArray(foldedReqIds)) return;
    const ours = reqIdsBySession.get(sessionId);
    if (ours === undefined) return;
    for (const folded of foldedReqIds) {
      if (typeof folded !== 'string' || !ours.has(folded)) continue;
      const deferred = waitersByReqId.get(folded);
      if (deferred !== undefined && !deferred.settled) {
        deferred.resolve({ kind: 'complete', messages: [] });
      }
    }
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
    detail?: string,
  ): Promise<void> {
    // Log so operators can confirm the host detected the abnormal end and
    // signalled the client — the previously-silent path is what made Fault A
    // hard to diagnose. (The `reason` is orchestrator vocabulary, e.g.
    // `sandbox-terminated`; the matching `pod_exited`/`pod_killed` lines come
    // from the sandbox provider's own exit watcher.)
    //
    // TASK-160 — `detail` is an OPTIONAL author-facing free-text line that rides
    // alongside the stable `reason` code (the client maps the code to a label
    // and renders `detail` as untrusted text underneath). It carries the
    // self-diagnosis of a dev-service-sidecar startup failure ("service 'kafka'
    // couldn't write /opt/kafka …"). Already bounded + sanitized upstream
    // (formatServiceDiagnosis); we forward it verbatim and the renderer treats
    // it as untrusted text. Omitted for ordinary errors so the wire stays lean.
    ctx.logger.info('chat_turn_error', { reqId, reason, ...(detail !== undefined ? { detail } : {}) });
    await fireChatEvent('chat:turn-error', ctx, {
      reqId,
      reason,
      ...(detail !== undefined ? { detail } : {}),
    });
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
    augmentGenBySession.delete(sessionId);
    skippedConnectorRefsBySession.delete(sessionId);
    rotationFailedSessions.delete(sessionId);
    forgetSessionConnectors(sessionId);
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
      await fireChatEvent('chat:permission-request', ctx, {
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
    _event: SkillsProposedLike,
  ): Promise<void> {
    const sid = ctx.sessionId;
    // TASK-411: the third arm used to be `sid !== 'ipc-server'`. It never
    // matched anything — 'ipc-server' was one IPC listener's placeholder
    // AGENT id, never a sessionId (@ax/ipc-server's pre-auth ctx carries the
    // listener's real owning sessionId), and @ax/ipc-http's sibling literal
    // 'ipc-http' was not covered either way. Dropped rather than "fixed":
    // guarding a session id against an agent-id literal is the same
    // one-transport census that let the real pooling bug through. An
    // owner-less session is refused upstream, at the handlers that need an
    // owner; a harmless re-spawn mark is not one of them.
    if (sid !== undefined && sid.length > 0) {
      respawnSessions.add(sid);
    }
    // TASK-100 — a proposed skill no longer fires a per-skill capability card
    // (a skill declares no caps), so there is no proposing-conversation to
    // remember; the re-spawn mark above is the whole effect.
  }

  // connectors:proposed subscriber — surface the connector approval card AT
  // PROPOSAL TIME. The agent calls connector_propose mid-turn; @ax/connectors
  // persists the PENDING draft and fires this event on the SAME ctx (the IPC
  // server stamps the real conversationId onto the runner-driven tool ctx). We
  // reuse fireUpfrontConnectorCards — which resolves the agent's pending drafts,
  // builds the card, and dedups per (conversation, connectorId, shown-surface).
  // Because the proposing turn's SSE is still open and matched by conversationId
  // (sse.ts live permission-request subscriber), the card delivers LIVE on the
  // current turn. The per-conversation dedup means a later turn's
  // fireUpfrontConnectorCards won't double-fire it.
  //
  // Best-effort + non-blocking, exactly like the turn-start fire sites: a
  // resolve failure logs and fires no card (fewer cards, never a wrong one) and
  // never affects the proposing turn. firing this event needs no manifest
  // declaration (subscriber events are undeclared, like chat:turn-error).
  async function onConnectorProposed(
    ctx: AgentContext,
    _event: ConnectorProposedLike,
  ): Promise<void> {
    await fireUpfrontConnectorCards(ctx, ctx.agentId);
  }

  const chatTimeoutMs = config.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  const chatStartSubscriberTimeoutMs = validSubscriberBound(
    'chatStartSubscriberTimeoutMs',
    config.chatStartSubscriberTimeoutMs ?? CHAT_START_SUBSCRIBER_TIMEOUT_MS,
  );
  const chatEventSubscriberTimeoutMs = validSubscriberBound(
    'chatEventSubscriberTimeoutMs',
    config.chatEventSubscriberTimeoutMs ?? CHAT_EVENT_SUBSCRIBER_TIMEOUT_MS,
  );
  const proxyCloseTimeoutMs = validSubscriberBound(
    'proxyCloseTimeoutMs',
    config.proxyCloseTimeoutMs ?? PROXY_CLOSE_TIMEOUT_MS,
  );

  // TASK-551 — every `chat:end` / `chat:turn-error` / `chat:permission-request`
  // this plugin fires goes through here, so each subscriber is bounded by
  // `chatEventSubscriberTimeoutMs`. See CHAT_EVENT_SUBSCRIBER_TIMEOUT_MS for
  // who waits on these. The runner-reported `chat:end` is fired by
  // @ax/ipc-core, not here, and bounded there (TASK-555).
  function fireChatEvent<P>(
    hook: 'chat:end' | 'chat:turn-error' | 'chat:permission-request',
    ctx: AgentContext,
    payload: P,
  ): Promise<FireResult<P>> {
    return bus.fire(hook, ctx, payload, { subscriberTimeoutMs: chatEventSubscriberTimeoutMs });
  }
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
    // The agent this runner serves (`ctx.agentId` at spawn). `agents:deleted`
    // (TASK-718) finds a deleted agent's warm runners by it.
    agentId: string;
    // True when this runner has a credential-proxy session (closed on exit).
    // TASK-860 re-resolves its credentials before each routed turn.
    proxyOpened: boolean;
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

  function armReapTimer(ctx: AgentContext, delayMs: number = idleWindowMs): void {
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
      // its single chat:end (@ax/memory's extraction trigger). Dedup so
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
    }, delayMs);
    entry.idleTimer.unref?.();
  }

  // Phase 3 / I10 — sessions whose agent has at least one non-`api-key`
  // credential get `proxy:rotate-session` fired at turn END. api-key-only
  // sessions skip that one (their values never expire); every WARM session,
  // whatever its kinds, is also re-resolved when a message is routed into it
  // (TASK-860, `refreshWarmSessionCredentials`) so a replaced key is picked up.
  // Membership is added after a successful proxy:open-session and removed in
  // the runAgentInvoke finally that fires proxy:close-session.
  const sessionsNeedingRotation = new Set<string>();

  // TASK-783 — the fourth reason a warm session is retired at its next turn:
  // its between-turns `proxy:rotate-session` failed (see onTurnEnd). Same
  // lifetime + single-replica posture as `respawnSessions`. The rotate is
  // fire-and-forget at turn end, so a message sent before it settles still
  // routes to the old session; the one after that re-spawns.
  const rotationFailedSessions = new Set<string>();

  // Sessions that proposed a skill this turn must re-spawn next turn (the runner
  // reads skills only at spawn, "frozen at spawn", design §D6). Populated by the
  // skills:proposed subscriber (MARK-ONLY — see onSkillsProposed; TASK-74
  // replaced the old workspace:applied .ax/draft-skills trigger), consumed
  // (terminate + fresh spawn) at the next turn's routing decision. In-memory +
  // single-replica — same posture as the warm-session map.
  const respawnSessions = new Set<string>();

  // TASK-612 — the second reason a warm session is retired at its next turn:
  // its system prompt is older than the agent's augment. An augment provider
  // (today @ax/memory's Rules provider) fires
  // `system-prompt:augment-changed { agentId }` when a person edits something
  // the prompt carries; that bumps the agent's generation. Every fresh spawn
  // records the generation it was built at, snapshotted BEFORE the augment
  // call so a save that lands mid-build still counts as newer. A session this
  // process did not spawn has no record and counts as stale once the agent has
  // any change — conservative, worst case one extra re-spawn. Counters, not
  // timestamps, so there is no clock to skew. In-memory + single-replica, same
  // posture as `respawnSessions` and the warm-session map. A second host
  // replica would not see a save handled by another replica, which is one of
  // the reasons the k8s chart refuses to render replicas > 1
  // (`ax-next.validateHostReplicas`, TASK-617). Lifting that guard means
  // routing this event (and the warm-session map) across replicas first.
  // `augmentGenByAgent` is pruned only when the agent is deleted
  // (`onAgentDeleted`): one small entry per live agent that ever had a change,
  // bounded by the agent population.
  const augmentGenByAgent = new Map<string, number>();
  const augmentGenBySession = new Map<string, number>();

  // TASK-806 — the third reason a warm session is retired at its next turn: it
  // spawned with a connector SKIPPED because this caller had never signed in to
  // it, and they have signed in since. The skip is frozen at spawn (the runner
  // never reloads its MCP servers), so without this the person signs in, sends
  // the next message, and the agent still says the connector is off until the
  // warm session idles out. Holds the skipped connector refs per session; only
  // sessions that skipped something have an entry. Same lifetime + single-
  // replica posture as `augmentGenBySession`.
  const skippedConnectorRefsBySession = new Map<string, string[]>();

  /** True when a ref skipped at spawn now answers present. Any fault → false. */
  async function skippedConnectorSignedIn(ctx: AgentContext, sessionId: string): Promise<boolean> {
    const refs = skippedConnectorRefsBySession.get(sessionId);
    if (refs === undefined || refs.length === 0 || !bus.hasService('credentials:has')) return false;
    const answers = await Promise.all(
      refs.map(async (ref) => {
        try {
          const r = await bus.call<{ ref: string; userId: string }, { present?: unknown }>(
            'credentials:has',
            ctx,
            { ref, userId: ctx.userId },
          );
          return r?.present === true;
        } catch (err) {
          ctx.logger.warn('connector_sign_in_check_failed', {
            name: err instanceof Error ? err.name : 'unknown',
          });
          return false;
        }
      }),
    );
    return answers.some((present) => present);
  }

  /**
   * TASK-860 — re-resolve a warm session's credentials before a message is
   * routed into it. The credential proxy resolves every ref once at open, and
   * I10's turn-end rotation covers only refreshable kinds — so a NEW api-key
   * entered on an existing connector (same connector shape, same ref; nothing
   * TASK-833 can see) was never picked up, and the session went on injecting
   * the OLD key until it idled out. `proxy:rotate-session` re-reads every ref
   * from the vault in place (placeholders unchanged, I11), so the turn about
   * to run injects whatever is stored now.
   *
   * Returns false when the re-resolve FAILED: the caller retires the session
   * (fails toward re-spawning — a session whose credentials cannot be re-read
   * must not keep injecting the ones it already holds), and the fresh spawn's
   * own proxy:open-session reports a dead credential by name (TASK-783).
   * True when it succeeded or does not apply (no proxy session for this warm
   * runner, or no rotate hook loaded).
   */
  async function refreshWarmSessionCredentials(
    ctx: AgentContext,
    sessionId: string,
  ): Promise<boolean> {
    if (warmSessions.get(sessionId)?.proxyOpened !== true) return true;
    if (!bus.hasService('proxy:rotate-session')) return true;
    try {
      await bus.call<{ sessionId: string }, { envMap: Record<string, string> }>(
        'proxy:rotate-session',
        ctx,
        { sessionId },
      );
      return true;
    } catch (err) {
      // Name/code + our env key only — a refresh failure's message can carry
      // an OAuth server's own text (TASK-783).
      const envName = failedCredentialEnvName(err);
      ctx.logger.warn('proxy_rotate_session_failed', {
        sessionId,
        phase: 'routing',
        ...errorLogFields(err),
        ...(envName !== undefined ? { envName } : {}),
      });
      return false;
    }
  }

  // TASK-811 — the fifth reason a warm session is retired at its next turn: a
  // connector was attached to (or detached / excluded from) its agent since it
  // spawned. The runner loads its MCP servers once, at spawn, so without this a
  // connector attached mid-chat only shows up in a NEW conversation, and a
  // detached one stays callable in this one until the session idles out.
  // Compared against the agent row `agents:resolve` returns on EVERY invoke, so
  // every write to the row's attachments / exclusions is seen without a change
  // event, and nothing here depends on which replica took the write.
  //
  // TASK-833 — the row cannot see a connector DELETED, its capabilities EDITED,
  // or the owner's legacy-owned set changing. So the session also records a
  // fingerprint of the connectors it actually FOLDED at spawn, and a routed
  // turn re-resolves the same set (the row's attachments / exclusions plus the
  // skill-referenced ids it folded) and compares — one `connectors:list-
  // effective` read per warm turn, asked only when nothing cheaper already
  // retires the session. A resolve fault yields fewer connectors, so it reads
  // as "changed" and costs one extra re-spawn, never a stale connector.
  // Only sessions this process spawned have an entry; one it did not spawn is
  // already retired as `host-session-lost` in keepalive mode. Same lifetime as
  // `augmentGenBySession`.
  interface SessionConnectorState {
    /** TASK-811 — the agent row's connector selection at spawn. */
    selectionKey: string;
    /** TASK-833 — `connectorSetFingerprint` of every connector resolved at spawn. */
    fingerprint: string;
    /** Skill-referenced connector ids the spawn resolved (re-resolved per turn). */
    skillConnectorIds: string[];
    /** Connector id → its tool namespaces, for matching `connectors:deleted`. */
    connectors: Map<string, Set<string>>;
  }
  const connectorStateBySession = new Map<string, SessionConnectorState>();

  // TASK-833 — sessions that folded a connector which has since been DELETED
  // (`connectors:deleted`). The delete purged the connector's stored key, but a
  // live credential-proxy session keeps the value it resolved at open and goes
  // on substituting it until the session closes. So a marked session is reaped
  // the moment it is idle (now, or as soon as its in-flight turn ends) — its
  // proxy session is closed right then (TASK-877: directly, not only when the
  // runner exits) and the runner is cancelled / killed — and if a message
  // beats the reaper it is retired at routing instead. Same lifetime +
  // single-replica posture as `rotationFailedSessions`; the fingerprint compare
  // above is the replica-independent backstop.
  const connectorDeletedSessions = new Set<string>();

  /** Order-insensitive key for the agent row's connector selection. */
  function connectorSelectionKey(agent: AgentRecord): string {
    const norm = (ids: string[] | undefined): string[] => [...new Set(ids ?? [])].sort();
    return JSON.stringify([norm(agent.connectorAttachments), norm(agent.connectorExclusions)]);
  }

  function recordSessionConnectors(
    sessionId: string,
    agent: AgentRecord,
    connectors: readonly ResolvedConnectorForOrch[],
    skillConnectorIds: Iterable<string>,
  ): void {
    const byId = new Map<string, Set<string>>();
    for (const c of connectors) {
      const ns = byId.get(c.id) ?? new Set<string>();
      for (const e of c.toolNamespaces ?? []) {
        if (typeof e?.toolNamespace === 'string') ns.add(e.toolNamespace);
      }
      byId.set(c.id, ns);
    }
    connectorStateBySession.set(sessionId, {
      selectionKey: connectorSelectionKey(agent),
      fingerprint: connectorSetFingerprint(connectors),
      skillConnectorIds: [...new Set(skillConnectorIds)],
      connectors: byId,
    });
  }

  function forgetSessionConnectors(sessionId: string): void {
    connectorStateBySession.delete(sessionId);
    connectorDeletedSessions.delete(sessionId);
  }

  function connectorSelectionChanged(sessionId: string, agent: AgentRecord): boolean {
    const atSpawn = connectorStateBySession.get(sessionId);
    return atSpawn !== undefined && atSpawn.selectionKey !== connectorSelectionKey(agent);
  }

  /** TASK-833 — true when the agent's connectors no longer resolve to what this session folded. */
  async function foldedConnectorsChanged(
    ctx: AgentContext,
    sessionId: string,
    agent: AgentRecord,
  ): Promise<boolean> {
    const atSpawn = connectorStateBySession.get(sessionId);
    if (atSpawn === undefined) return false;
    const effective = await resolveEffectiveConnectors(
      bus,
      ctx,
      agent.connectorAttachments ?? [],
      agent.connectorExclusions ?? [],
    );
    const skillReferenced = await resolveSkillReferencedConnectors(
      bus,
      ctx,
      atSpawn.skillConnectorIds,
      new Set(effective.map((c) => c.id)),
    );
    return connectorSetFingerprint([...effective, ...skillReferenced]) !== atSpawn.fingerprint;
  }

  // TASK-877 — revoke a connector-deleted session's credentials the moment it
  // is reaped, not when its runner finally exits. The reap is a graceful cancel
  // and then a kill after `idleGraceMs`; the exit watcher's proxy close waits on
  // `handle.exited`, so the deleted connector's key stayed injectable for the
  // whole window — and indefinitely if the kill never landed. Called only for
  // an IDLE session (no turn in flight), so nothing it is doing needs the
  // proxy; a runner that wakes anyway reaches upstream without credentials.
  // Idempotent in credential-proxy, so the exit watcher's later close (and a
  // routing retire's) is a no-op. Fire-and-forget; never throws.
  function closeProxyForDeletedConnector(ctx: AgentContext, sessionId: string): void {
    if (!bus.hasService('proxy:close-session')) return;
    void closeProxySession({ ...ctx, sessionId }, sessionId, 'connector-deleted');
  }

  // TASK-878 — every `proxy:close-session` this plugin makes goes through
  // here. Waits at most `proxyCloseTimeoutMs`, then logs
  // `proxy_close_session_timeout` and resolves so the caller proceeds — the
  // close itself is NOT cancelled (see PROXY_CLOSE_TIMEOUT_MS). Never throws:
  // a failure (before or after the bound) is logged as
  // `proxy_close_session_failed`, name/code only (errorLogFields).
  async function closeProxySession(
    ctx: AgentContext,
    sessionId: string,
    phase: 'retire' | 'connector-deleted' | 'open-failed' | 'runner-exit' | 'invoke-end',
  ): Promise<void> {
    let timedOut = false;
    const close = bus
      .call<ProxyCloseSessionInput, Record<string, never>>(
        'proxy:close-session', ctx, { sessionId },
      )
      .then(
        () => undefined,
        (err: unknown) => {
          ctx.logger.warn('proxy_close_session_failed', {
            sessionId,
            phase,
            ...(timedOut ? { afterTimeout: true } : {}),
            ...errorLogFields(err),
          });
        },
      );
    if (proxyCloseTimeoutMs === Number.POSITIVE_INFINITY) {
      await close;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), proxyCloseTimeoutMs);
    });
    try {
      if ((await Promise.race([close, bound])) === 'timeout') {
        timedOut = true;
        ctx.logger.warn('proxy_close_session_timeout', {
          sessionId,
          phase,
          timeoutMs: proxyCloseTimeoutMs,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // TASK-833 — `connectors:deleted` (fired by @ax/connectors after the row is
  // gone and its stored key purged). Marks every session that folded that
  // connector, and reaps the idle ones now — closing their proxy sessions
  // first (TASK-877). A session mid-turn is not interrupted: `onTurnEnd` reaps
  // it (and closes its proxy session) as soon as the turn ends.
  //
  // Connector ids are not unique across owners, so the event's tool namespaces
  // (derived from the row OWNER) must match what the session was handed. A
  // connector with no MCP servers has no namespaces to compare, so the id
  // alone decides — at worst an idle session re-spawns once.
  //
  // Never throws: the delete has already committed.
  function onConnectorDeleted(ctx: AgentContext, payload: unknown): void {
    const p = payload as { connectorId?: unknown; toolNamespaces?: unknown } | null | undefined;
    const connectorId = p?.connectorId;
    if (typeof connectorId !== 'string' || connectorId.length === 0) return;
    const deletedNs = new Set<string>();
    if (Array.isArray(p?.toolNamespaces)) {
      for (const e of p.toolNamespaces as Array<{ toolNamespace?: unknown } | null>) {
        if (typeof e?.toolNamespace === 'string') deletedNs.add(e.toolNamespace);
      }
    }
    let marked = 0;
    let reaped = 0;
    for (const [sessionId, state] of connectorStateBySession) {
      const sessionNs = state.connectors.get(connectorId);
      if (sessionNs === undefined) continue;
      const sameConnector =
        deletedNs.size === 0 ||
        sessionNs.size === 0 ||
        [...deletedNs].some((ns) => sessionNs.has(ns));
      if (!sameConnector) continue;
      connectorDeletedSessions.add(sessionId);
      marked += 1;
      const entry = warmSessions.get(sessionId);
      // Idle = the reaper is armed (a turn ended and none has started). A grace
      // timer already running means a reap is under way — the session is idle
      // too, so its proxy session is closed either way (TASK-877).
      if (entry !== undefined && (entry.idleTimer !== null || entry.graceTimer !== null)) {
        closeProxyForDeletedConnector(ctx, sessionId);
      }
      if (entry !== undefined && entry.idleTimer !== null) {
        armReapTimer({ ...ctx, sessionId }, 0);
        reaped += 1;
      }
    }
    if (marked > 0) {
      ctx.logger.info('connector_deleted_sessions_retired', { connectorId, marked, reaped });
    }
  }

  function isAugmentStale(sessionId: string, agentId: string): boolean {
    const agentGen = augmentGenByAgent.get(agentId) ?? 0;
    if (agentGen === 0) return false;
    const sessionGen = augmentGenBySession.get(sessionId);
    return sessionGen === undefined || sessionGen < agentGen;
  }

  function onSystemPromptAugmentChanged(_ctx: AgentContext, payload: unknown): void {
    const agentId = (payload as { agentId?: unknown } | null | undefined)?.agentId;
    if (typeof agentId !== 'string' || agentId.length === 0) return;
    augmentGenByAgent.set(agentId, (augmentGenByAgent.get(agentId) ?? 0) + 1);
  }

  // TASK-718 — `agents:deleted`: take the deleted agent's WARM sandboxes down
  // now, instead of letting them idle out. In keepalive mode a runner outlives
  // its turn by the idle window (5 minutes by default), keeping the agent's
  // durable-files mount and its credential-proxy session; after a delete there
  // is nobody left to serve, and the durable-files reclaim wants the mount free.
  //
  // Kill only. Everything else follows from the `handle.exited` watcher armed
  // at spawn — it drops the registry entry, closes the proxy session and clears
  // the per-session bookkeeping — so this must not repeat any of it. Revoking
  // the runner's IPC token / session rows is the session store's own
  // `agents:deleted` subscriber; this one does not wait on it.
  //
  // Never throws: the delete has already committed, and a failure here must not
  // hide the remaining kills.
  async function onAgentDeleted(ctx: AgentContext, payload: unknown): Promise<void> {
    const agentId = (payload as { agentId?: unknown } | null | undefined)?.agentId;
    if (typeof agentId !== 'string' || agentId.length === 0) return;
    // A deleted agent's generation counter can never be read again.
    augmentGenByAgent.delete(agentId);

    // Snapshot first: an exit that lands during the awaits below mutates the map.
    const doomed: Array<[string, WarmEntry]> = [];
    for (const [sessionId, entry] of warmSessions) {
      if (entry.agentId === agentId) doomed.push([sessionId, entry]);
    }
    if (doomed.length === 0) return;

    let killed = 0;
    await Promise.all(
      doomed.map(async ([sessionId, entry]) => {
        // The idle reaper must not race the kill: its graceful cancel and forced
        // second kill would only add noise to a teardown already under way.
        clearReapTimers(sessionId);
        try {
          await entry.handle.kill();
          killed += 1;
        } catch (err) {
          ctx.logger.warn('agent_deleted_kill_failed', {
            agentId,
            sessionId,
            err: err instanceof Error ? err : new Error(String(err)),
          });
          // The kill did not take. With the timers cleared nothing else would
          // ever retire this runner short of the runner floor / pod ceiling, so
          // hand it back to the idle reaper as the retry.
          if (warmSessions.get(sessionId) === entry) {
            armReapTimer({ ...ctx, sessionId });
          }
        }
      }),
    );
    if (killed > 0) ctx.logger.info('agent_deleted_warm_sessions_killed', { agentId, count: killed });
  }

  // The agent:invoke entrypoint. Thin wrapper whose only job is the TASK-688
  // pending-message bookkeeping: the reqId is "pending" from the very first
  // instruction (before chat:start, before any await) until its user message is
  // queued (`afterUserMessageQueued`), and BOTH sets are cleared on every exit
  // — early return, throw, or a normal end — so they stay bounded.
  async function runAgentInvoke(
    ctx: AgentContext,
    input: AgentInvokeInput,
  ): Promise<AgentOutcome> {
    pendingMessageReqIds.add(ctx.reqId);
    try {
      return await runAgentInvokeTurn(ctx, input);
    } finally {
      pendingMessageReqIds.delete(ctx.reqId);
      stopRequestedReqIds.delete(ctx.reqId);
    }
  }

  // Called IMMEDIATELY after a successful `session:queue-work` of this turn's
  // user message (both the routed/warm and the fresh-spawn call sites). The
  // pending-delete and the stop-check are one synchronous step — that is what
  // makes the hook's check-and-add race-free (JS is single-threaded): a Stop
  // either landed before this line (deferred, queued here, behind the message)
  // or lands after it (the hook sees the message queued and queues directly).
  async function afterUserMessageQueued(
    ctx: AgentContext,
    sessionId: string,
  ): Promise<void> {
    pendingMessageReqIds.delete(ctx.reqId);
    if (!stopRequestedReqIds.delete(ctx.reqId)) return;
    // Best-effort: a failure to queue the stop must never fail the turn it was
    // meant to stop. The user can click Stop again (now on the plain path).
    try {
      await bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
        'session:queue-work',
        ctx,
        { sessionId, entry: { type: 'interrupt' } },
      );
    } catch (err) {
      ctx.logger.warn('deferred_interrupt_queue_failed', {
        sessionId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  async function runAgentInvokeTurn(
    ctx: AgentContext,
    input: AgentInvokeInput,
  ): Promise<AgentOutcome> {
    // 1. chat:start — subscribers can veto.
    //    Bounded (TASK-514): a subscriber past the bound is skipped and named,
    //    and the turn proceeds — see CHAT_START_SUBSCRIBER_TIMEOUT_MS.
    const startResult = await bus.fire(
      'chat:start',
      ctx,
      { message: input.message },
      { subscriberTimeoutMs: chatStartSubscriberTimeoutMs },
    );
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
      await fireChatEvent('chat:end', ctx, { outcome });
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
      await fireChatEvent('chat:end', ctx, { outcome });
      return outcome;
    }

    // 3. Build the agent config snapshot we'll freeze on the session.
    //    Per Invariant I10: this is captured ONCE at session creation;
    //    live edits to the agent row (via /admin/agents PATCH in Task 9)
    //    do not affect in-flight sessions.
    const agentConfig: AgentConfig = {
      // The runner's fallback identity (used when the agent has no
      // `.ax/IDENTITY.md`). TASK-142 dropped the `system_prompt` column —
      // identity lives in the agent's `.ax/` files now.
      displayName: agent.displayName,
      // Seeded empty; the `system-prompt:augment` step below sets it on the
      // fresh-spawn path (the runner prepends it on top in normal mode).
      systemPromptAugment: '',
      // TASK-524: the bootstrap-safe subset of the same augment, set below
      // alongside it. The runner prepends THIS (never the full augment) in
      // bootstrap mode.
      systemPromptBootstrapAugment: '',
      // TASK-51 (JIT §P4): lock the always-on broker tools into every
      // multi-tenant agent's effective allowedTools (default+locked). For a
      // wildcard agent (empty allowedTools+mcpConfigIds) this is a no-op — it
      // already sees the whole catalog. See withBrokerDefaults.
      allowedTools: withBrokerDefaults(agent.allowedTools, agent.mcpConfigIds),
      mcpConfigIds: agent.mcpConfigIds,
      model: agent.model,
      // PR 2 — the runner ID rides the wire (the runner-visible contract stays
      // the id, never the host's binary path; see resolveRunnerBinary above).
      //
      // NOTE this copy is NOT what selects the binary — that lookup below uses
      // `agent.runner` off the freshly-resolved AgentRecord. This is the frozen
      // SNAPSHOT (Invariant I10: config captured once at session creation).
      //
      // PR 3 gave it a reader, but NOT the one predicted here. The prediction
      // was that it would drive the cross-runner resume demotion. It can't:
      // this is a snapshot of the agent's runner, not of whatever wrote the
      // stored transcript, and the two diverge exactly in the case the
      // demotion exists for — someone switching an agent's runner
      // mid-conversation. So the demotion reads the TRANSCRIPT's own header
      // line instead (`packages/agent-aisdk-runner/src/transcript-codec.ts`:
      // a foreign/absent header decodes to `ok:false`, the source answers
      // `'unusable'`, and runRunner takes its existing demote-to-fresh branch).
      //
      // What this field is actually read for is a boot self-check in the
      // runner (`packages/agent-aisdk-runner/src/main.ts`, search RUNNER_ID):
      // the runner asserts the session it was handed was configured for the
      // runner id it implements, so a mis-keyed `runnerBinaries` map fails
      // loudly at spawn instead of silently running the wrong harness under
      // the operator's chosen runner id.
      runner: agent.runner,
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
            const skillsDirty = respawnSessions.has(candidate);
            const augmentStale = isAugmentStale(candidate, ctx.agentId);
            // A database row can outlive the host's runner handle and proxy
            // registration. Reopen the durable conversation after restart;
            // never send a turn through an unowned credential-proxy session.
            const hostSessionMissing = keepAlive && !warmSessions.has(candidate);
            // TASK-806 — asked only when nothing else already retires it, and
            // only for a session that skipped a connector at spawn.
            let rotationFailed = rotationFailedSessions.has(candidate);
            // TASK-811 — a connector attached / detached since this session
            // spawned. TASK-833 — or one it folded was deleted (marked by
            // `connectors:deleted`), or no longer resolves to what it folded
            // (edited, deleted unheard, legacy set changed): that last check
            // reads the connector store, so it is asked only when nothing
            // cheaper already retires the session.
            const connectorsChanged =
              connectorDeletedSessions.has(candidate) ||
              connectorSelectionChanged(candidate, agent) ||
              (!(skillsDirty || augmentStale || hostSessionMissing || rotationFailed) &&
                (await foldedConnectorsChanged(ctx, candidate, agent)));
            const connectorSignedIn =
              !(
                skillsDirty ||
                augmentStale ||
                hostSessionMissing ||
                rotationFailed ||
                connectorsChanged
              ) && (await skippedConnectorSignedIn(ctx, candidate));
            // TASK-860 — the session is staying: re-resolve its credentials so
            // a key replaced since the last turn is the one this turn injects.
            // Last, because a session retired for any reason above closes its
            // proxy session anyway. A failure retires it (secure direction).
            if (
              !(
                skillsDirty ||
                augmentStale ||
                hostSessionMissing ||
                rotationFailed ||
                connectorsChanged ||
                connectorSignedIn
              ) &&
              !(await refreshWarmSessionCredentials(ctx, candidate))
            ) {
              rotationFailed = true;
            }
            if (
              skillsDirty ||
              augmentStale ||
              hostSessionMissing ||
              rotationFailed ||
              connectorsChanged ||
              connectorSignedIn
            ) {
              // B3: this session's agent's draft-skills changed since it
              // spawned (the runner freezes the projection at spawn). Retire it
              // and fall through to a fresh spawn that re-derives the
              // projection. Safe HERE (between turns), unlike a mid-commit
              // terminate in the workspace:applied subscriber.
              //
              // TASK-612: same treatment when the session's system prompt
              // predates a change to the agent's augment (a person edited
              // Rules). The fresh spawn re-runs `system-prompt:augment`.
              //
              // TASK-806: and when a connector skipped at spawn (never signed
              // in) has been signed in since. The fresh spawn folds it.
              //
              // TASK-783: and when its credential rotation failed. The fresh
              // open re-resolves every ref and names a dead connector.
              // TASK-860: likewise when the routing-time re-resolve failed.
              //
              // TASK-811: and when a connector was attached to or detached from
              // the agent mid-chat. The fresh spawn folds the new set.
              //
              // TASK-833: and when a connector it folded was deleted or edited.
              // Its proxy session is closed below (TASK-871: directly, not only
              // via terminate), so a deleted connector's key stops being
              // substituted no later than this turn.
              ctx.logger.info('stale_session_respawn', {
                sessionId: candidate,
                reason: hostSessionMissing
                  ? 'host-session-lost'
                  : skillsDirty
                    ? 'skills-proposed'
                    : augmentStale
                      ? 'system-prompt-augment-changed'
                      : rotationFailed
                        ? 'credential-rotation-failed'
                        : connectorsChanged
                          ? 'connectors-changed'
                          : 'connector-signed-in',
              });
              // The channel has already bound this request to the conversation.
              // Move that binding before terminating the old session: its
              // subscriber clears rows still bound to that session, which
              // would otherwise make the new SSE request 404 during startup.
              await bus.call<ConversationsBindSessionInput, ConversationsBindSessionOutput>(
                'conversations:bind-session', ctx, {
                  conversationId: ctx.conversationId,
                  sessionId: ctx.sessionId,
                  reqId: ctx.reqId,
                  runnerType: agent.runner,
                },
              );
              respawnSessions.delete(candidate);
              augmentGenBySession.delete(candidate);
              skippedConnectorRefsBySession.delete(candidate);
              rotationFailedSessions.delete(candidate);
              forgetSessionConnectors(candidate);
              // TASK-871 — revoke the retired session's credentials HERE, not
              // via terminate. A warm session's proxy close is otherwise
              // deferred to `handle.exited`; if session:terminate throws (or
              // hangs) and the runner survives, that never fires and the proxy
              // keeps substituting the OLD key until the idle reaper. Closing
              // first means a hung terminate cannot delay it either. The close
              // is idempotent, so the later `handle.exited` close is a no-op.
              // Nothing of the old session is in flight: we are between turns.
              // TASK-878 — the wait is bounded: a close that hangs is logged
              // and we terminate + respawn anyway (the close keeps running).
              if (bus.hasService('proxy:close-session')) {
                await closeProxySession(ctx, candidate, 'retire');
              }
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
          // Record WHICH runner is about to serve this turn. The row's
          // `runner_type` is refreshed on every bind rather than frozen at
          // create, because an agent's runner can be switched at any time and
          // that switch demotes the next turn to a fresh session, REPLACING
          // the stored transcript with the new runner's format. A frozen
          // value would be wrong exactly when someone looked at it.
          runnerType: agent.runner,
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

      // (TASK-112 Bug 2) Fire the upfront connector approval card on the WARM
      //     path too. A draft proposed mid-turn (the previous turn's
      //     connector_propose) wouldn't otherwise be carded until a re-spawn —
      //     it would surface a reactive egress wall instead. Best-effort, after
      //     the bind so the SSE handler can locate the row; never blocks the turn.
      await fireUpfrontConnectorCards(ctx, agent.id);

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
        await fireChatEvent('chat:end', ctx, { outcome });
        return outcome;
      }
      // TASK-688 — the message is in the inbox; a Stop that arrived while it
      // was being queued goes in right behind it.
      await afterUserMessageQueued(ctx, sessionId);

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
        await fireChatEvent('chat:end', ctx, { outcome });
      }
      // No handle.kill() — we did not open this sandbox.
      return outcome;
    }

    // Phase 2B — system-prompt:augment. Fresh-spawn path only: a routed
    // agent:invoke reuses an existing live sandbox whose systemPromptAugment was
    // baked into the runner at first spawn, and the runner never reloads it.
    // The prompt is never changed under a running runner. When the augment
    // itself changes (a person edited Rules — `system-prompt:augment-changed`,
    // TASK-612), the routing above retires the session at its next turn and
    // this path runs again, which is how "reads them before every run" on the
    // Memory tab stays true.
    //
    // Snapshot the agent's augment generation BEFORE the call: a change that
    // lands while the augment is being built is then newer than this spawn,
    // and the next turn re-spawns instead of keeping a prompt that missed it.
    // Recorded into `augmentGenBySession` only once the sandbox has opened,
    // so a spawn that fails early leaves no entry behind.
    const augmentGenAtSpawn = augmentGenByAgent.get(ctx.agentId) ?? 0;
    //
    // Single-provider service hook (one registration at MVP; promoted to
    // a subscriber chain in Phase 5+ if a second provider lands). When
    // unregistered: no-op — identical to pre-Phase-2B behavior.
    //
    // The contribution lands on `agentConfig.systemPromptAugment` (its own
    // field since TASK-142); the runner prepends it on top of the composed
    // `.ax/` identity prompt in normal mode. The `bootstrapSafe` subset also
    // lands on `agentConfig.systemPromptBootstrapAugment` (TASK-524), which is
    // all the runner prepends in bootstrap mode.
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
        const join = (cs: SystemPromptAugmentOutput['contributions']): string =>
          cs
            .map((c) => c.body)
            .filter((b) => b.length > 0)
            .join('\n\n');
        const extra = join(out.contributions);
        // Strict `=== true`: a truthy non-boolean is NOT an opt-in (TASK-524).
        const bootstrapExtra = join(out.contributions.filter((c) => c.bootstrapSafe === true));
        if (extra.length > 0) {
          // Mutate the struct's field, not the binding. agentConfig is still
          // a const reference to the same object; only the systemPromptAugment
          // property changes before it gets frozen on the new session.
          agentConfig.systemPromptAugment = extra;
        }
        if (bootstrapExtra.length > 0) {
          agentConfig.systemPromptBootstrapAugment = bootstrapExtra;
        }
      } catch (err) {
        ctx.logger.warn('system_prompt_augment_failed', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    // Per-tool DENY verdicts → `agentConfig.disallowedTools`. CATALOG HYGIENE
    // only: the runner hides these so the model isn't offered tools it will
    // be refused. Enforcement stays host-side on `tool:pre-call`, so every
    // failure here DEGRADES (log + no extra denies) — it must never abort the
    // session open. Same optional-peer posture as `system-prompt:augment`
    // above: hasService-gated, declared in the manifest's `optionalCalls`.
    // Only set when non-empty so the frozen snapshot of an agent with no
    // denies is byte-identical to before.
    if (bus.hasService('tool-policy:list-agent-overrides')) {
      try {
        const out = await bus.call<
          ToolPolicyListAgentOverridesInput,
          unknown
        >('tool-policy:list-agent-overrides', ctx, { agentId: ctx.agentId });
        const denied = deniedToolKeys(out);
        if (denied.length > 0) {
          agentConfig.disallowedTools = denied;
        }
      } catch (err) {
        ctx.logger.warn('tool_policy_overrides_read_failed', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    // 4.5 — proxy:open-session. Fresh-spawn path only: a routed
    //       agent:invoke reuses an existing live sandbox whose proxy
    //       session was opened by the orchestrator that originally
    //       spawned it.
    //
    //       Phase 6 made @ax/credential-proxy mandatory. Without it there
    //       is no proxyConfig, and sandbox:open-session refuses the input
    //       (OpenSessionInputSchema requires it since TASK-838) — a generic
    //       sandbox failure is a worse error path than a structured outcome
    //       at agent:invoke time. Fail loud here.
    //
    //       I7 — `proxy:close-session` always fires once per `proxy:open-
    //       session`. We track that with `proxyOpened`; the finally below
    //       fires close exactly once when the flag is set, regardless of
    //       which exit path won. The `proxy-not-loaded` exit below runs
    //       BEFORE proxyOpened can be set — nothing to close. (Revocation
    //       paths may close a warm session's proxy session EARLY — a routing
    //       retire, TASK-871; a connector-deleted reap, TASK-877 — so the
    //       close can fire more than once; it is idempotent.)
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
      await fireChatEvent('chat:end', ctx, { outcome });
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
      await fireChatEvent('chat:end', ctx, { outcome });
      return outcome;
    }
    let proxyConfig: ProxyConfig;
    let proxyOpened = false;
    let proxyCloseDeferredToHandle = false;
    // Default the egress allowlist + credential slot from the agent's OWN
    // model ref when the agent record carries no explicit per-row entries.
    // The production agents plugin (`@ax/agents`) doesn't yet persist these
    // fields, so this branch is the live path for every real turn; without a
    // default the runner boots without an API key and crashes at
    // proxy-startup with `missing <PROVIDER>_API_KEY`.
    //
    // PR 4 changed only the CONTENT of that default — it used to be hardcoded
    // to the Anthropic pair, and is now derived from `PROVIDER_ENDPOINTS` via
    // `parseModelRef(agent.model).provider`. See the lookup a few lines below.
    //
    // Coupled defaults (all-or-nothing) — UNCHANGED by PR 4: a partially-
    // populated agent record (e.g. allowedHosts:['api.openai.com'] but no
    // requiredCredentials) used to mix and match — the OpenAI allowlist
    // would land alongside the Anthropic credential ref, either
    // over-permitting egress or breaking the agent's real provider.
    // We fall back to the derived pair only when BOTH fields are
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
      await fireChatEvent('chat:end', ctx, { outcome });
      return outcome;
    }
    const useProviderDefaults = allowedHostsMissing; // and therefore both

    // PR 4 — the model-derived default pair. `agent.model` is a
    // `provider/model-id` ref (@ax/agents validates the shape at write time);
    // its provider segment picks the row in @ax/core's PROVIDER_ENDPOINTS,
    // which is the SAME table the in-sandbox runner reads to choose a base
    // URL. Host and runner therefore can't drift about which host this turn
    // needs to reach.
    //
    // A miss — unregistered provider, or a `model` that predates the
    // `provider/` convention and won't parse — TERMINATES the turn. It must
    // never fall back to Anthropic: that would silently run the agent against
    // a provider the operator did not select AND hand the sandbox an
    // `api.anthropic.com` egress grant plus a real Anthropic key it was never
    // configured for. Fail loud, at the same point in the sequence as the
    // agent-proxy-config-incomplete return above — before any proxy or sandbox
    // session exists, so there is nothing to close.
    let providerDefaults:
      | {
          allowlist: string[];
          credentials: Record<string, ProxyCredentialEntry>;
        }
      | undefined;
    if (useProviderDefaults) {
      let endpoint;
      try {
        endpoint = providerEndpointFor(parseModelRef(agent.model).provider);
      } catch {
        // parseModelRef rejects empty / whitespace-bearing / slash-less refs.
        // Same outcome as an unknown provider — we have no endpoint either way.
        endpoint = undefined;
      }
      if (endpoint === undefined) {
        const outcome: AgentOutcome = {
          kind: 'terminated',
          reason: 'agent-model-provider-unknown',
        };
        // TASK-22 — pre-waiter early-return: surface on the SSE so the client
        // doesn't hang (see the proxy-hooks-misconfigured note above). Coarse
        // reason only; the offending model ref stays in host logs.
        ctx.logger.warn('agent_model_provider_unknown', { model: agent.model });
        await fireTurnError(ctx, ctx.reqId, outcome.reason);
        await fireChatEvent('chat:end', ctx, { outcome });
        return outcome;
      }
      providerDefaults = {
        allowlist: [endpoint.egressHost],
        credentials: {
          // TASK-687 — the provider key is bound to its provider's egress host
          // and nothing else. `endpoint` comes from the trusted PROVIDER_ENDPOINTS
          // table in @ax/core (code, not a store row), so this binding can't be
          // widened by a host grant / proxy:add-host / model output.
          [endpoint.credentialEnvVar]: {
            ref: endpoint.credentialRef,
            kind: 'api-key',
            allowedHosts: [endpoint.egressHost],
            // TASK-715 — and metered: this is the operator's model key, which
            // sandbox code can drive as freely as the runner can. The proxy
            // splices it only into these requests and counts what they use.
            metered: { requests: [...endpoint.inferenceRequests] },
          },
        },
      };
    }

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
        await fireChatEvent('chat:end', ctx, { outcome });
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
        await fireChatEvent('chat:end', ctx, { outcome });
        return outcome;
      }
    }

    // Build the union allowlist + credentials, starting from agent defaults.
    // PR 4 — `providerDefaults` is set iff `useProviderDefaults` (both agent-row
    // fields absent); the unknown-provider return above guarantees it is
    // populated by the time we get here.
    const baseAllowSet = providerDefaults
      ? new Set<string>(providerDefaults.allowlist)
      : new Set<string>(agent.allowedHosts ?? []);
    //
    // TASK-687 — every entry carries its credential BINDING (`allowedHosts`).
    // Provider-default path: the provider's own egress host (set above from the
    // PROVIDER_ENDPOINTS table). Explicit agent-row path: the agent row's
    // `allowedHosts`, stamped here by the orchestrator (placed AFTER the entry
    // spread, so a stray `allowedHosts` on an `agent.requiredCredentials` entry
    // can never override it). Only the CLI dev-agents-stub produces this
    // explicit shape; production @ax/agents returns neither field, so it always
    // takes the provider-default path.
    const baseCreds: Record<string, ProxyCredentialEntry> =
      providerDefaults
        ? { ...providerDefaults.credentials }
        : Object.fromEntries(
            Object.entries(agent.requiredCredentials ?? {}).map(([envName, cred]) => [
              envName,
              { ...cred, allowedHosts: [...(agent.allowedHosts ?? [])] },
            ]),
          );

    // TASK-86 — the bare env-var names a TRUSTED source owns (agent defaults).
    // These ALWAYS win the sandbox flat-env stamp; a skill can never overwrite
    // them. Skill slots are namespaced (`skill:<id>:<slot>`) so they coexist in
    // the host-side credential map instead of fatally colliding.
    const trustedBareNames = new Set<string>(Object.keys(baseCreds));

    // Track slot ownership (now keyed by the NAMESPACED env name for skill slots,
    // the bare name for trusted base creds) — diagnostic / idempotence, and
    // (TASK-783) how a failed proxy:open-session is attributed to the
    // connector that owns the credential it failed on.
    const slotOwners = new Map<string, string>(
      [...trustedBareNames].map((slot) => [slot, AGENT_SLOT_OWNER]),
    );

    // TASK-86 — ordered (highest precedence first) skill-slot descriptors driving
    // the namespaced→bare env projection. Connector slots (folded below) append
    // after the agent defaults, so the FIRST writer of a shared bare name wins
    // the flat-env stamp.
    //
    // TASK-100 — a skill manifest declares NO capabilities (hosts / credentials /
    // mcp / packages), so an attachment no longer folds any reach here: a skill's
    // reach is the connectors it references, folded through foldConnectorCaps
    // below (the skill→connector bridge). The attachment still records WHICH skill
    // is materialized (the union below); it carries no credential bindings.
    const skillSlotEnvNames: Array<{ envName: string; bareSlot: string }> = [];

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
    // name/description in context. Only `active` skills materialize. A projection
    // that predates the `status` field (back-compat) defaults to active.
    //
    // TASK-100 — a skill declares no capabilities, so there is no per-skill cap
    // fold or per-skill slot append here: an authored skill's reach is the
    // connectors it references, folded through the SINGLE foldConnectorCaps path
    // below (the skill→connector bridge) like every other skill's connectors.
    const activeAuthoredDraftSkills = authoredDraftSkills.filter(
      (s) => (s.status ?? 'active') === 'active',
    );

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

    // TASK-97/107/739 — CONNECTOR union. Resolve the agent's effective connector
    // set via connectors:list-effective (the agent's per-agent ATTACHMENTS ∪
    // the owner's legacy connectors, minus the agent's EXCLUSIONS) and fold each
    // connector's Capabilities through the SAME materialization path skills use: hosts → baseAllowSet, credential slots →
    // baseCreds (namespaced `connector:<id>:<slot>`), packages → the registry
    // auto-allow below, mcpServers → installed-skill entries (synthetic SKILL.md +
    // per-dir `.mcp.json`). Deduped against skill caps: hosts via the shared Set,
    // slots via the per-subject namespace. NON-FATAL throughout — a connector
    // resolve failure yields fewer connectors, never terminates (connectors are
    // additive reach). TASK-107 — the per-agent attachment ids (the agent row's
    // `connector_attachments` store, replacing TASK-98's `mcpConfigIds` stopgap)
    // and exclusions are forwarded; an agent row predating a column reads [].
    const effectiveConnectors = await resolveEffectiveConnectors(
      bus,
      ctx,
      agent.connectorAttachments ?? [],
      agent.connectorExclusions ?? [],
    );

    // TASK-111 — the skill→connector cap-resolution bridge. A skill declares the
    // connectors it uses via its top-level `connectors[]` reference list (TASK-92);
    // until now that list was parsed + stored but never resolved into reach
    // ("dead-on-arrival"). Collect every materialized skill's references (the FULL
    // spawn union: attachments + defaults + builtins + ACTIVE authored drafts —
    // every skill the model can see), resolve the ones the agent effective set
    // didn't already fold, and append them so the SINGLE foldConnectorCaps call
    // below folds skill-referenced connectors through the EXACT SAME path. No
    // second materialization path (invariant #4). Deduped by id against the
    // effective set. NON-FATAL (a resolve failure skips that connector).
    //
    // The skill's OWN `capabilities` block stays authoritative + materializes in
    // parallel during the half-wired window (TASK-100 closes it) — both paths
    // work this card (invariant #3 — no half-wired).
    const skillConnectorIds = new Set<string>();
    for (const skill of unionedSkills) {
      for (const cid of skill.connectors ?? []) skillConnectorIds.add(cid);
    }
    const alreadyResolvedConnectorIds = new Set(effectiveConnectors.map((c) => c.id));
    const skillReferencedConnectors = await resolveSkillReferencedConnectors(
      bus,
      ctx,
      skillConnectorIds,
      alreadyResolvedConnectorIds,
    );
    const allConnectors = [...effectiveConnectors, ...skillReferencedConnectors];

    // TASK-754 — a connector that reached this agent without an attach (a
    // skill-referenced connector or a legacy-owned row) copies its per-tool
    // defaults now, on first sight; attached ones were copied at attach and
    // are a cached no-op here.
    // NON-FATAL (see the helper). Runs over EVERY connector, skipped ones
    // included: the copy is about the agent getting the connector, not about
    // this caller's sign-in.
    await copyConnectorDefaultsForSession(bus, ctx, allConnectors);

    // TASK-806 (owner decision A) — a connector this caller has never signed
    // in to / added a key for is SKIPPED for this session instead of failing
    // the whole turn at proxy:open-session. Skipped connectors never reach the
    // fold below, so they add no hosts, credential slots or MCP servers. Only
    // an explicit "no row" skips; a presence-read fault keeps the connector
    // (see partitionConnectorsBySignIn). A rejected refresh still has a row,
    // so it is kept and surfaces as connector-needs-reconnect below.
    const connectorSignIn = await partitionConnectorsBySignIn(bus, ctx, allConnectors);
    if (connectorSignIn.skipped.length > 0) {
      ctx.logger.info('connectors_skipped_not_signed_in', {
        connectorIds: connectorSignIn.skipped.map((s) => s.connector.id),
      });
      // Tell the agent, so it can say "sign in to Gmail first" instead of
      // acting as if the tool never existed. Normal mode only: the bootstrap
      // augment admits person-authored content alone (TASK-524), and this line
      // carries connector names, which are not.
      const line = skippedConnectorsPromptLine(connectorSignIn.skipped);
      agentConfig.systemPromptAugment =
        agentConfig.systemPromptAugment.length > 0
          ? `${agentConfig.systemPromptAugment}\n\n${line}`
          : line;
    }

    // TASK-153 — fold the connectors' Capabilities, including their dev SERVICES.
    // The fold THROWS `ConnectorServiceCollisionError` if two connectors declare
    // the same service name (a misconfiguration, refused loudly). We then run the
    // canonical `services:validate` (TASK-150) over the folded list when the
    // validator is loaded (hasService-gated — a stripped CLI preset without
    // @ax/validator-service folds unvalidated; the sandbox backends re-validate
    // at the wire regardless, defense-in-depth). Either failure maps to a clean
    // `terminated` outcome (NOT an uncaught throw — runAgentInvoke must always
    // return an AgentOutcome; an uncaught throw here would hang the SSE, the same
    // failure mode TASK-22 fixed for proxy-open). I8 — only ADMIN-APPROVED
    // connectors reach `allConnectors`: `connectors:resolve` reads only the LIVE
    // owner-scoped table, so a pending/unapproved connector resolves to nothing
    // and contributes zero services.
    let connectorFold: FoldConnectorResult;
    let foldedServices: ServiceDescriptorParsed[];
    try {
      connectorFold = foldConnectorCaps(connectorSignIn.kept, baseAllowSet, baseCreds, slotOwners);
      // TASK-734 — a server the fold refused to key (no/invalid/duplicate tool
      // namespace) is absent from the sandbox; say so instead of silently losing it.
      // This log is for operators; the PERSON sees it on the agent's connectors
      // rail as "Couldn't load it" (TASK-745, health `not-loaded`).
      for (const d of connectorFold.droppedMcpServers) {
        ctx.logger.warn('connector_mcp_server_unnamespaced', { connectorId: d.connectorId, server: d.server });
      }
      foldedServices = connectorFold.services;
      if (foldedServices.length > 0 && bus.hasService('services:validate')) {
        const verdict = await bus.call<
          { services: unknown[] },
          { verdict: 'clean' } | { verdict: 'invalid'; reason: string }
        >('services:validate', ctx, { services: foldedServices });
        if (verdict.verdict !== 'clean') {
          throw new ConnectorServicesInvalidError(verdict.reason);
        }
      }
    } catch (err) {
      const reason =
        err instanceof ConnectorServiceCollisionError ||
        err instanceof ConnectorServicesInvalidError
          ? 'connector-services-invalid'
          : 'connector-services-internal';
      ctx.logger.warn('connector_services_fold_failed', {
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
      const outcome: AgentOutcome = {
        kind: 'terminated',
        reason,
        error: err,
      };
      // Pre-waiter early-return: surface on the SSE so the client doesn't hang
      // (coarse `reason` only — never the raw err / descriptor detail). Same
      // shape as the chat:start / agent-resolve early-returns above.
      await fireTurnError(ctx, ctx.reqId, outcome.reason);
      await fireChatEvent('chat:end', ctx, { outcome });
      return outcome;
    }
    // Append connector slots AFTER the skill slots so the bare-env projection's
    // first-writer-wins keeps SKILL precedence on a shared bare name (a connector
    // and a skill both reading `LINEAR_API_KEY` → the skill wins the flat-env
    // stamp; the connector's own credential still reaches the proxy under its
    // namespaced placeholder).
    for (const slot of connectorFold.connectorSlotEnvNames) {
      skillSlotEnvNames.push(slot);
    }

    // D: auto-allowlist public package registries when a CONNECTOR in the union
    // declares npm/pypi packages. Specific hosts only, gated on installation (I5 —
    // no blanket egress). TASK-100 — a SKILL declares no packages of its own (its
    // reach is the connectors it references), so only the connector fold drives
    // the registry auto-allow now.
    const needsNpmRegistry = connectorFold.needsNpmRegistry;
    const needsPypiRegistry = connectorFold.needsPypiRegistry;
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
      // TASK-100 — a skill declares NO MCP servers / hosts / credentials of its
      // own: all of a skill's reach is the connectors it references, materialized
      // as CONNECTOR installed-entries below (synthetic SKILL.md + per-dir
      // `.mcp.json`, namespaced `connector:<id>:<slot>` credentials). A skill's
      // own sandbox entry is just its SKILL.md + bundle files (instruction
      // content), so these are empty.
      mcpServers: [],
      allowedHosts: [],
      credentials: [],
    }));

    // TASK-97 — connector installed-skill entries (synthetic SKILL.md +
    // mcpServers) from the connector fold. Kept SEPARATE from the skill entries
    // because a connector entry's credential placeholders key off
    // `connector:<connectorId>:<slot>` (not `skill:<id>:<slot>`), so they need
    // their own stamping loop below. The entry `id` is the sandbox-safe derived
    // dir id; `connectorId` is the original id used for the namespaced lookup.
    const connectorInstalledEntries: Array<
      InstalledSkillForSandbox & { connectorId: string; headerBindings?: Array<{ server: string; name: string; slot: string; bearer: boolean }> }
    > = connectorFold.installedEntries.map((e) => ({
      id: e.id,
      files: e.files,
      mcpServers: e.mcpServers,
      allowedHosts: e.allowedHosts,
      credentials: e.credentials,
      connectorId: e.connectorId,
      ...(e.headerBindings ? { headerBindings: e.headerBindings } : {}),
    }));

    // TASK-687 — `unionedAllowlist` (where the session MAY reach) and each
    // credential's `allowedHosts` (where THAT credential MAY be sent) are two
    // separate questions, deliberately answered from separate sources:
    //   - provider key      -> its provider's egress host (PROVIDER_ENDPOINTS, code)
    //   - explicit agent row -> that row's `allowedHosts` (dev-agents-stub only)
    //   - connector slots   -> that connector's OWN declared `allowedHosts`
    //                          (api-key and oauth/mcp-oauth alike)
    // Host grants (`host-grants:list`) and the live `proxy:add-host` are
    // user-driven and only ever widen the SESSION allowlist above. They never
    // extend a binding: a user who grants a host they control must not thereby
    // be sent a real key (e.g. the operator's global model key) by the proxy.
    // A credential with no binding is never substituted (default deny).
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
        stampConnectorHeaders(entry, opened.envMap);
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
      // I10 — flag the session for per-turn rotation when ANY credential in
      // the MERGED session set has a non-`api-key` kind. The credentials
      // facade's resolve sub-service handles the actual refresh; rotate-session
      // re-resolves through the facade and updates the placeholder map.
      // I11 — the placeholder envMap stays stable across rotations; only
      // the registry's placeholder→real-value mapping updates. We don't
      // propagate the new envMap into the running runner.
      //
      // Gate over `unionedCreds` (the merged set handed to proxy:open-session),
      // NOT `agent.requiredCredentials`: connector-sourced `mcp-oauth` creds are
      // folded into `unionedCreds` by foldConnectorCaps and are refreshable too,
      // so the gate must consider the merged set or a connector-only OAuth
      // session never rotates (stale token after ~1h on a warm session).
      if (
        sessionNeedsCredentialRotation(unionedCreds) &&
        bus.hasService('proxy:rotate-session')
      ) {
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
        await closeProxySession(ctx, ctx.sessionId, 'open-failed');
      }
      // TASK-783 — attribute the failure to the connector that owns the
      // credential the proxy failed on (`slotOwners` is the fold's own
      // envName → `connector:<id>` record; the kept list carries the name).
      const failure = classifyProxyOpenFailure(err, (envName) => {
        const owner = slotOwners.get(envName);
        if (owner === undefined || !owner.startsWith('connector:')) return undefined;
        const id = owner.slice('connector:'.length);
        return connectorSignIn.kept.find((c) => c.id === id);
      });
      const outcome: AgentOutcome = {
        kind: 'terminated',
        reason: failure.reason,
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
      // detail leaks). TASK-783: plus, for a connector failure, the connector's
      // label as the detail line — host-sanitized text, never the error's.
      await fireTurnError(ctx, ctx.reqId, outcome.reason, failure.detail);
      await fireChatEvent('chat:end', ctx, { outcome });
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
        ...connectorInstalledEntries.map(({ connectorId: _cid, headerBindings: _headers, ...e }) => e),
      ];
      const sandboxInput: OpenSessionInput = {
        sessionId,
        workspaceRoot: ctx.workspace.rootPath,
        // PR 2 — resolve the agent's runner ID to a binary path HERE, at the
        // wire boundary. The wire keeps carrying one resolved absolute path;
        // the map never leaves the host. A miss throws into the catch below →
        // the turn terminates with `sandbox-open-failed`.
        runnerBinary: resolveRunnerBinary(config.runnerBinaries, agent.runner),
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
          // TASK-181 — forward the HOST-DERIVED session origin so session:create
          // persists it on the session record and the IPC server stamps it onto
          // the happy-path runner-completed chat:end ctx (@ax/memory reads it to
          // store a routine turn's rows with no conversation — TASK-616).
          // ctx.source is set host-side ONLY: routines `fire.ts` stamps 'routine'; a user turn
          // leaves it unset. The runner can't reach this — it travels the
          // host-internal sandbox:open-session hook, never the IPC wire. Conditional
          // spread keeps the key ABSENT (not `undefined`) for user turns, matching
          // the exactOptionalPropertyTypes posture.
          ...(ctx.source !== undefined ? { source: ctx.source } : {}),
        },
        // Phase 6: credential-proxy is mandatory; proxyConfig is always set
        // by the time we reach this point (the !proxyOpenLoaded gate above
        // returns early with `proxy-not-loaded` otherwise).
        proxyConfig,
        ...(allInstalledSkills.length > 0 ? { installedSkills: allInstalledSkills } : {}),
        // TASK-153 — dev services folded from the agent's admin-approved
        // connectors (deduped by name + validated above). Omitted when none, so
        // non-connector / CLI paths leave the field unset. Both backends render
        // it; the wire schema re-validates (digest-pin, caps, no smuggled vocab).
        ...(foldedServices.length > 0 ? { services: foldedServices } : {}),
      };
      const opened = await bus.call<OpenSessionInput, OpenSessionResult>(
        'sandbox:open-session',
        ctx,
        sandboxInput,
      );
      handle = opened.handle;
      augmentGenBySession.set(sessionId, augmentGenAtSpawn);
      // TASK-811/833 — every connector resolved for this spawn, skipped ones
      // included (a skipped connector's edit or delete matters as much).
      recordSessionConnectors(sessionId, agent, allConnectors, skillConnectorIds);
      if (connectorSignIn.skipped.length > 0) {
        skippedConnectorRefsBySession.set(
          sessionId,
          [...new Set(connectorSignIn.skipped.flatMap((s) => s.refs))],
        );
      }
      if (keepAlive) {
        // Warm the session: the runner outlives this request. One handle.exited
        // cleanup covers every reap path (graceful cancel, force kill, runner
        // floor, ceiling): close the proxy session once and drop the registry
        // entry. This is also why the per-invoke finally must NOT close the
        // proxy in keepalive mode (see the finally below).
        warmSessions.set(sessionId, {
          handle, agentId: ctx.agentId, proxyOpened, idleTimer: null, graceTimer: null,
        });
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
            augmentGenBySession.delete(sessionId);
            skippedConnectorRefsBySession.delete(sessionId);
            rotationFailedSessions.delete(sessionId);
            forgetSessionConnectors(sessionId);
            if (proxyOpened) {
              void closeProxySession(warmCtx, warmCtx.sessionId, 'runner-exit');
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
      // TASK-160 — when the sandbox backend self-diagnosed a dev-service-sidecar
      // startup failure (a missing writablePath → EROFS, etc.), it threw a
      // PluginError carrying a neutral `diagnosis` ({ service, path?, reason }).
      // Surface an author-facing, actionable message instead of the opaque
      // generic reason: a dedicated stable code + a formatted (bounded,
      // sanitized, untrusted-safe) `detail` line. The diagnosis is rendered as
      // text — never interpolated into a prompt/command.
      const diagnosis =
        err instanceof PluginError && err.diagnosis !== undefined
          ? err.diagnosis
          : undefined;
      const isServiceFailure =
        diagnosis !== undefined && typeof diagnosis.service === 'string';
      const reason = isServiceFailure ? 'dev-service-failed' : 'sandbox-open-failed';
      const detail = isServiceFailure
        ? formatServiceDiagnosis({
            service: String(diagnosis.service),
            ...(typeof diagnosis.path === 'string' ? { path: diagnosis.path } : {}),
            reason:
              typeof diagnosis.reason === 'string' ? diagnosis.reason : 'startup failed',
          })
        : undefined;
      const outcome: AgentOutcome = {
        kind: 'terminated',
        reason,
        error: err,
      };
      // F2b — surface on the SSE. This early return unregistered the waiter
      // above, so onChatEnd won't fire turn-error for the chat:end below; we
      // hold the original ctx.reqId here, so the SSE matches by reqId.
      await fireTurnError(ctx, ctx.reqId, outcome.reason, detail);
      await fireChatEvent('chat:end', ctx, { outcome });
      return outcome;
    }

    // TASK-100 — the authored-SKILL upfront approval card was removed: a skill
    // declares no capabilities (its reach is the connectors it references), so a
    // model-authored skill has no per-skill cap delta to approve. The connector
    // approval card below is the surviving upfront-card path (a connector's reach
    // is what a human approves); request_capability still fires the JIT card when
    // a skill's referenced connector needs approval at first use.

    // TASK-94 / TASK-112 — fire ONE upfront approval card per PENDING authored
    // connector draft (the surviving upfront-card path). Same helper the
    // warm/routed path calls, so both behave identically (one source of truth).
    await fireUpfrontConnectorCards(ctx, agent.id);

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
          // Record WHICH runner is about to serve this turn. The row's
          // `runner_type` is refreshed on every bind rather than frozen at
          // create, because an agent's runner can be switched at any time and
          // that switch demotes the next turn to a fresh session, REPLACING
          // the stored transcript with the new runner's format. A frozen
          // value would be wrong exactly when someone looked at it.
          runnerType: agent.runner,
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
      await fireChatEvent('chat:end', ctx, { outcome });
      return outcome;
    }
    // TASK-688 — the message is in the inbox; a Stop clicked during the cold
    // spawn goes in right behind it.
    await afterUserMessageQueued(ctx, sessionId);

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
    //
    // TASK-784 — the exit info says WHY. A runner that exits with the runner
    // shell's fatal code (2) before chat:end never booted far enough to talk
    // to us (a bad env, a refused IPC connect…), so the user gets
    // `runner-boot-failed` instead of the generic `sandbox-exit-before-chat-end`.
    // Only the fixed reason code crosses to the (untrusted) client; the exit
    // code/signal/backend reason go to the host log, clamped. The runner's own
    // stderr is logged by the sandbox (subprocess: `runner_exited_nonzero`;
    // k8s: pod logs) and never reaches the browser.
    handle.exited
      .then((info) => {
        if (!deferred.settled) {
          resolvedByChatEndSubscriber = false;
          const reason = classifyRunnerExit(info);
          ctx.logger.warn('runner_exit_before_chat_end', {
            reason,
            ...runnerExitLogFields(info),
          });
          deferred.resolve({ kind: 'terminated', reason });
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
      await fireChatEvent('chat:end', ctx, { outcome });
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
        await closeProxySession(ctx, ctx.sessionId, 'invoke-end');
        // I10 — drop the rotation flag on the non-warm paths only. A warm
        // session must keep rotating across turns, so its cleanup is deferred
        // to handle.exited (Step 5); clearing it here would disable
        // proxy:rotate-session for every turn after the first.
        sessionsNeedingRotation.delete(ctx.sessionId);
        // Same lifetime rule for the augment generation (TASK-612): a warm
        // session drops it in handle.exited; a one-shot session is done now.
        augmentGenBySession.delete(ctx.sessionId);
        skippedConnectorRefsBySession.delete(ctx.sessionId);
        rotationFailedSessions.delete(ctx.sessionId);
        forgetSessionConnectors(ctx.sessionId);
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

  function onTurnEnd(
    ctx: AgentContext,
    payload?: { reqId?: string; foldedReqIds?: unknown },
  ): void {
    // I10 — rotate proxy credentials BEFORE the one-shot cancel, so that any
    // tool-call follow-ups inside the same turn (model→tool→model) pick up
    // the refreshed token. api-key-only sessions skip THIS rotation: their
    // kind never refreshes. (A key REPLACED by a person is picked up when the
    // next message is routed in — TASK-860, refreshWarmSessionCredentials.)
    //
    // The rotation is fire-and-forget: a failing rotate (network blip,
    // refresh-failed) shouldn't kill the chat. The credentials facade's
    // resolve sub-service is what decides whether to refresh. If the refresh
    // fails, the session is marked for retirement (TASK-783): the NEXT turn
    // re-spawns, and its fresh proxy:open-session reports a dead connector
    // sign-in as `connector-needs-reconnect` naming the connector, rather than
    // the turn failing later at the provider with a bare 401.
    if (sessionsNeedingRotation.has(ctx.sessionId)) {
      void bus
        .call<{ sessionId: string }, { envMap: Record<string, string> }>(
          'proxy:rotate-session',
          ctx,
          { sessionId: ctx.sessionId },
        )
        .catch((err: unknown) => {
          // TASK-783 — name/code only (a refresh failure's message can carry
          // the OAuth server's own text), plus OUR env key for the credential
          // that failed, when the proxy named one.
          const envName = failedCredentialEnvName(err);
          ctx.logger.warn('proxy_rotate_session_failed', {
            sessionId: ctx.sessionId,
            ...errorLogFields(err),
            ...(envName !== undefined ? { envName } : {}),
          });
          // A warm session whose credentials could not be refreshed would run
          // its next turn on a dead token and fail at the provider with nothing
          // naming the cause. Retire it instead: the next turn re-spawns, and
          // the fresh proxy:open-session resolves every ref again — so a dead
          // connector sign-in surfaces as `connector-needs-reconnect` naming
          // that connector (or the turn simply runs, if this was a blip).
          rotationFailedSessions.add(ctx.sessionId);
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
      resolveFoldedWaiters(ctx.sessionId, payload?.foldedReqIds);
      // TASK-833 — a session holding a since-deleted connector is reaped now,
      // and (TASK-877) its proxy session closed now rather than on runner exit.
      if (connectorDeletedSessions.has(ctx.sessionId)) {
        closeProxyForDeletedConnector(ctx, ctx.sessionId);
        armReapTimer(ctx, 0);
      } else {
        armReapTimer(ctx, idleWindowMs);
      }
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
    // TASK-100 — a catalog skill declares NO credential slots (its reach is the
    // connectors it references), so the attachment carries no credential
    // bindings: "granting" a skill simply attaches it for the user (the skill's
    // body materializes next spawn). A referenced connector's credentials are
    // bound by the connector connect/approval flow, not here.
    const credentialBindings: Record<string, string> = {};

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

  // TASK-688 — Stop. Interrupt the conversation's in-flight turn: queue
  // `{ type: 'interrupt' }` into its live session's inbox. The runner stops the
  // running model call / tool and STAYS WARM for the next message — that is the
  // difference from `cancel` (ends the session) and `session:terminate` (kills
  // the sandbox and errors the turn). Host-side only; the agent/runner cannot
  // reach it, and the entry carries no payload, so nothing untrusted rides it.
  //
  // ACL: `conversations:get` filters by userId (then agents:resolve), so a
  // foreign or unknown conversation throws not-found/forbidden. Those
  // PluginErrors PROPAGATE on purpose (unlike activeAliveSession, which
  // swallows) — the route maps them to a 404 and must never see a bare `false`
  // for a conversation the caller doesn't own.
  async function interruptTurn(
    ctx: AgentContext,
    input: AgentInterruptInput,
  ): Promise<AgentInterruptOutput> {
    // Without a conversation store there is no "the conversation's turn" to name.
    if (!bus.hasService('conversations:get')) return { interrupted: false };
    const conv = await bus.call<ConversationsGetInput, ConversationsGetOutput>(
      'conversations:get', ctx,
      { conversationId: input.conversationId, userId: input.userId },
    );
    // `active_req_id` is bound at POST time and cleared on chat:turn-end, so
    // null/empty means no turn is in flight.
    const reqId = conv.conversation.activeReqId;
    if (reqId === null || reqId.length === 0) return { interrupted: false };

    const candidate = conv.conversation.activeSessionId;
    const sessionId =
      candidate !== null && candidate.length > 0 ? candidate : null;
    let alive = false;
    if (sessionId !== null && bus.hasService('session:is-alive')) {
      const r = await bus.call<SessionIsAliveInput, SessionIsAliveOutput>(
        'session:is-alive', ctx, { sessionId },
      );
      alive = r.alive;
    }

    // ---- NO await between here and the check-and-add below ----
    //
    // Cold spawn: this reqId's agent:invoke has not yet queued its user message
    // (there may be no session, or only the POST-time placeholder). Record the
    // Stop; afterUserMessageQueued() queues the interrupt behind the message.
    // The has() and add() run in one synchronous step relative to that
    // function's delete-then-check, so a Stop is never lost between them.
    if (pendingMessageReqIds.has(reqId)) {
      stopRequestedReqIds.add(reqId);
      return { interrupted: true };
    }

    // The plain path: the message is queued (or this is a continuation turn
    // started by an approval — it has an active_req_id but no agent:invoke in
    // flight). Interrupt the live session directly.
    if (sessionId === null || !alive) return { interrupted: false };
    try {
      await bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
        'session:queue-work', ctx, { sessionId, entry: { type: 'interrupt' } },
      );
    } catch (err) {
      // Lost a race with teardown: the session ended between is-alive and the
      // queue. Nothing left to stop. Anything else is a real failure — it must
      // reach the caller, not read as "stopped".
      if (err instanceof PluginError && err.code === 'unknown-session') {
        return { interrupted: false };
      }
      throw err;
    }
    return { interrupted: true };
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
      if (keepAlive && !warmSessions.has(candidate)) return null;
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

    // TASK-100 — a skill declares NO capabilities, so there is nothing per-skill
    // to approve into the caps wall: "approving" an authored skill simply flips
    // its pending draft to active so its instruction body materializes next
    // spawn. (A skill's connector reach is approved via the connector grant path,
    // applyAuthoredConnectorGrant, under the connector approval card — not here.)
    //
    // Flip the authored row pending→active (TASK-76, §D3). Status-guarded in the
    // store (only a pending row flips; quarantined stays quarantined). Fail-loud:
    // a flip error propagates rather than silently leaving the skill stuck
    // pending. hasService-guarded — a preset without @ax/skills (CLI stub) no-ops.
    if (bus.hasService('skills:authored-activate')) {
      await bus.call('skills:authored-activate', ctx, {
        ownerUserId: input.userId,
        agentId: input.agentId,
        skillId: input.skillId,
      });
    }

    // Drop the upfront connector-card dedup for this conversation so the next
    // spawn re-evaluates (a freshly-active skill may reference connectors that
    // still need their own approval card). The My Skills "approve early" path has
    // no conversation, so skip when absent.
    const convId = input.conversationId;
    if (convId !== undefined) upfrontConnectorCardsByConv.delete(convId);

    // A freshly-active instruction-only skill has no credential/host reach of its
    // own, so there is nothing to live-widen or re-spawn for here: the skill's
    // body materializes on the next turn's spawn. (Its referenced connectors'
    // reach is wired by the connector grant path + the skill→connector bridge.)
    // Retire the warm session so the next turn cold-spawns with the now-active
    // skill's body in the union.
    let respawned = false;
    if (convId !== undefined) {
      const warm = await activeAliveSession(ctx, convId, input.userId);
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
    }
    return { applied: true, respawned };
  }

  // TASK-94 — apply a user-approved authored-CONNECTOR capability grant. The
  // twin of applyAuthoredCapabilityGrant, but the SUBJECT is a connector: the
  // host re-resolves the agent's authored connector drafts (server-authoritative
  // — an unknown connectorId returns not-authored), approves the proposal
  // (host/slot/npm/pypi; mcp deferred — the wall rejects kind:'mcp') under the
  // TASK-93 wall with a `connectorId` subject, then flips the draft active. A
  // credential slot → re-spawn next turn; host/pkg-only → live widen.
  async function applyAuthoredConnectorGrant(
    ctx: AgentContext,
    input: ApplyAuthoredConnectorGrantInput,
  ): Promise<ApplyAuthoredConnectorGrantOutput> {
    // 1. Re-resolve the agent's authored connector drafts — the HOST is the
    //    authority on which connectorIds are this agent's drafts. A resolve
    //    failure (DB hiccup) → not-authored so the caller doesn't mis-apply.
    let drafts: ConnectorsListAuthoredOutput['drafts'] = [];
    if (bus.hasService('connectors:list-authored')) {
      try {
        const r = await bus.call<
          { ownerUserId: string; agentId: string },
          ConnectorsListAuthoredOutput
        >('connectors:list-authored', ctx, {
          ownerUserId: input.userId,
          agentId: input.agentId,
        });
        drafts = r.drafts;
      } catch (err) {
        ctx.logger.warn('authored_connector_grant_resolve_failed', {
          agentId: input.agentId,
          connectorId: input.connectorId,
          err: err instanceof Error ? err.message : String(err),
        });
        return { applied: false, reason: 'not-authored' };
      }
    }
    const draft = drafts.find((d) => d.connectorId === input.connectorId);
    if (draft === undefined) return { applied: false, reason: 'not-authored' };

    // 2. Build the approval rows from the proposal, applying the same `shown`
    //    TOCTOU intersection guard as the skill grant: anything in the current
    //    proposal but NOT in `shown` is silently skipped (the client `shown`
    //    can only NARROW, never expand). When `shown` is absent, approve the
    //    full current proposal.
    const proposal = draft.proposal;
    const proposalNpm = proposal.packages?.npm ?? [];
    const proposalPypi = proposal.packages?.pypi ?? [];

    const shownHostSet = input.shown !== undefined ? new Set(input.shown.hosts) : null;
    const shownSlotSet = input.shown !== undefined ? new Set(input.shown.slots) : null;
    const shownNpmSet  = input.shown !== undefined ? new Set(input.shown.npm)   : null;
    const shownPypiSet = input.shown !== undefined ? new Set(input.shown.pypi)  : null;

    const approvedHosts = shownHostSet !== null
      ? proposal.allowedHosts.filter((h) => shownHostSet.has(h))
      : proposal.allowedHosts;
    const approvedCreds = shownSlotSet !== null
      ? proposal.credentials.filter((c) => shownSlotSet.has(c.slot))
      : proposal.credentials;
    const approvedNpm = shownNpmSet !== null
      ? proposalNpm.filter((p) => shownNpmSet.has(p))
      : proposalNpm;
    const approvedPypi = shownPypiSet !== null
      ? proposalPypi.filter((p) => shownPypiSet.has(p))
      : proposalPypi;

    const rows: Array<{
      kind: 'host' | 'slot' | 'npm' | 'pypi';
      value: string;
      detail?: { kind: 'api-key'; account?: string };
    }> = [
      ...approvedHosts.map((h) => ({ kind: 'host' as const, value: h })),
      ...approvedCreds.map((c) => ({
        kind: 'slot' as const,
        value: c.slot,
        // `c.account` is VESTIGIAL here: this is the authored-CONNECTOR grant path
        // and `draft.proposal` is read back through the authored store, which strips
        // `account` (credentials-into-connectors: connectors own their own key, keyed
        // by id). It is always undefined; retained only for shape parity.
        detail: { kind: 'api-key' as const, ...(c.account !== undefined ? { account: c.account } : {}) },
      })),
      ...approvedNpm.map((p) => ({ kind: 'npm' as const, value: p })),
      ...approvedPypi.map((p) => ({ kind: 'pypi' as const, value: p })),
    ];

    // 3. Write the approval rows under the TASK-93 connector-subject wall
    //    (`skills:approved-caps-set` with `connectorId`). Fail-loud (propagate)
    //    + idempotent, same posture as the skill grant. hasService-guarded.
    if (bus.hasService('skills:approved-caps-set')) {
      for (const row of rows) {
        await bus.call('skills:approved-caps-set', ctx, {
          ownerUserId: input.userId,
          agentId: input.agentId,
          connectorId: input.connectorId,
          kind: row.kind,
          value: row.value,
          ...(row.detail !== undefined ? { detail: row.detail } : {}),
        });
      }
    }

    // 3a. PROMOTE the approved connector into the curated registry (TASK-113 —
    //     the load-bearing fix). The approved-caps rows above only GATE reach;
    //     the connector's reach is FOLDED from the registry by
    //     resolveEffectiveConnectors → foldConnectorCaps, and the UI surfaces
    //     read the registry too. So an approved authored connector must land in
    //     the registry, or it never reaches the sandbox NOR the UI (the
    //     TASK-101-walk bug: npx hits npm 403 + the reactive wall; the connector
    //     is invisible/unattachable).
    //
    //     ONE SOURCE OF TRUTH (invariant #4): the REGISTRY row is authoritative
    //     for the active connector. The authored row stays draft/proposal
    //     staging — flipped `active` below only for the audit trail; nothing
    //     reads the authored table for active reach or UI. We do NOT add a
    //     second read path.
    //
    //     We promote the APPROVED capability surface — the `shown`-narrowed sets
    //     computed above, NOT the full proposal — so promoted reach == approved
    //     reach (the TOCTOU guard flows through to the registry row). mcpServers
    //     ride from the draft proposal verbatim (no per-mcp `shown` narrowing in
    //     the card today; the wall does not card individual MCP servers).
    //     keyMode/name/usageNote come from the resolved draft. `visibility` is
    //     the safe `private` default (owner-scoped reach); an admin re-curates to
    //     shared later (mirrors the cap-migration promotion default).
    //
    //     Ordered BEFORE the activate flip so a promotion failure leaves the
    //     draft `pending` (re-approvable) rather than active-but-unpromoted.
    //     Fail-loud (propagate), like the activate flip. hasService-guarded for
    //     back-compat with a preset that strips @ax/connectors.
    if (bus.hasService('connectors:upsert')) {
      const promotedCapabilities: ConnectorsUpsertInput['capabilities'] = {
        allowedHosts: approvedHosts,
        credentials: approvedCreds,
        mcpServers: proposal.mcpServers,
        packages: { npm: approvedNpm, pypi: approvedPypi },
      };
      const upsertInput: ConnectorsUpsertInput = {
        userId: input.userId,
        connectorId: input.connectorId,
        name: draft.name,
        description: '',
        usageNote: draft.usageNote,
        keyMode: draft.keyMode,
        visibility: 'private',
        capabilities: promotedCapabilities,
      };
      await bus.call('connectors:upsert', ctx, upsertInput);
    }

    // 3b. Flip the connector draft pending→active. Status-guarded + idempotent
    //     in the store; fail-loud here. hasService-guarded.
    if (bus.hasService('connectors:activate-authored')) {
      await bus.call('connectors:activate-authored', ctx, {
        ownerUserId: input.userId,
        agentId: input.agentId,
        connectorId: input.connectorId,
      });
    }

    // 4. Drop the per-conversation card dedup so a post-approve spawn re-fires
    //    only if something remains unapproved.
    const convId = input.conversationId;
    if (convId !== undefined) upfrontConnectorCardsByConv.delete(convId);

    // 5. Re-spawn vs live-widen (same asymmetry as the skill grant): an
    //    approved credential slot is frozen at spawn → retire the warm session
    //    so the next turn re-spawns; host/pkg-only → live widen the warm
    //    session. With no conversation there's nothing live — the rows +
    //    activate are the whole effect and the next turn cold-spawns approved.
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
          ctx.logger.warn('authored_connector_grant_retire_failed', {
            conversationId: input.conversationId,
            err: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
      return { applied: true, respawned };
    }

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
            ctx.logger.warn('authored_connector_grant_add_host_failed', {
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
    interruptTurn,
    applyAuthoredCapabilityGrant,
    applyAuthoredConnectorGrant,
    onHttpEgress,
    onSkillsProposed,
    onConnectorProposed,
    onSystemPromptAugmentChanged,
    onAgentDeleted,
    onConnectorDeleted,
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

// TASK-153 — `services:validate` returned a non-clean verdict on the folded
// connector dev services. Distinct from the cross-connector collision (thrown by
// the fold itself) so the catch can map BOTH to the same coarse terminated
// `reason` while keeping the named cause on the audit outcome. The reason string
// (which may name the offending descriptor field) stays host-side; only the
// coarse `connector-services-invalid` reason crosses to the client.
class ConnectorServicesInvalidError extends Error {
  constructor(public readonly verdictReason: string) {
    super(`connector dev services failed validation: ${verdictReason}`);
    this.name = 'ConnectorServicesInvalidError';
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
/** Per-session proxy token: 32 lowercase hex (mirrors ProxyConfigSchema). */
const PROXY_AUTH_TOKEN_FORMAT = /^[0-9a-f]{32}$/;

function endpointToProxyConfig(
  rawEndpoint: string,
  caCertPem: string,
  envMap: Record<string, string>,
  proxyAuthToken: unknown,
): ProxyConfig {
  // TASK-784 — the token is the proxy's caller credential (TASK-158) and the
  // runner refuses to boot without one (TASK-704). Fail closed HERE, before a
  // sandbox is spawned, rather than letting the sandbox schema (or the runner)
  // refuse it later. The value is never echoed into the error. (This covers a
  // proxy config built here — the only one the orchestrator produces. Since
  // TASK-838 the sandbox input schema also requires `proxyConfig` itself, so a
  // session opened without one is refused at the sandbox boundary too.)
  if (typeof proxyAuthToken !== 'string' || !PROXY_AUTH_TOKEN_FORMAT.test(proxyAuthToken)) {
    throw new PluginError({
      code: 'invalid-proxy-auth-token',
      plugin: PLUGIN_NAME,
      message: 'proxy:open-session returned no well-formed proxyAuthToken',
    });
  }
  const token = { proxyAuthToken };
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
