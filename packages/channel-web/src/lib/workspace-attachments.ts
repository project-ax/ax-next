/**
 * workspace-attachments — the agent-workspace composer's attachment state.
 *
 * WHY THIS EXISTS. The agent-workspace surface (`components/workspace/`)
 * deliberately does not mount assistant-ui's `AssistantRuntimeProvider`, so
 * chat's `AttachmentAdapter` / `useAttachment` / `ComposerPrimitive.Attachments`
 * machinery is simply unreachable there. Without this hook a person looking at
 * a workspace composer has no way to hand their agent a file at all. This is
 * the plain-React equivalent of the same idea, sitting on the SAME uploader
 * (`./attachment-upload`) so the two surfaces cannot drift apart on wire shape
 * or error taxonomy.
 *
 * WHY SENDING IS EVER BLOCKED. `sendBlock` exists because the alternative —
 * sending the text anyway — silently drops the file the person meant to send,
 * and they have no way to find out. They wrote "have a look at this", the
 * agent got "have a look at this" and nothing else, and the agent's confused
 * reply is the only signal anything went wrong. Holding the send for a second,
 * with a sentence saying why, is the kinder failure.
 *
 * WHY THE FAILURE COPY IS A FIXED LOOKUP. `/api/attachments` answers a
 * rejected upload with a JSON `{error}` string, and `uploadAttachment` puts
 * that string on `AttachmentUploadError.message`. It is a server-authored
 * value on a path that also carries the person's own filename, and it has no
 * business being rendered. `attachmentFailureSentence` maps the error's KIND
 * and STATUS — never its message — onto copy we wrote. Anything we do not
 * recognise falls back to the shared `HTTP_FAILED` sentence rather than
 * guessing.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { AttachmentUploadError, uploadAttachment } from './attachment-upload';
import { HTTP_FAILED, httpErrorMessage } from './http';

export type WorkspaceAttachmentStatus = 'uploading' | 'uploaded' | 'failed';

export interface WorkspaceAttachment {
  /** Client-minted, STABLE across a retry (so the chip does not jump). */
  id: string;
  /** file.name — untrusted user input. Rendered as React text only, never as a path or URL. */
  name: string;
  contentType: string;
  status: WorkspaceAttachmentStatus;
  /** 0..1, meaningful only while 'uploading'. */
  progress: number;
  /** Server-minted id from POST /api/attachments. Non-null iff status === 'uploaded'. */
  attachmentId: string | null;
  /** OUR sentence, non-null iff status === 'failed'. Never a server-supplied string. */
  message: string | null;
}

/*
 * The two reasons a send is held. Exported as constants so the composer's own
 * tests can match them without re-typing the prose — a second copy of a
 * sentence is how the two versions quietly stop agreeing.
 */
export const ATTACHMENT_SEND_BLOCKED_FAILED =
  'One of these files did not upload. Retry it or remove it before sending — otherwise we would send your message without the file.';
export const ATTACHMENT_SEND_BLOCKED_UPLOADING =
  'Still uploading. Give it a second so your file goes with the message.';
/**
 * Why a file with no message is HELD rather than sent.
 *
 * Both composers already refuse an empty draft, and did long before a file
 * could be attached to one. Hang a paperclip off that composer and the quiet
 * refusal turns into a trap: the person picks a file, watches its chip settle
 * on "Ready to send", presses a Send that does nothing at all, and is told
 * nothing. That is the same silent failure this card is about, one step
 * earlier.
 */
export const ATTACHMENT_NEEDS_MESSAGE = 'Add a message to go with your file.';

/**
 * The ONE reason a workspace composer is holding a send, or null.
 *
 * Both composers ask this question and they must answer it identically — the
 * home composer and the thread composer are the same product, and a rule that
 * lives twice is a rule that will eventually disagree with itself. The hook's
 * own `sendBlock` covers what it can see (a failed upload, one still in
 * flight); only the composer knows whether anything was typed, so that half
 * arrives as an argument.
 *
 * `sendBlock` wins because it is the more consequential of the two: a file
 * that failed, or is still on its way up, is the one whose id would drop out
 * of `sendable` and take the person's file out of the message without
 * saying so. A missing message is the milder problem — the file is fine.
 */
