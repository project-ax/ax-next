/**
 * Copy an artifact's share link (spec C1: the link starts off and is minted on
 * the first Copy link).
 *
 * The share code is a capability: anyone holding it can read the artifact. It
 * goes to the clipboard and nowhere else — never a log line, never a toast.
 */
import { logRequestFailure } from './http';
import { toastActions } from './toast-store';
import { workspaceApi } from './workspace-api';

const COPY_FAILED = 'We couldn’t copy the link just now. Try again in a moment.';

/** The page a link holder opens. */
export function shareLinkUrl(shareCode: string): string {
  return `${window.location.origin}/a/${shareCode}`;
}

/** Put the link on the clipboard and say so. Throws if the clipboard refuses. */
export async function writeShareLink(shareCode: string, copied = 'Link copied'): Promise<void> {
  await navigator.clipboard.writeText(shareLinkUrl(shareCode));
  toastActions.show({ title: copied });
}

/**
 * Turn the link on if it is off (`ensure` keeps an existing code), then copy
 * it. Never throws: a failure is a toast, and the console gets the status only.
 */
export async function copyShareLink(artifactId: string): Promise<void> {
  try {
    const shareCode = await workspaceApi.setArtifactLink(artifactId, 'ensure');
    if (shareCode === null) throw new Error('copyShareLink: ensure answered without a link');
    await writeShareLink(shareCode);
  } catch (e) {
    logRequestFailure(e, 'artifact-copy-link');
    toastActions.error(COPY_FAILED);
  }
}
