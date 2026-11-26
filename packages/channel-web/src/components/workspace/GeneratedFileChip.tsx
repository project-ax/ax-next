import { useEffect, useRef, useState } from 'react';
import { FileTile, Notice, Stack } from '@project-ax/ui';
import { clampFileName } from '@/lib/attachment-name';
import { DOWNLOAD_STARTED_MS, DOWNLOAD_STARTED_NOTE, saveBlob, saveFromUrl } from '@/lib/file-download';
import { httpFetch, HttpError, logRequestFailure } from '@/lib/http';
import { FALLBACK_SAVED_FILENAME, filenameFromContentDisposition } from '@/lib/workspace-api';
import type { ThreadAttachment } from '@/lib/workspace-types';

/**
 * Durable outputs use conversation-scoped downloads, never model-authored URLs.
 * A published or attached file is fetched by its attachment id within this
 * conversation. A file the agent left in its files is fetched live by its key
 * through the conversation's own route, which derives the agent from the
 * conversation and reads the file as it is now (TASK-1012). On a click, an
 * agent file is asked about first (`?probe=1`) and then saved by the
 * browser's own download, straight to disk, while an attachment is still
 * fetched in-page (TASK-1022). After either hand-over the chip says the
 * download started and ignores clicks for a few seconds (TASK-1025), because
 * the browser's own bar is the only other sign that anything happened.
 *
 * The agent can delete that file in a later turn, so an agent-file chip asks
 * whether it is still there (TASK-1017): when it mounts, and again whenever
 * `recheckKey` changes. The conversation's status route answers without
 * reading the file. ONLY a 404 or a 400, the answers a download gives for a
 * file that is gone or a key that is a folder now, make the chip say "No
 * longer available". Anything else (storage slow or down, no network, an
 * ended session) leaves it downloadable, because "we could not tell" is never
 * "it is gone". A 200 makes it downloadable again: the chip names a key, and
 * a download serves whatever is there now.
 *
 * Drawn as a `FileTile` chip: the whole chip is the Download button. While a
 * download is being fetched it is busy (it keeps focus and ignores clicks);
 * in the started window it stays a button and the click is ignored here.
 * Its second line is one polite live region, so "Downloading…", "Download
 * started" and "No longer available" are announced as they change.
 */
export function GeneratedFileChip({ file, conversationId, recheckKey }: {
  file: ThreadAttachment;
  conversationId: string;
  /** Changes when the thread is re-read or a turn fails, so an agent-file chip checks its file again. */
  recheckKey?: number;
}) {
  const name = clampFileName(file.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [started, setStarted] = useState(false);
  // Held from the click until the started window closes; a refusal releases
  // it at once. It is what ignores a click in the started window: the chip
  // stays a focusable button there, so nothing else stops one.
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
  const size = typeof file.sizeBytes === 'number' && file.sizeBytes >= 0 ? file.sizeBytes : undefined;

  const agentFilePath = file.agentFilePath;
  useEffect(() => {
    if (agentFilePath === undefined) return undefined;
    const controller = new AbortController();
    void (async () => {
      let url: string;
      try {
        // Built here, never in render: encodeURIComponent throws on a malformed key.
        url = `/api/workspace/conversations/${encodeURIComponent(conversationId)}/status/user-files/${encodeURIComponent(agentFilePath)}`;
      } catch {
        return;
      }
      let status: number;
      try {
        status = (await httpFetch(url, { signal: controller.signal })).status;
      } catch {
        return;
      }
      // A check this chip has moved on from, answering late: the newest decides.
      if (controller.signal.aborted) return;
      if (status === 404 || status === 400) {
        setGone(true);
        // "Try again" beside a button that cannot be pressed is a dead end.
        setError(null);
      } else if (status === 200) {
        setGone(false);
      }
    })();
    return () => controller.abort();
  }, [agentFilePath, conversationId, recheckKey]);

  // Whether there is anything to download. The URL itself is built on click:
  // encodeURIComponent throws on a malformed key, and that must not crash render.
  const downloadable = !gone && (file.agentFilePath !== undefined || file.attachmentId !== null);

  function downloadUrl(): string {
    if (file.agentFilePath !== undefined) {
      return `/api/workspace/conversations/${encodeURIComponent(conversationId)}/download/user-files/${encodeURIComponent(file.agentFilePath)}`;
    }
    return `/api/files?conversationId=${encodeURIComponent(conversationId)}&id=${encodeURIComponent(file.attachmentId ?? '')}`;
  }

  async function download() {
    if (inFlight.current || !downloadable) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    let handedOver = false;
    try {
      const url = downloadUrl();
      if (file.agentFilePath !== undefined) {
        // Ask the route first: a refusal is said here, in words, which the
        // browser's download bar cannot do. On a yes the browser downloads
        // the route itself, so none of the file comes into the tab.
        const probe = await httpFetch(`${url}?probe=1`);
        if (!probe.ok) throw new HttpError(url, probe.status);
        // The yes is all we need. Cancel the rest: a host too old to know
        // `?probe` would be sending the whole file into a body nobody reads.
        void probe.body?.cancel().catch(() => undefined);
        saveFromUrl(url);
        handedOver = true;
      } else {
        const response = await httpFetch(url);
        if (!response.ok) throw new HttpError(url, response.status);
        saveBlob(await response.blob(),
          filenameFromContentDisposition(response.headers.get('content-disposition')) ?? FALLBACK_SAVED_FILENAME);
        handedOver = true;
      }
      // Nothing is left to say it to if the chip is gone, and no timer may outlive it.
      if (mounted.current) {
        setStarted(true);
        timer.current = setTimeout(() => {
          timer.current = undefined;
          inFlight.current = false;
          setStarted(false);
        }, DOWNLOAD_STARTED_MS);
      }
    } catch (e) {
      logRequestFailure(e, 'file chip download');
      const status = e instanceof HttpError ? e.status : null;
      // 400 on an agent file means its key is a folder now: gone, like a 404.
      setError(status === 404 || (status === 400 && file.agentFilePath !== undefined)
        ? 'This file is no longer available to download.'
        : status === 413
          ? 'This file is too big for us to download. Ask the agent for a smaller copy, or to split it up.'
          : status === 403
            ? 'This account does not have access to that file.'
            : 'We could not download this file just now. Try again.');
    } finally {
      if (!handedOver) inFlight.current = false;
      setBusy(false);
    }
  }

  // The size shows beside "Download" only; a passing state says just itself.
  // A file with no address to download by has no action and no "Download".
  const idle = !busy && !gone && !started;
  const detail = busy ? 'Downloading…'
    : gone ? 'No longer available'
      : started ? DOWNLOAD_STARTED_NOTE
        : downloadable ? 'Download' : undefined;

  return (
    <Stack gap="sm" align="start">
      <FileTile
        variant="chip"
        name={name}
        kind={file.mediaType}
        actionLabel="Download"
        status={busy ? 'working' : 'ready'}
        {...(idle && size !== undefined ? { size } : {})}
        {...(detail !== undefined ? { detail } : {})}
        {...(downloadable ? { onOpen: () => void download() } : {})}
      />
      {error !== null && <Notice tone="danger">{error}</Notice>}
    </Stack>
  );
}
