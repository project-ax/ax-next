/**
 * The one refusal a person meets from the SEND route about storage (TASK-690):
 * `413 { error: 'storage-full', message }`, answered when committing an
 * attachment would put them over their limit.
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
 */
export async function readStorageFull(
  path: string,
  res: Response,
): Promise<StorageFullError | null> {
  if (res.status !== 413) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { error, message } = body as { error?: unknown; message?: unknown };
  if (error !== 'storage-full') return null;
  const fromServer =
    typeof message === 'string' && message.trim().length > 0
      ? message.trim().slice(0, MAX_SERVER_SENTENCE_CHARS)
      : null;
  return new StorageFullError(path, fromServer ?? STORAGE_FULL_SEND);
}
