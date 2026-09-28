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
 * - **Field.** Only `content`, and only when it is a string. A message's
 *   `contentBlocks` is NEVER read, so `tool_result`, `attachment`, `tool_use`, `image` and
 *   `thinking` blocks cannot reach the extractor whatever a producer puts
 *   there. The runner happens to keep `chat:end`'s history text-only today
 *   (`@ax/agent-runner-core`'s `chatEndHistory` replaces blocks with a
 *   `[N blocks]` marker), but this filter does not rely on that and does not
 *   break if it changes. (The canonical transcript the incremental observer
 *   reads stores turns ONLY as blocks; {@link filterTranscriptTurns} applies
 *   the same rule there by reading `text` blocks alone.)
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
 * Strata observer had from Phase 1 until its deletion in TASK-608.
 */
export function hasUserContent(turns: readonly DialogueTurn[]): boolean {
  return turns.some((turn) => turn.role === 'user');
}

/**
 * One turn of the CANONICAL transcript (`conversations:get`) that survived
 * {@link filterTranscriptTurns}, with the ids the incremental observer needs.
 */
export interface IdentifiedTurn extends DialogueTurn {
  /**
   * The id `conversations:get` gave the turn — the same id the chat UI keys
   * the message on, which is why it is the one stored as a statement's
   * `sourceTurnId`. Opaque here: memory never parses it.
   */
  turnId: string;
  /** Position in the canonical transcript. The cursor is kept in these units. */
  turnIndex: number;
}

/**
 * The same hard filter as {@link filterDialogue}, over the canonical
 * transcript's turns instead of `chat:end`'s messages (TASK-625).
 *
 * The display transcript stores a turn as `contentBlocks`, not a `content`
 * string, so this is the one place `@ax/memory` reads blocks — and it reads
 * exactly one kind: `{ type: 'text', text: string }`. The rest of the rule is
 * unchanged and still structural:
 *
 * - **Role.** Only the literals `'user'` and `'assistant'`. A `tool` turn —
 *   which is where tool results live in this transcript — is dropped whole.
 * - **Block type.** Only `text`. `tool_use`, `tool_result`, `attachment`,
 *   `image` and `thinking` blocks never reach the extractor, whatever turn
 *   they sit in. A user turn's attachment is a download chip here, never its
 *   body.
 *
 * Every field is checked at runtime: the payload crossed a bus that erases
 * types. A turn without a usable string `turnId` or a non-negative integer
 * `turnIndex` is dropped, because a statement we cannot point back at a turn
 * and a cursor we cannot place are both worse than a skipped turn.
 */
export function filterTranscriptTurns(turns: readonly unknown[]): IdentifiedTurn[] {
  const out: IdentifiedTurn[] = [];
  for (const turn of turns) {
    if (turn === null || typeof turn !== 'object') continue;
    const { role, turnId, turnIndex, contentBlocks } = turn as Record<string, unknown>;
    if (role !== 'user' && role !== 'assistant') continue;
    if (typeof turnId !== 'string' || turnId === '') continue;
    if (typeof turnIndex !== 'number' || !Number.isInteger(turnIndex) || turnIndex < 0) continue;
    if (!Array.isArray(contentBlocks)) continue;
    const texts: string[] = [];
    for (const block of contentBlocks) {
      if (block === null || typeof block !== 'object') continue;
      const { type, text } = block as Record<string, unknown>;
      if (type !== 'text' || typeof text !== 'string') continue;
      if (text.trim() === '') continue;
      texts.push(text);
    }
    if (texts.length === 0) continue;
    out.push({ role, content: texts.join('\n'), turnId, turnIndex });
  }
  return out;
}
