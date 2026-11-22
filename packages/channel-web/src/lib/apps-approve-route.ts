/**
 * `/apps/approve/<platformId>/<appId>/<connectorId>`: the approve page's
 * address, the link an external app shows a viewer. Path-only, so it survives
 * sign-in (a query string wouldn't).
 *
 * The match is @ax/apps-bridge-contract's own `parseApprovePagePath`, so the
 * page, the server and the link builder share one grammar: each segment
 * matches its id grammar, with no trailing slash, no extra segment, no
 * percent-escape, no `.`/`..`, and nothing after the path. The sign-in return
 * (`lib/auth.ts`) trusts this match and nothing else: a path that passes is a
 * same-origin relative path of one known shape, so it can never send someone
 * off-site.
 */
import { parseApprovePagePath, type ApprovePageIds } from '@ax/apps-bridge-contract';

export function parseAppsApproveRoute(pathname: string): ApprovePageIds | null {
  return parseApprovePagePath(pathname);
}
