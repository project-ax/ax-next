// The parent's half of the frame protocol: what we accept from a visual's frame.
//
// Everything the frame posts is written by code running next to the agent's
// HTML, so it is untrusted input. A message counts only if it came from OUR
// frame's window (`source`), from an opaque origin (`origin === 'null'`, which
// is what `sandbox="allow-scripts"` without allow-same-origin gives), and has
// one of four known shapes. Anything else is dropped without a word: other
// windows (an OAuth popup, an extension, another visual) post to this window
// too, and none of them get to drive this one.

import { VISUAL_MAX_HEIGHT, VISUAL_MIN_HEIGHT } from './visual-doc';

/** Largest PNG we'll take from a frame. Beyond this it's not a chart. */
export const VISUAL_MAX_EXPORT_BYTES = 15 * 1024 * 1024;

export type FrameMessage =
  | { type: 'size'; height: number }
  // `locked` is advisory (the runtime's own report on its locks). Never decide
  // anything on it: a frame can say whatever it likes about itself.
  | { type: 'ready'; height: number; rendered: boolean; locked?: boolean }
  | { type: 'error' }
  | { type: 'export-result'; requestId: string; blob: Blob | null };

export function clampHeight(h: number): number {
  return Math.min(VISUAL_MAX_HEIGHT, Math.max(VISUAL_MIN_HEIGHT, Math.round(h)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

function finiteHeight(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? clampHeight(value) : null;
}

function boundedPng(value: unknown): Blob | null {
  if (!(value instanceof Blob)) return null;
  if (value.size < 1 || value.size > VISUAL_MAX_EXPORT_BYTES) return null;
  if (value.type !== 'image/png') return null;
  return value;
}

export function parseFrameMessage(
  event: Pick<MessageEvent, 'data' | 'source' | 'origin'>,
  frame: Window | null,
  pendingExports: ReadonlySet<string>,
): FrameMessage | null {
  // No frame mounted means nothing can be ours, including a null source.
  if (frame === null || event.source !== frame) return null;
  if (event.origin !== 'null') return null;
  const data: unknown = event.data;
  if (!isPlainObject(data)) return null;
  switch (data.type) {
    case 'ax-visual:size': {
      const height = finiteHeight(data.height);
      return height === null ? null : { type: 'size', height };
    }
    case 'ax-visual:ready': {
      const height = finiteHeight(data.height);
      if (height === null || typeof data.rendered !== 'boolean') return null;
      const msg: FrameMessage = { type: 'ready', height, rendered: data.rendered };
      if (typeof data.locked === 'boolean') msg.locked = data.locked;
      return msg;
    }
    case 'ax-visual:error':
      // Accepted at any time: the runtime also reports a teardown after ready.
      return { type: 'error' };
    case 'ax-visual:export-result': {
      const requestId = data.requestId;
      if (typeof requestId !== 'string' || !pendingExports.has(requestId)) return null;
      const blob = data.ok === true ? boundedPng(data.blob) : null;
      return { type: 'export-result', requestId, blob };
    }
    default:
      return null;
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsArrayBuffer(blob);
  });
}

/** The MIME type is the frame's say-so; the first eight bytes are not. */
export async function isPngBlob(blob: Blob): Promise<boolean> {
  try {
    const head = new Uint8Array(await readBytes(blob.slice(0, PNG_SIGNATURE.length)));
    return head.length === PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => head[i] === b);
  } catch {
    return false;
  }
}
