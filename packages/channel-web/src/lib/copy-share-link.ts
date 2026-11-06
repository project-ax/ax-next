/**
 * Copy an artifact's share link (spec C1: the link starts off and is minted on
 * the first Copy link).
 *
 * THE CLIPBOARD WRITE STARTS IN THE CLICK. Safari only lets a page write to
 * the clipboard during the user's gesture, and the gesture is gone once we
 * `await` the request that mints the code. So the write is begun
 * synchronously, with a `ClipboardItem` whose text is a PROMISE that resolves
 * once the code arrives — the pattern WebKit supports. Where `ClipboardItem`
 * is missing (older Firefox), `writeText` after the request is the fallback;
 * those browsers don't need the gesture for it.
 *
 * If the write is still refused, the caller shows the link in a field for the
 * person to copy themselves (`ShareLinkDialog`). Retrying would fail the same
 * way, so we never tell them to try again for that.
 *
 * The share code is a capability: anyone holding it can read the artifact. It
 * goes to the clipboard or that owner-only field and nowhere else — never a
 * log line, never a toast.
 */
import { logRequestFailure } from './http';
import { toastActions } from './toast-store';
import { workspaceApi } from './workspace-api';

const LINK_FAILED = 'We couldn’t turn the link on just now. Nothing changed — try again in a moment.';

/** The page a link holder opens. */
export function shareLinkUrl(shareCode: string): string {
  return `${window.location.origin}/a/${shareCode}`;
}

export type CopyOutcome =
  | { kind: 'copied' }
  /** The link exists, but the browser refused the clipboard: show `url` to copy by hand. */
  | { kind: 'manual'; url: string }
  /** The request for a code failed: nothing to copy. */
  | { kind: 'failed' };

/**
 * Get a share code with `getCode` and copy its link. Call it SYNCHRONOUSLY
 * from the click handler (no `await` before it), or Safari refuses the write.
 * Never throws; no toasts — the caller says what happened.
 */
export function copyLinkFrom(getCode: () => Promise<string | null>): Promise<CopyOutcome> {
  const url = getCode().then((code) => {
    if (code === null) throw new Error('copyLinkFrom: no link came back');
    return shareLinkUrl(code);
  });
  let write: Promise<void>;
  try {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) throw new Error('copyLinkFrom: no clipboard');
    write =
      typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function'
        ? clipboard.write([
            new ClipboardItem({ 'text/plain': url.then((u) => new Blob([u], { type: 'text/plain' })) }),
          ])
        : url.then((u) => clipboard.writeText(u));
  } catch (e) {
    write = Promise.reject(e instanceof Error ? e : new Error('copyLinkFrom: clipboard threw'));
  }
  // Settled below in every path; this keeps a write rejected alongside a
  // failed request from surfacing as an unhandled rejection.
  write.catch(() => {});

  return (async (): Promise<CopyOutcome> => {
    let link: string;
    try {
      link = await url;
    } catch (e) {
      logRequestFailure(e, 'artifact-share-link');
      return { kind: 'failed' };
    }
    try {
      await write;
      return { kind: 'copied' };
    } catch (e) {
      // The error names the clipboard refusal, never the link.
      logRequestFailure(e, 'artifact-copy-link');
      return { kind: 'manual', url: link };
    }
  })();
}

/**
 * Copy link: turn the link on if it is off (`ensure` keeps an existing code),
 * then copy it. Call synchronously from the click. Toasts "Link copied" or the
 * request failure; a `manual` outcome is the caller's to show.
 */
export async function copyShareLink(artifactId: string): Promise<CopyOutcome> {
  const outcome = await copyLinkFrom(() => workspaceApi.setArtifactLink(artifactId, 'ensure'));
  if (outcome.kind === 'copied') toastActions.show({ title: 'Link copied' });
  if (outcome.kind === 'failed') toastActions.error(LINK_FAILED);
  return outcome;
}
