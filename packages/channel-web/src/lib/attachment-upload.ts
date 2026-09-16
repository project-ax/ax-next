import type { ContentBlock } from '@ax/ipc-protocol';

/**
 * attachment-upload — the single primitive for uploading a file to
 * `/api/attachments` and turning the result into an `attachment_ref`
 * ContentBlock. Originally lived only inside `AxAttachmentAdapter` (chat's
 * assistant-ui composer); pulled out so the agent-workspace surface can
 * reuse chat's lineage (XHR shape, error taxonomy, wire URL prefix)
 * instead of forking a second copy that quietly drifts.
 */

// Comma-joined MIME list. Matches the server's default allowlist.
// Server is authoritative — this is just a UX hint for the file picker.
export const ATTACHMENT_ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,application/pdf,' +
  'text/plain,text/csv,text/markdown,application/json,application/zip';

/** Wire URL prefix for an uploaded attachment reference, e.g.
 *  `ax://attachment/<attachmentId>`. Both the chat transport (parsing an
 *  incoming `file` part) and the attachment adapter (building the outgoing
 *  one) must agree on this exact prefix. */
export const AX_ATTACHMENT_URL_PREFIX = 'ax://attachment/';

export interface AttachmentUploadResult {
  attachmentId: string;
  sizeBytes: number;
  mediaType: string;
  displayName: string;
  expiresAt: string;
}

export type AttachmentUploadErrorKind =
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'http'
  | 'malformed';

export class AttachmentUploadError extends Error {
  readonly kind: AttachmentUploadErrorKind;
  readonly status: number | null;

  constructor(
    message: string,
    kind: AttachmentUploadErrorKind,
    status: number | null,
  ) {
    super(message);
    this.name = 'AttachmentUploadError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Upload `file` to `/api/attachments` via XHR (for real upload-progress
 * events; `fetch` has no equivalent), resolving with the server-minted
 * attachment metadata or rejecting with an `AttachmentUploadError`.
 */
export function uploadAttachment(
  file: File,
  opts?: { onProgress?: (fraction: number) => void },
): Promise<AttachmentUploadResult> {
  const onProgress = opts?.onProgress;
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/attachments');
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-Requested-With', 'ax-admin');
    xhr.upload.onprogress = (e: ProgressEvent) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress?.(e.loaded / e.total);
      }
    };
    // Cap stall-out at 60s so an unreachable server doesn't leave the
    // returned promise pending forever. abort + timeout get their own
    // rejection reasons so an upstream surface (toast, retry button) can
    // distinguish them from a generic network failure.
    xhr.timeout = 60_000;
    xhr.onerror = () =>
      reject(new AttachmentUploadError('upload failed', 'network', null));
    xhr.onabort = () =>
      reject(new AttachmentUploadError('upload aborted', 'aborted', null));
    xhr.ontimeout = () =>
      reject(new AttachmentUploadError('upload timed out', 'timeout', null));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const parsed = JSON.parse(
            xhr.responseText,
          ) as AttachmentUploadResult | null;
          /*
            A 2xx IS NOT A PROMISE THAT THE BODY IS OURS. `JSON.parse` will
            happily return `null`, a number, an array, or a proxy's JSON
            courtesy page, and nothing downstream re-checks — so an unvalidated
            resolve hands a missing id to every caller. On the workspace chip
            that reads as "Ready to send" over nothing to send; in chat's
            adapter `serverIds.set(tempId, undefined)` then `?? pending.id`
            puts `ax://attachment/<client-uuid>` on the wire, and a bare `{}`
            reaches `typeForMime(undefined)` and throws inside an async
            generator. One guard here covers both, which is the whole reason
            this module exists rather than a copy per surface.

            `parsed?.` and not `parsed.`, for a narrower reason than it looks:
            `JSON.parse('null')` returns `null`, and a bare property read on it
            throws — but the throw lands in this function's own `catch` two
            lines down and comes back out as the same `kind: 'malformed'`, so
            the SENTENCE a person sees is identical either way. What the
            optional chain changes is the error's `message`: ours
            ("missing attachmentId") rather than V8's "Cannot read properties
            of null (reading 'attachmentId')". Chat's adapter lets this
            rejection propagate to assistant-ui, so `.message` is a string that
            can reach a person, and an engine's internal wording has no more
            business there than the server's `{error}` does.
          */
          if (
            typeof parsed?.attachmentId !== 'string' ||
            parsed.attachmentId.length === 0
          ) {
            reject(
              new AttachmentUploadError(
                'missing attachmentId',
                'malformed',
                xhr.status,
              ),
            );
            return;
          }
          resolve(parsed);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          reject(new AttachmentUploadError(message, 'malformed', xhr.status));
        }
      } else {
        // Try to parse a JSON error body for a nicer UX; otherwise
        // surface status code.
        let errCode = `upload failed (${xhr.status})`;
        try {
          const parsed = JSON.parse(xhr.responseText) as { error?: string };
          if (parsed.error) errCode = parsed.error;
        } catch { /* ignore */ }
        reject(new AttachmentUploadError(errCode, 'http', xhr.status));
      }
    };
    xhr.send(form);
  });
}

/**
 * THE single spelling of an `attachment_ref` ContentBlock. Both the chat
 * transport (`transport.ts`) and the agent-workspace client build this
 * block through this function — a second hand-rolled literal is exactly
 * the kind of divergence that silently loses a file (wrong field name,
 * missing field) on one surface but not the other.
 */
export function attachmentRefBlock(attachmentId: string): ContentBlock {
  return { type: 'attachment_ref', attachmentId };
}
