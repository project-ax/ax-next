import type {
  DiffAccumulator,
  IpcClient,
  InboxLoop,
  LocalDispatcher,
} from '@ax/agent-runner-core';
import { SessionInvalidError, toWireChanges } from '@ax/agent-runner-core';
import type {
  ChatMessage,
  LlmCallResponse,
  ToolCall,
  ToolDescriptor,
  ToolExecuteHostResponse,
  ToolPreCallResponse,
  WorkspaceCommitNotifyResponse,
} from '@ax/ipc-protocol';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Sandbox-side turn loop.
//
// This is a faithful port of @ax/core/src/chat-loop.ts into the sandbox
// process. The differences:
//
//   - LLM is reached via `client.call('llm.call', ...)` instead of the
//     host-side HookBus. Credentials live with the host; the runner never
//     sees ANTHROPIC_API_KEY et al (invariant I5).
//
//   - `tool:pre-call` + `tool:post-call` become `tool.pre-call` (sync IPC)
//     and `event.tool-post-call` (fire-and-forget). Post-call cannot veto
//     the output because events are, by design, one-way.
//
//   - Tool execution routes through the LocalDispatcher when a sandbox-side
//     impl is registered (`bash`, `read_file`, `write_file`). Otherwise we
//     punt to the host via `tool.execute-host`. Descriptor-declared
//     `executesIn` is advisory; the runtime signal is "does the local
//     dispatcher know about this name".
//
//   - Tool-result message format is verbatim:
//       `[tool <name>] <JSON.stringify(output)>`
//     This format is the wire contract the acceptance test (Task 15)
//     asserts against. Do NOT change it without coordinating.
//
// The loop processes MULTIPLE user messages across its lifetime — it
// returns only when the inbox yields `cancel`, or when a terminal error
// (SessionInvalidError, exhausted retries) propagates out of the client.
// Process-kill from the host (SIGTERM) interrupts whichever IPC call
// is in flight; the caller in main.ts catches whatever propagates.
// ---------------------------------------------------------------------------

export interface TurnLoopDeps {
  client: IpcClient;
  inbox: InboxLoop;
  dispatcher: LocalDispatcher;
  /**
   * Tool catalog fetched once at runner startup via `tool.list`. We pass
   * the full list to every `llm.call` so the model sees the same tools
   * across every turn. Session-lifetime-immutable by design.
   */
  tools: ToolDescriptor[];
  /**
   * Cap on LLM-call iterations within a SINGLE user message. Matches the
   * Week 4–6 chat-loop default of 20. A misbehaving model that keeps
   * emitting tool calls would otherwise spin a single user message forever.
   * Hitting the cap breaks the inner loop but does NOT terminate the
   * outer loop — the runner goes back to `inbox.next()` for more input.
   */
  maxTurns?: number;
  /**
   * Per-turn diff accumulator. The dispatcher writes into this whenever a
   * file-mutating tool succeeds; we drain it at turn boundary and ship one
   * `workspace.commit-notify` request per turn (Task 7c).
   *
   * Optional so existing tests that don't care about workspace commits
   * keep compiling; runner main.ts always supplies one.
   */
  diffs?: DiffAccumulator;
  /**
   * Frozen agent system prompt fetched from `session.get-config` (Week
   * 9.5). When non-empty, prepended to the chat history as a single
   * role:'system' message — llm-anthropic extracts those into the
   * Anthropic API's top-level `system` field, so this propagates as a
   * real system instruction rather than a downgraded user turn.
   *
   * Optional so existing tests that don't care about agent config keep
   * compiling.
   */
  systemPrompt?: string;
  /** Test seam for commitRef generation. */
  commitRefGen?: () => string;
}

export type TurnLoopOutcome =
  | { kind: 'complete'; messages: ChatMessage[] }
  | { kind: 'terminated'; messages: ChatMessage[]; reason: string; error: unknown };

const DEFAULT_MAX_TURNS = 20;