export function composerSendBlock(
  sendBlock: string | null,
  hasText: boolean,
  attachmentCount: number,
): string | null {
  if (sendBlock !== null) return sendBlock;
  if (!hasText && attachmentCount > 0) return ATTACHMENT_NEEDS_MESSAGE;
  return null;
}

/*
 * Every sentence a failed upload is allowed to become. Three of these are
 * specific enough to be worth their own copy (the person can act on "wrong
 * kind", "too big" and "too many at once"); everything else reuses the
 * sentences `./http` already owns, because a second set of 401/403/5xx copy
 * is a second thing to keep honest.
 */
export const ATTACHMENT_FAILED_UNSUPPORTED =
  "We can't send that kind of file. Try a PDF, an image, a text or CSV file, or a zip.";
export const ATTACHMENT_FAILED_TOO_BIG =
  'That file is too big to send. The limit is 25 MB.';
export const ATTACHMENT_FAILED_TOO_MANY =
  'There are too many uploads waiting. Send or remove one of these first, then try again.';
export const ATTACHMENT_FAILED_TIMEOUT =
  'That upload took too long and stopped. Try again.';
export const ATTACHMENT_FAILED_ABORTED =
  'That upload stopped before it finished. Try again.';
export const ATTACHMENT_FAILED_MALFORMED =
  "The file went up, but we could not read the server's answer. Try again.";

/**
 * The sentence to put on a chip for a failed upload.
 *
 * Reads `kind` and `status` and nothing else. In particular it never reads
 * `err.message`: on an HTTP failure that field is whatever JSON the server
 * sent back, and putting server-authored text into the DOM is exactly the hop
 * we are supposed to be careful about.
 */
export function attachmentFailureSentence(err: unknown): string {
  if (!(err instanceof AttachmentUploadError)) return HTTP_FAILED;
  switch (err.kind) {
    case 'http':
      if (err.status === 415) return ATTACHMENT_FAILED_UNSUPPORTED;
      if (err.status === 413) return ATTACHMENT_FAILED_TOO_BIG;
      if (err.status === 429) return ATTACHMENT_FAILED_TOO_MANY;
      // 0 is not a status anything answers with; `httpErrorMessage` turns it
      // into the generic sentence, which is the right answer for "an HTTP
      // failure with no status we can read".
      return httpErrorMessage(err.status ?? 0);
    case 'timeout':
      return ATTACHMENT_FAILED_TIMEOUT;
    case 'aborted':
      return ATTACHMENT_FAILED_ABORTED;
    case 'malformed':
      return ATTACHMENT_FAILED_MALFORMED;
    case 'network':
      return HTTP_FAILED;
    default:
      return HTTP_FAILED;
  }
}

/**
 * One uploaded file, ready to ride along with a message.
 *
 * The id alone used to be enough, because the id was all the WIRE needed. It
 * is not all the TRANSCRIPT needs (TASK-424): the composer clears its chips the
 * instant it hands the message over, and until the turn is re-read the only
 * thing that can name the person's own file in their own bubble is what came
 * back with it here. So the name and type travel with the id rather than being
 * looked up from state that has already been cleared.
 */
export interface SendableAttachment {
  attachmentId: string;
  displayName: string;
  mediaType: string;
}

export interface WorkspaceAttachments {
  attachments: readonly WorkspaceAttachment[];
  add(files: readonly File[] | FileList): void;
  remove(id: string): void;
  retry(id: string): void;
  clear(): void;
  /**
   * The 'uploaded' ones, in pick order — what the composer sends. ONE list,
   * not an id list beside a name list: two derivations of the same set are how
   * a message reaches the wire with one file and the screen with another.
   */
  sendable: readonly SendableAttachment[];
  /** The ONE reason sending is held right now, as a sentence, or null. */
  sendBlock: string | null;
}

/** A progress fraction we are willing to render. */
function clamp01(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}

