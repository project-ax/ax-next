/**
 * Getting a file the agent made OUT — the browser half.
 *
 * THE BROWSER DOES THE DOWNLOAD (TASK-1022). We hand it the route itself, as
 * a same-origin `<a href download>` click, and it streams the file straight
 * to disk. The tab never holds the file, so a big one costs this page
 * nothing. It used to: we fetched the whole body into a Blob first, so a file
 * near the route's limit (`USER_FILE_DOWNLOAD_MAX_BYTES`) sat in the tab's
 * memory until it was saved.
 *
 * WHY WE ASK FIRST. Once the browser has the download, any trouble with it
 * shows in the browser's own download bar, in the browser's words: "Failed",
 * at best with a short reason. It cannot say "this is too big to send, so ask
 * for a smaller copy", or "this was deleted since the list was drawn", and
 * those are the sentences this surface exists to say. So before the click we
 * ask the same route with `?probe=1`. It runs every check a download makes
 * before its first byte, and answers 200 instead of sending the bytes. A
 * refusal comes back here as a status, and `downloadFailureMessage` says it
 * in words, next to the button.
 *
 * NOT `window.open(url)`. There, a refusal is a blank tab, or
 * `{"error":"file-not-found"}` alone on an empty page: a JSON body being read
 * by a human, which is the thing this surface spends the most effort not
 * doing.
 *
 * WHAT IS LEFT TO THE DOWNLOAD BAR, honestly. Two things the probe cannot
 * see:
 *   - a failure after the first byte: the connection drops, or the file is
 *     changed or deleted mid-download;
 *   - the moment between the probe's yes and the download: if the file is
 *     deleted or changed in that gap, the download itself may be refused
 *     (the route's 404, 409 or 413).
 * Each shows up as a failed download in the browser's bar, not as a sentence
 * here. Safari saves a whole refusal as a file (`<name>.json`, measured on
 * Safari 26.5), so the route sends a real download's refusal TORN: its status,
 * then a body cut short (TASK-1025). Chromium fails that download, Firefox
 * starts none, and macOS Safari leaves only an interrupted `.download`
 * partial (iOS Safari was not walked).
 *
 * THE FILENAME COMES FROM THE SERVER, not from the row that was clicked. The
 * route sanitizes it for `Content-Disposition` (a filename is agent-authored,
 * and that header is one a newline can end), and the link's `download`
 * attribute is left EMPTY so the browser uses that name. Naming the file here
 * would be a second sanitizer with a second set of rules — the exact shape of
 * "one of them gets fixed and the other quietly doesn't".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HttpError, logRequestFailure } from './http';
import { workspaceApi } from './workspace-api';

/**
 * Hand a download ROUTE to the browser's own download (TASK-1022).
 *
 * The browser fetches the route and streams the file straight to disk, so
 * the bytes never pass through this tab. Ask the route first (`?probe=1`),
 * and call this only on its yes: from here on, a failure is the download
 * bar's to report, not ours.
 *
 * `url` MUST be a root-relative route this app built from encoded segments
 * (`workspaceApi.probeFileDownload`, or the chip's own `downloadUrl`). Never
 * an address an agent wrote. Anything that is not a same-origin
 * `/api/workspace/` route throws before the click (TASK-1022 review).
 *
 * `download` is present and EMPTY, so the browser takes the name from the
 * route's `Content-Disposition`, which the server already sanitized. The link
 * is in the document when it is clicked, as `saveBlob`'s is, and removed
 * straight after.
 */
