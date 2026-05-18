import type {
  AttachmentAdapter,
  PendingAttachment,
  CompleteAttachment,
} from '@assistant-ui/react';

/**
 * AxAttachmentAdapter — assistant-ui AttachmentAdapter implementation that
 * speaks the AX `/api/attachments` upload endpoint.
 *
 * Phase 3 (2026-05-18). Replaces the previous "no adapter, attach button
 * hidden" posture documented in lib/runtime.tsx.
 *
 * Flow:
 *   add(file)
 *     → POST /api/attachments multipart
 *     → yield PendingAttachment(running:uploading, progress 0..1)
 *     → on success: yield PendingAttachment(requires-action:composer-send)
 *           with id = server-minted attachmentId.
 *   send(pending)
 *     → return CompleteAttachment with a `file` content part carrying
 *       `data: ax://attachment/<attachmentId>`. The transport's
 *       toContentBlocks() converts this to an `attachment_ref` block.
 *   remove()
 *     → no-op. Temp-store TTL (default 10 min) reclaims unsent uploads.
 *       Future: explicit DELETE /api/attachments/<id>.
 */
export class AxAttachmentAdapter implements AttachmentAdapter {
  // Comma-joined MIME list. Matches the server's default allowlist.
  // Server is authoritative — this is just a UX hint for the file picker.
  accept =
    'image/png,image/jpeg,image/gif,image/webp,application/pdf,' +
    'text/plain,text/csv,text/markdown,application/json,application/zip';

  async *add({
    file,
  }: {
    file: File;
  }): AsyncGenerator<PendingAttachment> {
    const tempId = crypto.randomUUID();
    yield {
      id: tempId,
      type: typeForMime(file.type),
      name: file.name,
      contentType: file.type || 'application/octet-stream',
      file,
      status: { type: 'running', reason: 'uploading', progress: 0 },
    };

    let lastProgress = 0;
    const result = await uploadWithProgress(file, (progress) => {
      lastProgress = progress;
    });
    void lastProgress; // observed via the promise's progress callback above

    yield {
      id: result.attachmentId,
      type: typeForMime(result.mediaType),
      name: result.displayName,
      contentType: result.mediaType,
      file,
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  }

  async send(pending: PendingAttachment): Promise<CompleteAttachment> {
    return {
      id: pending.id,
      type: pending.type,
      name: pending.name,
      contentType: pending.contentType,
      status: { type: 'complete' },
      content: [
        {
          type: 'file',
          data: `ax://attachment/${pending.id}`,
          mimeType: pending.contentType ?? 'application/octet-stream',
          filename: pending.name,
        },
      ],
    };
  }

  async remove(_attachment?: unknown): Promise<void> {
    // No-op. TTL janitor reaps unsent temps.
  }
}

interface UploadResult {
  attachmentId: string;
  sizeBytes: number;
  mediaType: string;
  displayName: string;
  expiresAt: string;
}

function typeForMime(mime: string): PendingAttachment['type'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

function uploadWithProgress(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/attachments');
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-Requested-With', 'ax-admin');
    xhr.upload.onprogress = (e: ProgressEvent) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress(e.loaded / e.total);
      }
    };
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const parsed = JSON.parse(xhr.responseText) as UploadResult;
          resolve(parsed);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      } else {
        // Try to parse a JSON error body for a nicer UX; otherwise
        // surface status code.
        let errCode = `upload failed (${xhr.status})`;
        try {
          const parsed = JSON.parse(xhr.responseText) as { error?: string };
          if (parsed.error) errCode = parsed.error;
        } catch { /* ignore */ }
        reject(new Error(errCode));
      }
    };
    xhr.send(form);
  });
}
