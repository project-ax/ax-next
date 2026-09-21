/**
 * The observer's input filter — design §3.0 and §6.3 flow 1.
 *
 * **The observer sees user and assistant turns ONLY, and only their string
 * `content`. Never tool results. Never attachment bodies.**
 *
 * Web pages, files and MCP output are the highest-volume prompt-injection
 * channel into memory, and memory is a PERSISTENCE vector: a sentence stored
 * once is text in every future prompt. The assistant's restatement of a tool
 * result is one hop removed and in the model's voice, which is where the
 * design draws the line.
 *
 * ## This is a hard filter, not a heuristic
 *
 * Both exclusions are structural, and neither depends on anything upstream
 * behaving:
 *
 * - **Role.** Only the exact literals `'user'` and `'assistant'` survive.
 *   `AgentMessage.role` is TYPED as that union, but `chat:end`'s payload
 *   arrives over IPC through a bus that erases types, so the check is a
 *   runtime one. A `tool` role — or any role a future producer invents —
 *   is dropped rather than relabelled.
 * - **Field.** Only `content`, and only when it is a string. `contentBlocks`
 *   is NEVER read, so `tool_result`, `attachment`, `tool_use`, `image` and
 *   `thinking` blocks cannot reach the extractor whatever a producer puts
 *   there. The runner happens to keep `chat:end`'s history text-only today
 *   (`@ax/agent-runner-core`'s `chatEndHistory` replaces blocks with a
 *   `[N blocks]` marker), but this filter does not rely on that and does not
 *   break if it changes.
 *
 * ## What this filter deliberately does NOT catch
 *
 * Content a person PASTED into a user turn is indistinguishable from content
 * they typed — it is a string in `content` either way, and no filter here can
 * tell them apart. Design §6.3 settles that residual at the SINK rather than
 * the source: statements are rendered as data (pipe/newline escaped), carry
 * no capability, and an `extracted` row can never overwrite a `human` one.
 */

/**
 * The shape this filter reads. Structurally compatible with `@ax/core`'s
 * `AgentMessage`, declared with every field `unknown` because that is what
 * actually crosses the bus — the point of the filter is that it trusts none
 * of them.
 */
export interface UntrustedMessage {
  role?: unknown;
  content?: unknown;
  /**
   * Named ONLY so it is visibly never read. Deleting the field from this
   * interface would make the omission look accidental to the next reader;
   * naming it makes "we do not read this" the documented behaviour that the
   * tool-result/attachment test pins.
   */
  contentBlocks?: unknown;
}

/** One turn that survived the filter. */
export interface DialogueTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Apply the filter. Order is preserved; nothing is merged, relabelled or
 * summarized.
 */
export function filterDialogue(messages: readonly UntrustedMessage[]): DialogueTurn[] {
  const turns: DialogueTurn[] = [];
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = message.content;
    if (typeof content !== 'string') continue;
    // An empty or whitespace-only turn carries nothing to extract and would
    // render as a bare `user:` line the model has to guess at.
    if (content.trim() === '') continue;
    turns.push({ role, content });
  }
  return turns;
}

/**
 * Render the filtered turns as the dialogue the prompt is measured against —
 * dem-memory's `flattenDialogue` shape (`<role>: <content>`, newline-joined),
 * reproduced so the transcript the extractor sees here is the transcript the
 * benchmark saw.
 */
export function renderDialogue(turns: readonly DialogueTurn[]): string {
  return turns.map((turn) => `${turn.role}: ${turn.content}`).join('\n');
}

/**
 * True when the filtered transcript is worth an extraction call at all.
 *
 * A transcript with no USER turn is either a synthetic/system exchange or one
 * whose user side was filtered away; extracting from the assistant alone
 * records the model talking to itself. Mirrors the `no-user-content` skip the
 * Strata observer has had since Phase 1.
 */
export function hasUserContent(turns: readonly DialogueTurn[]): boolean {
  return turns.some((turn) => turn.role === 'user');
}
