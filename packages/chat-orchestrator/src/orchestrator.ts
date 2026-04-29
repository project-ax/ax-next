import { PluginError, type AgentContext, type AgentMessage, type AgentOutcome, type HookBus } from '@ax/core';

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
}

export interface AgentInvokeInput {
  message: AgentMessage;
  // Forwarded to the runner's turn loop eventually. For 6.5a the runner has
  // its own default; the orchestrator currently ignores maxTurns for dispatch
  // but preserves the field name so the shape lines up with Week 4-6's
  // chat-loop.ts caller contract.
  maxTurns?: number;
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
}
interface AgentsResolveOutput {
  agent: AgentRecord;
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
}
interface ProxyCloseSessionInput {
  sessionId: string;
}

// AgentConfig sent through sandbox:open-session and persisted on the
// session row. The session-postgres / session-inmemory plugins both
// declare the same shape; drift is caught at the bus call site.
interface AgentConfig {
  systemPrompt: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
}

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

/**
 * Proxy-session blob threaded from the orchestrator into the sandbox plugin.
 * The orchestrator opens a `proxy:open-session` BEFORE `sandbox:open-session`
 * (when @ax/credential-proxy is loaded) and packs the resolved endpoint, CA
 * cert PEM, and per-session credential placeholder envMap into this shape.
 *
 * Field naming is deliberately backend-agnostic (I3): `endpoint` and
 * `unixSocketPath` are mutually exclusive — the subprocess sandbox uses the
 * TCP loopback form (`endpoint`); the k8s sandbox passes through the Unix
 * socket path so the runner-side bridge can convert it to a local TCP port
 * inside the sandbox. `caCertPem` is the PEM bytes; the sandbox plugin owns
 * "where on disk to write this." The orchestrator never knows or cares.
 */
export interface ProxyConfig {
  /** TCP endpoint (subprocess sandbox), e.g. 'http://127.0.0.1:54321'. */
  endpoint?: string;
  /** Unix socket path (k8s sandbox), e.g. '/var/run/ax/proxy.sock'. */
  unixSocketPath?: string;
  /**
   * MITM CA certificate PEM bytes. Sandbox runtime writes this to disk
   * inside the sandbox and points NODE_EXTRA_CA_CERTS / SSL_CERT_FILE at
   * the path. The orchestrator never knows the path.
   */
  caCertPem: string;
  /**
   * Env injected by `proxy:open-session`. Maps env-var names (e.g.
   * `ANTHROPIC_API_KEY`) to `ax-cred:<hex>` placeholders the proxy
   * recognizes. Sandbox-subprocess merges these into the runner env.
   */
  envMap: Record<string, string>;
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
   * (Task 6d).
   */
  owner: {
    userId: string;
    agentId: string;
    agentConfig: AgentConfig;
  };
  /**
   * Per-session proxy blob. Populated only when @ax/credential-proxy is
   * loaded; otherwise undefined and sandbox:open-session injects no
   * proxy env, leaving the runner to fail at boot when no AX_PROXY_* is
   * set. Presets that want a working runner load @ax/credential-proxy.
   */
  proxyConfig?: ProxyConfig;
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

export function createOrchestrator(
  bus: HookBus,
  config: ChatOrchestratorConfig,
): {
  runAgentInvoke(ctx: AgentContext, input: AgentInvokeInput): Promise<AgentOutcome>;
  onChatEnd(ctx: AgentContext, payload: { outcome: AgentOutcome }): void;
  onTurnEnd(ctx: AgentContext): void;
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
  const chatTimeoutMs = config.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  const oneShot = config.oneShot ?? true;
  // Sessions that have already been cancelled — prevents a second
  // chat:turn-end (from a misbehaving runner) from queueing a duplicate
  // cancel entry.
  const cancelledSessions = new Set<string>();

  // Phase 3 / I10 — sessions whose agent has at least one non-`api-key`
  // credential get `proxy:rotate-session` fired between turns. api-key-only
  // sessions stay in coarse mode (no rotation, identical to Phase 2).
  // Membership is added after a successful proxy:open-session and removed in
  // the runAgentInvoke finally that fires proxy:close-session.
  const sessionsNeedingRotation = new Set<string>();

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
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
    }

