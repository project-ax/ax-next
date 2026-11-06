/**
 * `/a/<code>` — the share page's address (spec §6.1).
 *
 * The match is exact: `/a/`, then one segment that is a share code by
 * `@ax/ipc-protocol`'s own definition (32 URL-safe base64 characters), then
 * nothing. No trailing slash, no extra segment, no query, no fragment, no
 * percent-escapes (`%` is not a code character). The sign-in return trusts
 * this match and nothing else: a path that passes here is a same-origin
 * relative path of one known shape, so it can never send someone off-site
 * (`//evil.example`, `https://…`, `/a/..` all fail).
 *
 * The code is a capability (§6.3): never log it, whole or in part.
 */
import { isShareCode } from '@ax/ipc-protocol/content-blocks';

const SHARE_PATH = /^\/a\/([^/]*)$/;

export function parseShareRoute(pathname: string): { code: string } | null {
  const m = SHARE_PATH.exec(pathname);
  const code = m?.[1];
  return isShareCode(code) ? { code } : null;
}

/**
 * On a share page, send no `Referer` from here on, so the code in this
 * page's address can't ride along on a request to anywhere else. (The SPA's
 * HTML is one file for every path, so this is the per-route equivalent of a
 * `Referrer-Policy: no-referrer` header.) Idempotent; a no-op elsewhere.
 */
export function applyShareReferrerPolicy(pathname: string, doc: Document = document): void {
  if (parseShareRoute(pathname) === null) return;
  let meta = doc.head.querySelector<HTMLMetaElement>('meta[name="referrer"]');
  if (meta === null) {
    meta = doc.createElement('meta');
    meta.name = 'referrer';
    doc.head.appendChild(meta);
  }
  meta.content = 'no-referrer';
}
