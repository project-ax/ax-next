/**
 * The one refusal a person meets from a route about storage (TASK-690):
 * `413 { error: 'storage-full', message }`, answered when a write would put
 * them over their limit. First the SEND route (committing an attachment), then,
 * in TASK-719, the two saves that go through `workspace:apply`: the Rules
 * editor and the agent form's identity fields.
 *
 * `workspaceApi.sendMessage` used to turn every non-ok status into a bare
 * `HttpError`, which is all a status can say: a 413 read as "we could not reach
 * the server", and `AgentView` dressed it as "That reply didn't finish". This
 * reads the body for exactly this one code, and hands the surfaces an error
 * that carries the kind sentence. Every other refusal (including the other
 * 413, `attachment-total-too-large`) stays a plain `HttpError`: it is not this
 * card's to reword.
 *
 * The sentence is the server's when it sent one worth showing (the server knows
 * things we do not), else ours (`STORAGE_FULL_SEND`). It is authored copy from
 * our own host, bounded here, and only ever rendered as a text node.
 */
import { HttpError } from './http';
import { STORAGE_FULL_SEND } from './storage-copy';

/** A final client-side clamp on the server's sentence. */
export const MAX_SERVER_SENTENCE_CHARS = 400;

export class StorageFullError extends HttpError {
  /** The whole kind sentence to show, server-worded when it sent one. */
  readonly sentence: string;

  constructor(path: string, sentence: string) {
    super(path, 413, sentence);
    this.name = 'StorageFullError';
    this.sentence = sentence;
  }
}

/**
 * `StorageFullError` if this response is the storage-full refusal, else `null`
 * (the caller throws its usual `HttpError`). Never throws: a body we cannot
 * read is simply not this refusal.
 *
 * `fallback` is the sentence to wear when the server sent none. It defaults to
 * the one about a MESSAGE that did not send, which is only true on the send
 * path; every other surface names its own (`STORAGE_FULL_RULES`,
 * `STORAGE_FULL_IDENTITY`), because "we couldn't send that message" under a
 * Save button would be a lie of its own. Reads the body, so a caller that still
 * wants it afterwards passes `res.clone()`.
 */
export async function readStorageFull(
  path: string,
  res: Response,
  fallback: string = STORAGE_FULL_SEND,
): Promise<StorageFullError | null> {
  if (res.status !== 413) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  return storageFullFromBody(path, res.status, body, fallback);
}

/**
 * The same recognition as `readStorageFull`, for a caller that has ALREADY read
 * the body and cannot read it twice (`lib/routines.ts` reads its error body once
 * and decides what it says from that: the refusal, a string reason, or an object
 * message). One rule for what "the storage refusal" looks like, so a second
 * reader cannot grow its own idea of it: 413, and `error === 'storage-full'`.
 */
export function storageFullFromBody(
  path: string,
  status: number,
  body: unknown,
  fallback: string = STORAGE_FULL_SEND,
): StorageFullError | null {
  if (status !== 413) return null;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { error, message } = body as { error?: unknown; message?: unknown };
  if (error !== 'storage-full') return null;
  const fromServer =
    typeof message === 'string' && message.trim().length > 0
      ? message.trim().slice(0, MAX_SERVER_SENTENCE_CHARS)
      : null;
  return new StorageFullError(path, fromServer ?? fallback);
}