export function useWorkspaceAttachments(): WorkspaceAttachments {
  const [attachments, setAttachments] = useState<readonly WorkspaceAttachment[]>(
    [],
  );
  /*
   * The bytes, keyed by chip id, so `retry` can re-upload without the person
   * re-picking the file. Deliberately NOT on `WorkspaceAttachment`: the chip
   * renders a name and a status and has no business holding a `File`. A ref
   * rather than state because changing it must never re-render.
   */
  const filesRef = useRef<Map<string, File>>(new Map());

  const patch = useCallback(
    (id: string, next: Partial<WorkspaceAttachment>) => {
      setAttachments((prev) => {
        /*
         * A chip the person already removed stays removed. Both arms of an
         * upload land here long after the click that dropped it, so the write
         * is an id LOOKUP whose miss is a no-op — never an append, never a
         * positional write into an array that has since shifted.
         */
        if (!prev.some((a) => a.id === id)) return prev;
        return prev.map((a) => (a.id === id ? { ...a, ...next } : a));
      });
    },
    [],
  );

  const start = useCallback(
    async (id: string, file: File): Promise<void> => {
      try {
        const result = await uploadAttachment(file, {
          onProgress: (fraction) => patch(id, { progress: clamp01(fraction) }),
        });
        /*
          No shape check here on purpose. A 200 whose body carries no usable
          `attachmentId` is rejected by `uploadAttachment` itself as
          `kind: 'malformed'`, so it arrives in the `catch` below and
          `attachmentFailureSentence` turns it into `ATTACHMENT_FAILED_MALFORMED`
          — a failed chip with a Retry, which is both true and actionable.
          Guarding here instead would have left chat's adapter, the other
          consumer of that uploader, holding the unchecked body.
        */
        patch(id, {
          status: 'uploaded',
          progress: 1,
          attachmentId: result.attachmentId,
          message: null,
        });
      } catch (err) {
        patch(id, {
          status: 'failed',
          attachmentId: null,
          message: attachmentFailureSentence(err),
        });
      }
    },
    [patch],
  );

  const add = useCallback(
    (files: readonly File[] | FileList) => {
      // `Array.from` covers both a real `FileList` (array-like) and the plain
      // array a drop handler or a test hands over.
      const picked = Array.from(files as ArrayLike<File>);
      if (picked.length === 0) return;

      const minted = picked.map((file) => {
        const id = crypto.randomUUID();
        filesRef.current.set(id, file);
        const entry: WorkspaceAttachment = {
          id,
          name: file.name,
          // A file the OS could not type is still a file worth sending; the
          // server decides whether it likes the bytes.
          contentType: file.type || 'application/octet-stream',
          status: 'uploading',
          progress: 0,
          attachmentId: null,
          message: null,
        };
        return { id, file, entry };
      });

      setAttachments((prev) => [...prev, ...minted.map((m) => m.entry)]);
      for (const m of minted) void start(m.id, m.file);
    },
    [start],
  );

  const remove = useCallback((id: string) => {
    filesRef.current.delete(id);
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const retry = useCallback(
    (id: string) => {
      const file = filesRef.current.get(id);
      const entry = attachments.find((a) => a.id === id);
      // Only a failed chip retries. A second click while the retry is already
      // in flight would otherwise start a second upload for the same file.
      if (!file || !entry || entry.status !== 'failed') return;
      patch(id, {
        status: 'uploading',
        progress: 0,
        attachmentId: null,
        message: null,
      });
      void start(id, file);
    },
    [attachments, patch, start],
  );

  /*
   * Called after a successful send. There is no DELETE to make: an upload the
   * person never sends is reaped by the server's temp-store TTL, which is the
   * same thing chat's `remove()` relies on. Inventing a delete call here would
   * be a second lifecycle for the same object.
   */
  const clear = useCallback(() => {
    filesRef.current.clear();
    setAttachments([]);
  }, []);

  const sendable = useMemo(
    () =>
      attachments
        /*
          `!== null` would let an `undefined` through, which is the shape a
          malformed response produces — belt and braces with the guard in
          `start`, because this list is what reaches the wire.
        */
        .filter(
          (a) =>
            a.status === 'uploaded' &&
            typeof a.attachmentId === 'string' &&
            a.attachmentId.length > 0,
        )
        .map((a) => ({
          attachmentId: a.attachmentId as string,
          displayName: a.name,
          mediaType: a.contentType,
        })),
    [attachments],
  );

  const sendBlock = useMemo(() => {
    // Failure first: it needs a decision from the person, where the wait only
    // needs a second of patience.
    if (attachments.some((a) => a.status === 'failed')) {
      return ATTACHMENT_SEND_BLOCKED_FAILED;
    }
    if (attachments.some((a) => a.status === 'uploading')) {
      return ATTACHMENT_SEND_BLOCKED_UPLOADING;
    }
    return null;
  }, [attachments]);

  return { attachments, add, remove, retry, clear, sendable, sendBlock };
}
