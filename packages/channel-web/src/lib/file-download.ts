/**
 * Getting a file the agent made OUT — the browser half.
 *
 * WHY THIS IS NOT `window.open(url)`. That is how the chat attachment chip
 * does it, and it is fine there. Here it is not, for one reason: when a
 * download route answers anything other than 200, `window.open` shows the
 * person the failure — as a blank tab, or as `{"error":"file-not-found"}` in
 * the top-left corner of an otherwise empty page. Neither is a sentence, and
 * the second one is a JSON body being read by a human, which is the thing this
 * surface spends the most effort not doing.
 *
 * So we ask for the bytes ourselves, and then we either hand them over or say
 * what went wrong in words. It buys a failure the reader can act on.
 *
 * WHAT IT COSTS, honestly: the whole file lands in the tab's memory before it
 * reaches the disk. The durable tier caps a read at a megabyte, so that half is
 * bounded — but the governed tier has NO cap, so a large committed file is a
 * large buffer here. The streaming alternative is `window.open`, and it was
 * rejected above for a reason that has not changed. If a file ever arrives big
 * enough for this to matter, the fix is a route that streams and a client that
 * reads it as a stream, not a quiet return to showing people JSON.
 *
 * THE FILENAME COMES FROM THE SERVER, not from the row that was clicked. The
 * route already sanitizes it for `Content-Disposition` (a filename is
 * agent-authored, and that header is one a newline can end), and re-deriving
 * it here would be a second sanitizer with a second set of rules — the exact
 * shape of "one of them gets fixed and the other quietly doesn't". We parse
 * the name the server settled on, and fall back to a plain one if the header
 * is missing.
 */
import { useCallback, useRef, useState } from 'react';
import { HttpError } from './http';
import { workspaceApi, type FileTier } from './workspace-api';

/**
 * Hand a blob to the browser's download machinery.
 *
 * The object URL is revoked on the next tick rather than immediately: the
 * click is dispatched synchronously but the fetch of the blob URL is not, and
 * revoking inside the same task cancels the download in some browsers. A tick
 * later it has been read.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/**
 * What a failed download SAYS.
 *
 * Four outcomes, four sentences, and none of them is "something went wrong".
 * The one worth reading twice is the size case: it is not an error, it is a
 * limit we are being honest about. We can only reach the first megabyte of a
 * file on the durable tier, and a megabyte of a PDF is not a small PDF — it is
 * a broken one that opens to an error message. Handing that over as the file
 * they asked for would be worse than refusing, so we refuse and say why.
 *
 * A 401 never reaches here: `httpFetch` latches it and the whole app moves to
 * the signed-out screen before any caller sees it.
 */
export function downloadFailureMessage(e: unknown, agentName: string): string {
  const status = e instanceof HttpError ? e.status : 0;
  if (status === 413) {
    return `This file is too big for us to pass along in one piece — we can only reach the first megabyte of it, and part of a file is worse than none. Ask ${agentName} for a smaller copy, or to split it up.`;
  }
  if (status === 404) {
    return 'We could not find that file to send. It may have been rewritten or deleted since this list was drawn.';
  }
  if (status === 503) {
    return `This server is not set up to hand ${agentName}’s files over, so there is nothing for us to send.`;
  }
  return 'We could not download that just now. Nothing was lost — the file is still there, it is the download that failed.';
}

export interface FileDownloadState {
  /** Fetch the bytes and hand them to the browser. Safe to call twice. */
  start: () => void;
  /** A download is in flight. The affordance says so and refuses a second one. */
  busy: boolean;
  /**
   * The authored sentence for the last failure, or `null`.
   *
   * ITS OWN STATE, deliberately. The Files tab already tells four things
   * apart — the listing failed, there is no backend for this tier, we are
   * still loading, the agent has written nothing — and a download that did not
   * happen is a fifth. Folding it into any of the others would report a
   * failed download as a fact about the agent's files, which it is not.
   */
  error: string | null;
}

export function useFileDownload(args: {
  agentId: string;
  agentName: string;
  tier: FileTier;
  path: string;
}): FileDownloadState {
  const { agentId, agentName, tier, path } = args;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The in-flight guard, in a REF rather than read off `busy`.
   *
   * `busy` disables the button, but only after a render — so two clicks
   * dispatched in the same frame both see `busy === false` and both start a
   * download. The visible result is the file saved twice, which is a small
   * thing that looks exactly like a bug to whoever it happens to. A ref is
   * written synchronously, so the second click sees the first one.
   */
  const inFlight = useRef(false);

  const start = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const got = await workspaceApi.downloadFile(agentId, tier, path);
        saveBlob(got.blob, got.filename);
      } catch (e) {
        setError(downloadFailureMessage(e, agentName));
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    })();
  }, [agentId, agentName, tier, path]);

  return { start, busy, error };
}
