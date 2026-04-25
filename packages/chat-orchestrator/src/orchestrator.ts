import type {
  ChatContext,
  ChatMessage,
  ChatOutcome,
  HookBus,
} from '@ax/core';

// ---------------------------------------------------------------------------
// @ax/chat-orchestrator — per-chat control plane
//
// Registers the host-side `chat:run` service hook. One chat:run call =
//
//   1. fire chat:start (veto-capable)
//   2. sandbox:open-session — bind IPC listener, spawn runner subprocess.
//        The sandbox plugin internally calls `session:create` to mint the
//        session + bearer token (the token flows only into the runner's
//        env, never back to us — I9). We do NOT call session:create here;
//        `session:create` is not idempotent on sessionId and a double-create
//        would throw `duplicate-session`. The orchestrator's contract with
//        the sandbox plugin is: "you own session minting, I own the chat
//        lifecycle above it."
//   3. session:queue-work — enqueue the initial user message
//   4. await chat:end event (runner-driven, via IPC server)
//   5. cleanup — kill handle if still alive
//
// The IPC server (Task 4) fires `chat:end` when the runner POSTs
// /event.chat-end. The orchestrator's own subscriber captures the outcome
// and resolves the awaiting deferred. Error-ish paths (chat:start rejection,
// sandbox-open failure, queue-work failure, chat timeout, sandbox early
// exit) synthesize a terminated outcome and fire chat:end themselves —
// audit-log style subscribers always see exactly one chat:end per chat:run.
// Happy-path chat:end is fired by the IPC server, NOT the orchestrator;
// double-firing would double-count in audit-log.
//
// Invariants:
//   I1 — Hook payloads are backend-agnostic. Input is `{ message, maxTurns? }`,
//        output is ChatOutcome — no transport / storage vocabulary (no
//        runnerEndpoint, sessionId leakage, etc.). sessionId exists on
//        ChatContext already, which is the kernel-level primitive.
//   I5 — Capabilities explicit. The orchestrator only calls the exact hooks
//        in its manifest (session:queue-work / session:terminate /
//        sandbox:open-session / ipc:stop). It does NOT spawn, it does NOT
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