export async function runTurnLoop(deps: TurnLoopDeps): Promise<TurnLoopOutcome> {
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
  const commitRefGen = deps.commitRefGen ?? (() => randomUUID());
  const history: ChatMessage[] = [];
  // Seed the system prompt as a role:'system' message at the top of
  // history. llm-anthropic's plugin extracts these into the API's
  // top-level `system` field; mapping role:'system' to user would
  // silently downgrade the instruction (see llm-anthropic plugin.ts).
  if (deps.systemPrompt !== undefined && deps.systemPrompt.length > 0) {
    history.push({ role: 'system', content: deps.systemPrompt });
  }
  // Track parent version across turns so the host's optimistic-concurrency
  // check sees a coherent lineage. `null` until the first accepted commit.
  let parentVersion: string | null = null;

  // user-facing messages are everything except the seeded system prompt.
  // Functions consuming the outcome want a transcript, not the prompt the
  // host wrote at the top of history.
  const userFacingHistory = (): ChatMessage[] =>
    history.filter((m) => m.role !== 'system');

  try {
    for (;;) {
      const entry = await deps.inbox.next();
      if (entry.type === 'cancel') {
        return { kind: 'complete', messages: userFacingHistory() };
      }
      // The server's wire schema guarantees `payload` is present on
      // 'user-message' entries, but the InboxLoopEntry type marks it
      // optional to accommodate 'cancel'. Guard defensively.
      if (entry.payload === undefined) {
        // Treat a malformed user-message as a no-op — don't crash.
        continue;
      }
      history.push({ role: 'user', content: entry.payload.content });

      await runOneUserMessage(history, deps, maxTurns);

      // Aggregate the per-turn diff and ship a single commit-notify when
      // there are changes. We deliberately skip empty turns: a host that
      // has no workspace plugin registered would log an internal error on
      // every empty notify, which is noise. Empty diffs carry no signal
      // beyond a "turn ended" heartbeat — and `event.turn-end` already
      // covers that. Failures here MUST NOT terminate the runner; the
      // next turn retries against whatever version we last knew.
      //
      // Snapshot-then-drain-on-success: we don't drain BEFORE the IPC
      // settles. On a thrown error (network / timeout) the accumulator
      // stays intact and the next turn retries with the same changes
      // plus whatever new ones land — no silent data loss on transient
      // failures. On `accepted: false` (host-side veto: parent-mismatch
      // or pre-apply rejection) we drain — re-sending the same diff
      // against the same stale parent will fail again forever, and the
      // proper "refresh parent on mismatch" recovery flow needs a wire
      // change that's out of scope here. Documented gap.
      if (deps.diffs !== undefined && !deps.diffs.isEmpty()) {
        const snapshot = deps.diffs.snapshot();
        try {
          const resp = (await deps.client.call('workspace.commit-notify', {
            parentVersion,
            commitRef: commitRefGen(),
            message: 'turn',
            changes: toWireChanges(snapshot),
          })) as WorkspaceCommitNotifyResponse;
          if (resp.accepted) {
            // Host received it; safe to drain.
            deps.diffs.drain();
            parentVersion = resp.version as unknown as string;
          } else {
            // Host actively rejected. Drain to avoid unbounded growth on
            // permanent rejection — re-sending wouldn't help today.
            deps.diffs.drain();
          }
        } catch {
          // Connection-level failure or timeout. PRESERVE the diff so
          // the next turn retries. The accumulator is unchanged.
        }
      }

      // Fire-and-forget: the host uses this to know the runner is idle.
      // We explicitly do NOT await — a failed event must not stall the
      // runner. The client already has a short timeout + error logging.
      void deps.client
        .event('event.turn-end', { reason: 'user-message-wait' })
        .catch(() => {
          /* logged inside client; swallow so the loop keeps going */
        });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.name : 'unknown';
    return { kind: 'terminated', messages: userFacingHistory(), reason, error: err };
  }
}

/**
 * Inner loop: repeated llm.call + tool-dispatch for a single user message,
 * bounded by `maxTurns`. Mutates `history` in place. Throws on terminal
 * errors (e.g. SessionInvalidError) so the outer loop catches them.
 */
async function runOneUserMessage(
  history: ChatMessage[],
  deps: TurnLoopDeps,
  maxTurns: number,
): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn++) {
    const llmResp = (await deps.client.call('llm.call', {
      messages: [...history],
      tools: deps.tools,
    })) as LlmCallResponse;

    history.push(llmResp.assistantMessage);
    if (llmResp.toolCalls.length === 0) return;

    for (const toolCall of llmResp.toolCalls) {
      await runOneToolCall(history, deps, toolCall);
    }
  }
  // Reached maxTurns without the model clearing toolCalls. Break out of
  // the inner loop (return) so the outer loop goes back to inbox.next().
  // We intentionally don't push a synthetic 'max-turns-exceeded' message
  // — the model has already generated 20 assistant turns' worth of
  // content, which is plenty of context for it to reason about on the
  // next user message.
}

async function runOneToolCall(
  history: ChatMessage[],
  deps: TurnLoopDeps,
  toolCall: ToolCall,
): Promise<void> {
  const pre = (await deps.client.call('tool.pre-call', {
    call: toolCall,
  })) as ToolPreCallResponse;

  if (pre.verdict === 'reject') {
    history.push({
      role: 'user',
      content: `tool '${toolCall.name}' rejected: ${pre.reason}`,
    });
    return;
  }

  // `pre.modifiedCall` is the host's opportunity to rewrite a tool call
  // before execution (e.g. clamp a dangerous flag). When present, we
  // execute the MODIFIED call and emit post-events about it.
  const effective = pre.modifiedCall ?? toolCall;

  let output: unknown;
  try {
    if (deps.dispatcher.has(effective.name)) {
      output = await deps.dispatcher.execute(effective);
    } else {
      const resp = (await deps.client.call('tool.execute-host', {
        call: effective,
      })) as ToolExecuteHostResponse;
      output = resp.output;
    }
  } catch (err) {
    // Terminal session errors (401 from the IPC server → the host revoked
    // the token, session is gone) must unwind to the outer loop so the
    // runner's termination `reason` reflects the first terminal signal,
    // NOT whatever spurious "tool failed" narrative the model would see
    // next. Re-throw to the outer catch in runTurnLoop.
    if (err instanceof SessionInvalidError) throw err;
    // Non-terminal failures (local executor threw, host returned a 5xx
    // after exhausting retries, etc.) flow through to the model as a
    // tool-error message — matches Week 4-6 chat-loop behavior so the
    // model can retry or narrate the failure. A single-tool failure is
    // not a session terminator.
    history.push({
      role: 'user',
      content: `[tool ${effective.name}] error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  // Fire-and-forget observation. A failed event-delivery must not prevent
  // the model from seeing the tool output — the runner's job is to keep
  // the loop going, not to gate on side-channel telemetry.
  void deps.client
    .event('event.tool-post-call', { call: effective, output })
    .catch(() => {
      /* logged inside client */
    });

  history.push({
    role: 'user',
    content: `[tool ${effective.name}] ${JSON.stringify(output)}`,
  });
}