    // 3. Build the agent config snapshot we'll freeze on the session.
    //    Per Invariant I10: this is captured ONCE at session creation;
    //    live edits to the agent row (via /admin/agents PATCH in Task 9)
    //    do not affect in-flight sessions.
    const agentConfig: AgentConfig = {
      systemPrompt: agent.systemPrompt,
      allowedTools: agent.allowedTools,
      mcpConfigIds: agent.mcpConfigIds,
      model: agent.model,
    };

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
            routedSessionId = candidate;
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
        await bus.fire('chat:end', ctx, { outcome });
      }
      // No handle.kill() — we did not open this sandbox.
      return outcome;
    }

    // 4.5 — proxy:open-session. Fresh-spawn path only: a routed
    //       agent:invoke reuses an existing live sandbox whose proxy
    //       session was opened by the orchestrator that originally
    //       spawned it. Soft dep: when @ax/credential-proxy isn't loaded,
    //       proxyConfig stays undefined and sandbox:open-session injects
    //       no proxy env — the runner will fail at boot. Presets that
    //       want a working runner load @ax/credential-proxy.
    //
    //       I7 — `proxy:close-session` always fires once per `proxy:open-
    //       session`. We track that with `proxyOpened`; the finally below
    //       fires close exactly once when the flag is set, regardless of
    //       which exit path won.
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
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
    }
    const proxyLoaded = proxyOpenLoaded && proxyCloseLoaded;
    let proxyConfig: ProxyConfig | undefined;
    let proxyOpened = false;
    if (proxyLoaded) {
      try {
        const opened = await bus.call<ProxyOpenSessionInput, ProxyOpenSessionOutput>(
          'proxy:open-session',
          ctx,
          {
            sessionId: ctx.sessionId,
            userId: ctx.userId,
            agentId: agent.id,
            allowlist: agent.allowedHosts ?? [],
            credentials: agent.requiredCredentials ?? {},
          },
        );
        // Mark opened BEFORE endpointToProxyConfig — that helper throws on
        // unrecognized scheme, and we still owe the proxy a close in that
        // case (the session was minted before the throw).
        proxyOpened = true;
        proxyConfig = endpointToProxyConfig(
          opened.proxyEndpoint,
          opened.caCertPem,
          opened.envMap,
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
        await bus.fire('chat:end', ctx, { outcome });
        return outcome;
      }
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
      const sandboxInput: OpenSessionInput = {
        sessionId,
        workspaceRoot: ctx.workspace.rootPath,
        runnerBinary: config.runnerBinary,
        owner: {
          userId: ctx.userId,
          agentId: agent.id,
          agentConfig,
        },
      };
      // exactOptionalPropertyTypes: only spread proxyConfig in when set.
      if (proxyConfig !== undefined) {
        sandboxInput.proxyConfig = proxyConfig;
      }
      const opened = await bus.call<OpenSessionInput, OpenSessionResult>(
        'sandbox:open-session',
        ctx,
        sandboxInput,
      );
      handle = opened.handle;
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
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
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
      await bus.fire('chat:end', ctx, { outcome });
    }

    // 7. Kill the sandbox if it's still alive. session:terminate is fired
    //    by sandbox-subprocess's own child-close handler, so we don't call
    //    it here — that would double-fire.
    try {
      await handle.kill();
    } catch {
      // best-effort
    }

    return outcome;
    } finally {
      // I7 — proxy:close-session fires exactly once per fresh-spawn path
      // that successfully opened a proxy session. Any failure inside the
      // try (sandbox-open-failed / queue-work-failed / chat-run-timeout /
      // sandbox-exit / chat:end happy path) flows through this finally.
      // Best-effort: a failing close shouldn't mask the chat outcome.
      if (proxyOpened) {
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
      }
      // I10 — drop rotation flag regardless of close outcome. A late
      // turn-end after this point is a no-op (set lookup misses).
      sessionsNeedingRotation.delete(ctx.sessionId);
    }
  }

  function onChatEnd(ctx: AgentContext, payload: { outcome: AgentOutcome }): void {
    // Two firing paths:
    //   1. Orchestrator self-fire (error paths) — ctx is the agent:invoke
    //      ctx, so ctx.reqId matches a waitersByReqId entry directly.
    //   2. IPC server fires from the runner's POST /event.chat-end —
    //      ctx.reqId is a fresh per-request id (the IPC server stamps
    //      it), so the reqId lookup misses. We then fall back via the
    //      sessionId index. The fresh-spawn path always has exactly
    //      one waiter per sessionId; on the (rare) routed-collision
    //      case (two concurrent agent:invokes into the same alive
    //      sandbox), there can be multiple — we resolve the OLDEST
    //      reqId in insertion order (Set preserves it). That matches
    //      the runner's actual emit order: it processes inbox FIFO,
    //      so chat-end after the first user message corresponds to
    //      the first waiter.
    let deferred = waitersByReqId.get(ctx.reqId);
    if (deferred === undefined) {
      const reqIds = reqIdsBySession.get(ctx.sessionId);
      if (reqIds !== undefined && reqIds.size > 0) {
        const firstReqId = reqIds.values().next().value as string;
        deferred = waitersByReqId.get(firstReqId);
      }
    }
    if (deferred !== undefined && !deferred.settled) {
      deferred.resolve(payload.outcome);
    }
    // Cleanup: forget we cancelled this session, in case the same sessionId
    // gets reused by a later agent:invoke (shouldn't happen — ctx.sessionId is
    // fresh per request in practice — but the cleanup keeps the set from
    // growing unbounded in a long-lived host).
    cancelledSessions.delete(ctx.sessionId);
  }

  function onTurnEnd(ctx: AgentContext): void {
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

  return { runAgentInvoke, onChatEnd, onTurnEnd };
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
): ProxyConfig {
  if (rawEndpoint.startsWith('unix://')) {
    return {
      unixSocketPath: rawEndpoint.slice('unix://'.length),
      caCertPem,
      envMap,
    };
  }
  if (rawEndpoint.startsWith('tcp://')) {
    return {
      endpoint: 'http://' + rawEndpoint.slice('tcp://'.length),
      caCertPem,
      envMap,
    };
  }
  throw new PluginError({
    code: 'invalid-proxy-endpoint',
    plugin: PLUGIN_NAME,
    message: `unrecognized proxy endpoint scheme: ${rawEndpoint}`,
  });
}
