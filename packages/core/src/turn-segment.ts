// ---------------------------------------------------------------------------
// Held turn ends (dev services on demand, spec §3.2, ruling R27).
//
// A runner segment can end without the turn ending: the agent called
// `restart_with_services`, so its sandbox is swapped and the same request
// carries on in a new one. Every caller (the web stream, Slack, routines,
// conversations, agent activity) treats the first `chat:turn-end` naming its
// reqId as the end of the turn, so that segment's turn-ends must not be
// broadcast as `chat:turn-end`.
//
// The emitter of `chat:turn-end` (@ax/ipc-core, the runner's `event.turn-end`)
// asks first:
//
//   CHAT_TURN_END_HOLD_HOOK  fired with { sessionId, reqId, held: false }.
//     A subscriber that owns a hold on exactly that session and request
//     returns the payload with `held: true`. Today only @ax/chat-orchestrator
//     answers, and only for the segment a pending restart is ending. The
//     sessionId is host-stamped (the runner's token), and a hold is only ever
//     created host-side, so a runner can't claim one.
//
//   CHAT_TURN_SEGMENT_END_HOOK  fired INSTEAD of `chat:turn-end` when held,
//     with the turn-end payload unchanged. Consumed by the hold's owner (to
//     settle that segment and swap the sandbox). Callers don't subscribe.
//
// No subscriber, or none that answers held: `chat:turn-end` fires exactly as
// before. A throwing or slow subscriber is skipped by the bus, which also
// reads as "not held": the safe direction is the ordinary broadcast.
//
// Why a subscriber question and not a service hook: the emitter lives in the
// IPC transports, and a service edge from them to the orchestrator closes a
// plugin call cycle in the local preset (ipc-server → chat-orchestrator →
// sandbox-subprocess → ipc-server, rejected by bootstrap's acyclic check).
// Subscriber hooks are not dependency edges.
//
// Lives in the kernel because the emitter and the subscriber must share one
// spelling and plugins may not import each other (invariant 2).
// ---------------------------------------------------------------------------

/** Fired (bus.fire) before a `chat:turn-end` broadcast: is this turn-end a held segment's? */
export const CHAT_TURN_END_HOLD_HOOK = 'chat:turn-end-hold';

/** Fired (bus.fire) in place of `chat:turn-end` for a held segment. Payload: the turn-end's own. */
export const CHAT_TURN_SEGMENT_END_HOOK = 'chat:turn-segment-end';

export interface ChatTurnEndHoldPayload {
  /** The session the turn-end came from (host-stamped, never runner-written). */
  sessionId: string;
  /** The request the turn-end names (runner-echoed; only matched, never trusted). */
  reqId: string;
  /** False when fired; a subscriber holding this segment returns it true. */
  held: boolean;
}
