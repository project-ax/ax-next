// ---------------------------------------------------------------------------
// Which of this turn's tool calls FAILED without throwing.
//
// The problem this exists to solve (TASK-430): `ai@7` only marks a tool result
// as an error when the executor THREW. It has no channel for "the tool ran, and
// what it did was a failure" — a returned string becomes `{type:'text'}` in the
// response messages, `isErrorOutput` in turn-blocks.ts reads false, and the
// host persists a `tool_result` with no `is_error` at all. A `Bash` call that
// exited 127 is then indistinguishable, in the transcript, from one that
// succeeded. The person reading the thread and the model reading it back as
// context both conclude the work was done.
//
// Why not just throw: because the model needs the output. A failed build's
// compiler diagnostics ARE the result; `ai@7` replaces a thrown executor's
// return value with an opaque `error-text` carrying only the message. That
// trade is deliberate and documented in builtins.ts's `formatBashOutcome`, and
// it is not the part that was wrong.
//
// Why not reconstruct it from the output text: because the output is model- and
// command-authored, and the repo forbids keying a transcript fact off untrusted
// tool text (the same rule that governs `held`). A command that PRINTS
// "exit code: 1" must not be marked failed, and a command that fails silently
// must not be marked clean.
//
// So the fact travels the way `held` does: structurally, keyed by tool-call id,
// PER TURN, written only by the runner from its own observation (a process exit
// status) and cleared at the turn boundary. Nothing model-authored can enter
// this set. A record that survived into the next turn would quietly mark some
// later call's real output as failed, and nothing would throw — hence
// `clear()`, called next to `heldCalls.clear()`.
//
// It is deliberately a SEPARATE set from the hold registry rather than a shared
// one with a flag: a hold is not a failure (TASK-270), and the two facts get
// opposite treatments downstream. Conflating them would paint a call that is
// merely waiting on a person as broken.
//
// Local to this runner on purpose. The claude-sdk runner has no use for it —
// the CLI hands it an `is_error` boolean it forwards verbatim. If that ever
// changes, this moves to @ax/agent-runner-core the way `held-calls.ts` did.
// ---------------------------------------------------------------------------

export interface FailedCallRegistry {
  record(toolCallId: string): void;
  has(toolCallId: string): boolean;
  clear(): void;
}

export function createFailedCallRegistry(): FailedCallRegistry {
  const ids = new Set<string>();
  return {
    record(toolCallId: string): void {
      ids.add(toolCallId);
    },
    has(toolCallId: string): boolean {
      return ids.has(toolCallId);
    },
    clear(): void {
      ids.clear();
    },
  };
}
