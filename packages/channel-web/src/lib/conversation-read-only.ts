/**
 * A conversation that takes no messages here (TASK-1093).
 *
 * Some conversations get their turns from somewhere else: a Slack DM thread
 * (the person talks to their agent in Slack), or a routine's runs. The web app
 * lists them, because they are the person's own, but a message sent from here
 * would fork the thread, so the send route turns it away with
 * `409 { error: 'conversation-read-only' }`.
 *
 * Two sentences, for two moments:
 *
 *   - `CONVERSATION_IN_SLACK` is what the page shows INSTEAD of a composer
 *     when it already knows the conversation is a Slack thread (the agent
 *     detail names its origin). It points the reader at the one place that
 *     works.
 *   - `CONVERSATION_READ_ONLY` is for a send the route refused anyway: a page
 *     that still offered a composer (a routine's conversation, or a host that
 *     names no origin). It used to arrive as a bare 404, which read "We could
 *     not find that. It may have been deleted." The conversation is right
 *     there, so that sentence was a lie.
 *
 * Neither names the product: a deployment is white-labeled through Branding.
 */
import { HttpError } from './http';

export const CONVERSATION_IN_SLACK = 'This conversation is in Slack. Reply there.';

export const CONVERSATION_READ_ONLY =
  'This conversation can’t take new messages here. To keep talking, start a new chat.';

/** The send route's code for it. One spelling, read in one place. */
const READ_ONLY_CODE = 'conversation-read-only';

export class ConversationReadOnlyError extends HttpError {
  /** The whole sentence to show. Ours: the refusal carries no words of its own. */
  readonly sentence: string;

  constructor(path: string) {
    super(path, 409, CONVERSATION_READ_ONLY);
    this.name = 'ConversationReadOnlyError';
    this.sentence = CONVERSATION_READ_ONLY;
  }
}

/**
 * `ConversationReadOnlyError` if this response is the read-only refusal (409,
 * `error === 'conversation-read-only'`), else `null`, and the caller throws its
 * usual `HttpError`. Never throws: a body we cannot read is simply not this
 * refusal. Reads the body only for a 409.
 */
export async function readConversationReadOnly(
  path: string,
  res: Response,
): Promise<ConversationReadOnlyError | null> {
  if (res.status !== 409) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  return (body as { error?: unknown }).error === READ_ONLY_CODE
    ? new ConversationReadOnlyError(path)
    : null;
}
