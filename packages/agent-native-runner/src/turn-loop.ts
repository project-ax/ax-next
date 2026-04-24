import type { IpcClient, InboxLoop, LocalDispatcher } from '@ax/agent-runner-core';
import type {
  ChatMessage,
  LlmCallResponse,
  ToolCall,
  ToolDescriptor,
  ToolExecuteHostResponse,
  ToolPreCallResponse,
} from '@ax/ipc-protocol';

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
}

export type TurnLoopOutcome =
  | { kind: 'complete'; messages: ChatMessage[] }
  | { kind: 'terminated'; messages: ChatMessage[]; reason: string; error: unknown };

const DEFAULT_MAX_TURNS = 20;

export async function runTurnLoop(deps: TurnLoopDeps): Promise<TurnLoopOutcome> {
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
  const history: ChatMessage[] = [];

  try {
    for (;;) {
      const entry = await deps.inbox.next();
      if (entry.type === 'cancel') {
        return { kind: 'complete', messages: history };
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
    return { kind: 'terminated', messages: history, reason, error: err };
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
    // Surface tool failure back to the model as a user-role message.
    // This matches Week 4-6 chat-loop behavior: the model sees the error
    // and gets a chance to retry or recover. Note: we DO NOT re-throw
    // to the outer loop, because a single-tool failure is not a session
    // terminator.
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
