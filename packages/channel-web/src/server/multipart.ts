import Busboy from 'busboy';
import { Readable } from 'node:stream';

export interface ParsedFile {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

/**
 * Determine whether the file part in the multipart body has an explicit
 * Content-Type header. busboy reports `mimeType: 'text/plain'` when a part
 * has no Content-Type header — but for binary uploads we want to fall back
 * to `application/octet-stream`. Scanning the raw body lets us distinguish
 * "no header" from "explicit text/plain".
 */
function filePartHasExplicitContentType(body: Buffer, boundary: string): boolean {
  const delim = Buffer.from(`--${boundary}`, 'utf8');
  const parts: Buffer[] = [];
  let idx = 0;
  while (idx < body.length) {
    const next = body.indexOf(delim, idx);
    if (next === -1) {
      if (idx > 0) parts.push(body.subarray(idx, body.length));
      break;
    }
    if (next > idx) parts.push(body.subarray(idx, next));
    idx = next + delim.length;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.subarray(0, headerEnd).toString('utf8');
    if (!/Content-Disposition:[^\n]*name="file"/i.test(headers)) continue;
    if (!/filename\*?=/.test(headers)) continue;
    return /Content-Type\s*:/i.test(headers);
  }
  return false;
}

function extractBoundary(contentTypeHeader: string): string | null {
  const m = /boundary=("([^"]+)"|([^;\s]+))/i.exec(contentTypeHeader);
  if (!m) return null;
  return m[2] ?? m[3] ?? null;
}

export function parseSingleFileMultipart(
  body: Buffer,
  contentTypeHeader: string,
): Promise<ParsedFile> {
  return new Promise((resolve, reject) => {
    if (!contentTypeHeader || !contentTypeHeader.toLowerCase().startsWith('multipart/')) {
      reject(new Error('invalid content-type: expected multipart/form-data'));
      return;
    }
    const boundary = extractBoundary(contentTypeHeader);
    if (!boundary) {
      reject(new Error('invalid content-type: missing boundary'));
      return;
    }
    const hasExplicitContentType = filePartHasExplicitContentType(body, boundary);

    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({ headers: { 'content-type': contentTypeHeader } });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let fileEventCount = 0;
    let completedFile: ParsedFile | null = null;
    // A `file` field with no filename is delivered by busboy as a non-file `field` event.
    let sawFileFieldWithoutFilename = false;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    busboy.on('file', (fieldname, stream, info) => {
      if (fieldname !== 'file') {
        stream.resume();
        return;
      }
      fileEventCount += 1;
      if (fileEventCount > 1) {
        stream.resume();
        settle(() => reject(new Error('multiple file parts not allowed')));
        return;
      }
      const filename = info.filename;
      const mimeType = hasExplicitContentType
        ? info.mimeType || 'application/octet-stream'
        : 'application/octet-stream';
      if (!filename || filename.length === 0) {
        stream.resume();
        settle(() => reject(new Error('file part missing filename')));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
      });
      stream.on('end', () => {
        completedFile = { filename, mimeType, bytes: Buffer.concat(chunks, total) };
      });
      stream.on('error', (err: Error) => settle(() => reject(err)));
    });

    busboy.on('field', (fieldname) => {
      if (fieldname === 'file') {
        sawFileFieldWithoutFilename = true;
      }
    });

    busboy.on('error', (err) => settle(() => reject(err as Error)));
    busboy.on('finish', () => {
      if (completedFile) {
        settle(() => resolve(completedFile!));
        return;
      }
      if (sawFileFieldWithoutFilename) {
        settle(() => reject(new Error('file part missing filename')));
        return;
      }
      settle(() => reject(new Error('no file part in multipart body')));
    });

    Readable.from(body).pipe(busboy);
  });
}