export interface ChatRunInput {
  message: ChatMessage;
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
  entry: { type: 'user-message'; payload: ChatMessage };
}
interface SessionQueueWorkOutput {
  cursor: number;
}
interface SessionTerminateInput {
  sessionId: string;
}
interface OpenSessionInput {
  sessionId: string;
  workspaceRoot: string;
  runnerBinary: string;
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
  runChat(ctx: ChatContext, input: ChatRunInput): Promise<ChatOutcome>;
  onChatEnd(ctx: ChatContext, payload: { outcome: ChatOutcome }): void;
  onTurnEnd(ctx: ChatContext): void;
} {
  const waitersBySessionId = new Map<string, Deferred<ChatOutcome>>();
  const chatTimeoutMs = config.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  const oneShot = config.oneShot ?? true;
  // Sessions that have already been cancelled — prevents a second
  // chat:turn-end (from a misbehaving runner) from queueing a duplicate
  // cancel entry.
  const cancelledSessions = new Set<string>();

  async function runChat(
    ctx: ChatContext,
    input: ChatRunInput,
  ): Promise<ChatOutcome> {
    // 1. chat:start — subscribers can veto.
    const startResult = await bus.fire('chat:start', ctx, {
      message: input.message,
    });
    if (startResult.rejected) {
      const outcome: ChatOutcome = {
        kind: 'terminated',
        reason: `chat:start:${startResult.reason}`,
      };
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
    }

    // 2. Register the waiter BEFORE opening the sandbox — the runner may
    //    emit chat:end before open-session resolves in pathological cases
    //    (extremely fast runner, racey test harness). Map it now so the
    //    subscriber can't miss the fire. The sessionId is `ctx.sessionId`
    //    — the kernel-level id that the sandbox plugin will forward into
    //    the runner's AX_SESSION_ID env; the runner then echoes it back
    //    in every IPC request via the token it holds, and the IPC server
    //    builds ctx.sessionId from that token lookup. Stable join key.
    const sessionId = ctx.sessionId;
    const deferred = newDeferred<ChatOutcome>();
    waitersBySessionId.set(sessionId, deferred);

    // 3. Open the sandbox. sandbox:open-session internally calls
    //    session:create (minting the session + token), starts the IPC
    //    listener, and spawns the runner subprocess. The token never
    //    returns here — it flows only into the child env (I9).
    let handle: OpenSessionHandle;
    try {
      const opened = await bus.call<OpenSessionInput, OpenSessionResult>(
        'sandbox:open-session',
        ctx,
        {
          sessionId,
          workspaceRoot: ctx.workspace.rootPath,
          runnerBinary: config.runnerBinary,
        },
      );
      handle = opened.handle;
    } catch (err) {
      waitersBySessionId.delete(sessionId);
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
      const outcome: ChatOutcome = {
        kind: 'terminated',
        reason: 'sandbox-open-failed',
        error: err,
      };
      await bus.fire('chat:end', ctx, { outcome });
      return outcome;
    }

    // 4. Enqueue the initial user message. If this fails, the sandbox is
    //    running but has nothing to work on — kill it and synthesize
    //    chat:end. session:terminate is fired by sandbox-subprocess's
    //    child-close handler, so we don't double-fire it here.
    try {
      await bus.call<SessionQueueWorkInput, SessionQueueWorkOutput>(
        'session:queue-work',
        ctx,
        {
          sessionId,
          entry: { type: 'user-message', payload: input.message },
        },
      );
    } catch (err) {
      waitersBySessionId.delete(sessionId);
      try {
        await handle.kill();
      } catch {
        // best-effort — exited promise is what drives cleanup anyway.
      }
      const outcome: ChatOutcome = {
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
    // code path (which expects ChatOutcome, not an error) stays uniform.
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

    let outcome: ChatOutcome;
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
      waitersBySessionId.delete(sessionId);
    }

    // 6. If the chat:end subscriber path didn't win, the runner never
    //    emitted event.chat-end and the IPC server never fired chat:end.
    //    Fire it ourselves so audit-log etc. always see exactly one
    //    chat:end per chat:run.
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
  }

  function onChatEnd(ctx: ChatContext, payload: { outcome: ChatOutcome }): void {
    const deferred = waitersBySessionId.get(ctx.sessionId);
    if (deferred !== undefined && !deferred.settled) {
      deferred.resolve(payload.outcome);
    }
    // Cleanup: forget we cancelled this session, in case the same sessionId
    // gets reused by a later chat:run (shouldn't happen — ctx.sessionId is
    // fresh per request in practice — but the cleanup keeps the set from
    // growing unbounded in a long-lived host).
    cancelledSessions.delete(ctx.sessionId);
  }

  function onTurnEnd(ctx: ChatContext): void {
    // One-shot mode: the runner just finished processing the single user
    // message and is now waiting on inbox.next() for another. We don't have
    // one, so queue a cancel — the runner's inbox loop will receive it,
    // break out of its outer loop, emit event.chat-end, and exit cleanly.
    //
    // Guards:
    //   - oneShot must be true (multi-message hosts opt out).
    //   - sessionId must be an in-flight chat:run (skip unrelated turn-ends).
    //   - don't double-queue (a runner that fires turn-end twice must not
    //     queue two cancels).
    if (!oneShot) return;
    if (!waitersBySessionId.has(ctx.sessionId)) return;
    if (cancelledSessions.has(ctx.sessionId)) return;
    cancelledSessions.add(ctx.sessionId);
    // Fire-and-forget. If this fails (e.g. session already terminated), the
    // sandbox-exit path will resolve the deferred as terminated and the chat
    // still completes cleanly — logging is enough.
    void bus
      .call<SessionQueueWorkInput, SessionQueueWorkOutput>(
        'session:queue-work',
        ctx,
        { sessionId: ctx.sessionId, entry: { type: 'cancel' as const } } as unknown as SessionQueueWorkInput,
      )
      .catch((err) => {
        ctx.logger.warn('one_shot_cancel_queue_failed', {
          sessionId: ctx.sessionId,
          err,
        });
      });
  }

  return { runChat, onChatEnd, onTurnEnd };
}

// A distinct error type so the runChat finally block can tell "we timed out"
// apart from "something else went wrong awaiting the deferred."
class ChatTimeoutError extends Error {
  constructor(ms: number) {
    super(`chat:run timed out after ${ms}ms`);
    this.name = 'ChatTimeoutError';
  }
}