export function saveFromUrl(url: string): void {
  // Enforced, not just documented: a `javascript:` href runs (browsers ignore
  // `download` on it), and an absolute or protocol-relative one leaves our
  // origin. Only our own download routes may be handed to the browser.
  // Root-relative only: a path-relative URL would resolve against the PAGE
  // when clicked, not against the origin this check used.
  const resolved = new URL(url, window.location.origin);
  if (!url.startsWith('/') || resolved.origin !== window.location.origin || !resolved.pathname.startsWith('/api/workspace/')) {
    throw new Error('saveFromUrl: refusing a URL that is not one of our download routes');
  }
  const a = document.createElement('a');
  a.href = url;
  a.setAttribute('download', '');
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Hand a blob to the browser's download machinery.
 *
 * Only chat ATTACHMENT chips use this now (`/api/files`). A file from the
 * agent's files goes through `saveFromUrl` instead, so the browser streams it
 * to disk and the tab never holds it (TASK-1022).
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
 * Six outcomes, six sentences, and none of them is "something went wrong".
 * The one worth reading twice is the size case: it is not an error, it is a
 * limit we are being honest about. The file is over our download limit, and
 * we do not send part of it: part of a PDF is not a small PDF, it is a broken
 * one that opens to an error message. So we refuse, say why, and say what
 * would work instead.
 *
 * A file found changing before the first byte is sent is a 409, and gets
 * its own sentence: try again.
 *
 * Every answer here is the PROBE's (TASK-1022): the route's own refusal,
 * asked for before the browser is handed the download. A download that
 * breaks AFTER its first byte (the file changed or was deleted under it, or
 * the connection dropped) never reaches this function: by then the browser
 * has it, and says so in its own download bar. So the last two sentences are
 * for a probe that got no answer we have a sentence for, and they say only
 * what they know: the download didn't start, and nothing was saved. Only a
 * probe that got no answer at all mentions the connection; a status none of
 * the others covers (a 5xx), or a key that could not be put in an address,
 * does not. Neither makes a claim about the file, because a probe with no
 * usable answer told us nothing about it.
 *
 * A 401 never reaches here: `httpFetch` latches it and the whole app moves to
 * the signed-out screen before any caller sees it.
 */
export function downloadFailureMessage(e: unknown, agentName: string): string {
  const status = e instanceof HttpError ? e.status : 0;
  if (status === 413) {
    /*
      NO NUMBER IN THIS SENTENCE, on purpose. The limit lives on the server
      (`USER_FILE_DOWNLOAD_MAX_BYTES`), so a figure here would be a second copy
      of it that could change without a single test noticing this sentence had
      started to lie. The actionable half — it is too big, ask for a smaller
      one — does not need the figure.
    */
    return `This file is too big for us to pass along in one piece. Ask ${agentName} for a smaller copy, or to split it up.`;
  }
  // 400 is `not-a-file` (the key is a folder now) or a key the route will not
  // read: either way the file is not there to send, and retrying will not
  // change that. The chip says "no longer available" for the same answer.
  if (status === 404 || status === 400) {
    return 'We could not find that file to send. It may have been rewritten or deleted since this list was drawn.';
  }
  if (status === 409) {
    return 'That file changed while we were getting it, so we stopped rather than hand you a mix of old and new. Try again in a moment.';
  }
  if (status === 503) {
    /*
      A 503 here is a read the storage would not answer: it failed, it timed
      out, or this deployment cannot hand files over right now. "This server
      keeps no files" is a 503 too, but it cannot be reached from a listed
      file — the tab offers a download only on a file it listed, and the
      listing 503s first. So this is the transient sentence.
    */
    return `We couldn’t get to ${agentName}’s files just now. Nothing was lost — try again in a moment.`;
  }
  // No answer at all: fetch threw (a TypeError), or an HttpError with no
  // status. That one may be the connection.
  if (e instanceof TypeError || (e instanceof HttpError && e.status === 0)) {
    return 'That download didn’t start, so nothing was saved. The connection may have dropped. Try again in a moment.';
  }
  // An answer we have no sentence for (a 5xx is the server's doing, not the
  // reader's wifi), or a key that could not be put in an address at all.
  return 'That download didn’t start, so nothing was saved. Try again in a moment.';
}

/**
 * How long, once the browser has been handed a download, the affordance says
 * so and ignores further clicks (TASK-1025).
 */
export const DOWNLOAD_STARTED_MS = 4_000;
export const DOWNLOAD_STARTED_NOTE = 'Download started. Check your browser’s downloads.';

export interface FileDownloadState {
  /**
   * Ask the route, then hand the download to the browser. Safe to call twice:
   * a call while the probe is out, or while `started`, does nothing.
   */
  start: () => void;
  /**
   * The probe is in flight. The affordance says so and refuses a second one.
   * It ends when the probe answers: once the browser has the download, it is
   * the browser's (TASK-1022), and `started` takes over.
   */
  busy: boolean;
  /**
   * The browser has been handed the download, and the last
   * `DOWNLOAD_STARTED_MS` have not passed. The affordance says so
   * (`DOWNLOAD_STARTED_NOTE`) and `start()` does nothing, so a double click
   * or a quick re-click saves the file once. A refusal never sets it (TASK-1025).
   */
  started: boolean;
  /**
   * The authored sentence for the last failure, or `null`.
   *
   * ITS OWN STATE, deliberately. The Files tab already tells four things
   * apart — the listing failed, there is no file area, we are
   * still loading, the agent has written nothing — and a download that did not
   * happen is a fifth. Folding it into any of the others would report a
   * failed download as a fact about the agent's files, which it is not.
   */
  error: string | null;
}

export function useFileDownload(args: {
  agentId: string;
  agentName: string;
  path: string;
}): FileDownloadState {
  const { agentId, agentName, path } = args;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  /**
   * The in-flight guard, in a REF rather than read off `busy`.
   *
   * `busy` disables the button, but only after a render — so two clicks
   * dispatched in the same frame both see `busy === false` and both start a
   * download. The visible result is the file saved twice, which is a small
   * thing that looks exactly like a bug to whoever it happens to. A ref is
   * written synchronously, so the second click sees the first one.
   *
   * It also covers the started window: after the browser has the download it
   * stays held until `DOWNLOAD_STARTED_MS` later, so the guard and `started`
   * open and close together. A refusal, or a throw, releases it at once.
   */
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, []);

  const start = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void (async () => {
      let handedOver = false;
      try {
        saveFromUrl(await workspaceApi.probeFileDownload(agentId, path));
        handedOver = true;
        // A reader who left while the probe was out still gets the file they
        // asked for, but there is nothing left to say it to, and no timer
        // may outlive the component.
        if (mounted.current) {
          setStarted(true);
          timer.current = setTimeout(() => {
            timer.current = undefined;
            inFlight.current = false;
            setStarted(false);
          }, DOWNLOAD_STARTED_MS);
        }
      } catch (e) {
        // The reader gets copy; the console gets the detail (status and
        // route, or the guard's refusal), so a retry that keeps failing the
        // same way is diagnosable.
        logRequestFailure(e, 'file download');
        setError(downloadFailureMessage(e, agentName));
      } finally {
        if (!handedOver) inFlight.current = false;
        setBusy(false);
      }
    })();
  }, [agentId, agentName, path]);

  return { start, busy, started, error };
}
