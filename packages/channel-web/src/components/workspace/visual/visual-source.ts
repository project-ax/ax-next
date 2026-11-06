// Where a visual's HTML comes from, and what we remember about it.
//
// The HTML is a text/html artifact served by /api/files (as an octet-stream,
// so the browser never renders it on its own). We only ever read it as text
// and hand it to buildVisualDocument. Both caches are module-level so a thread
// re-render or a remount (scrolling, switching chats) doesn't refetch or jump.

import { HttpError, httpFetch } from '@/lib/http';

/** A visual is a chart, not a website. The tool refuses bigger ones too. */
export const VISUAL_MAX_FETCH_BYTES = 256 * 1024;

const MAX_HTML_ENTRIES = 32;
const MAX_HEIGHT_ENTRIES = 200;

const htmlCache = new Map<string, Promise<string>>();
const heightCache = new Map<string, number>();

// Map iteration order is insertion order, so the first key is the oldest.
function evictOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

async function fetchVisualHtml(conversationId: string, artifactId: string): Promise<string> {
  const url = `/api/files?conversationId=${encodeURIComponent(conversationId)}&id=${encodeURIComponent(artifactId)}`;
  const res = await httpFetch(url);
  if (!res.ok) throw new HttpError(url, res.status);
  // Refuse on the header before reading a byte of the body.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > VISUAL_MAX_FETCH_BYTES) {
    throw new Error('visual too large');
  }
  const text = await res.text();
  if (new TextEncoder().encode(text).byteLength > VISUAL_MAX_FETCH_BYTES) {
    throw new Error('visual too large');
  }
  return text;
}

export function loadVisualHtml(conversationId: string, artifactId: string): Promise<string> {
  const key = `${conversationId}\u0000${artifactId}`;
  const cached = htmlCache.get(key);
  if (cached) return cached;
  const promise = fetchVisualHtml(conversationId, artifactId);
  htmlCache.set(key, promise);
  evictOldest(htmlCache, MAX_HTML_ENTRIES);
  // A failure isn't remembered: the next mount gets a fresh try.
  promise.catch(() => {
    if (htmlCache.get(key) === promise) htmlCache.delete(key);
  });
  return promise;
}

export function rememberHeight(artifactId: string, h: number): void {
  heightCache.delete(artifactId);
  heightCache.set(artifactId, h);
  evictOldest(heightCache, MAX_HEIGHT_ENTRIES);
}

export function recalledHeight(artifactId: string): number | undefined {
  return heightCache.get(artifactId);
}
