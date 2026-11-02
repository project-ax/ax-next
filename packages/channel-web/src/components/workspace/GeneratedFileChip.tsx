import { useEffect, useRef, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { clampAttachmentName } from '@/lib/attachment-name';
import { saveBlob } from '@/lib/file-download';
import { httpFetch, HttpError } from '@/lib/http';
import { filenameFromContentDisposition } from '@/lib/workspace-api';
import type { ThreadAttachment } from '@/lib/workspace-types';

/**
 * Durable outputs use conversation-scoped downloads, never model-authored URLs.
 * A published or attached file is fetched by its attachment id within this
 * conversation. A file the agent left in its files is fetched live by its key
 * through the conversation's own route, which derives the agent from the
 * conversation and reads the file as it is now (TASK-1012).
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
 */
export function GeneratedFileChip({ file, conversationId, recheckKey }: {
  file: ThreadAttachment;
  conversationId: string;
  /** Changes when the thread is re-read or a turn fails, so an agent-file chip checks its file again. */
  recheckKey?: number;
}) {
  const extension = /\.[a-z0-9]{1,12}$/i.exec(file.displayName)?.[0] ?? '';
  const stem = clampAttachmentName(extension.length > 0
    ? file.displayName.slice(0, -extension.length) : file.displayName);
  const name = stem + extension;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const inFlight = useRef(false);
  const size = typeof file.sizeBytes === 'number' && file.sizeBytes >= 0
    ? file.sizeBytes < 1024 ? `${file.sizeBytes} B`
      : file.sizeBytes < 1024 * 1024 ? `${(file.sizeBytes / 1024).toFixed(1)} KB`
        : `${(file.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
    : null;

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
    try {
      const response = await httpFetch(downloadUrl());
      if (!response.ok) throw new HttpError('file download', response.status);
      saveBlob(await response.blob(),
        filenameFromContentDisposition(response.headers.get('content-disposition')) ?? 'download');
    } catch (e) {
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
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full max-w-xs flex-col gap-2">
      <Button type="button" variant="outline" disabled={busy || !downloadable}
        aria-label={busy ? `Downloading ${name}` : gone ? `${name} is no longer available` : `Download ${name}`}
        aria-busy={busy} onClick={() => void download()}
        className="h-auto min-h-11 w-full justify-start gap-3 px-3 py-2 text-left">
        <FileText data-icon="inline-start" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0">
            <span className="truncate">{stem}</span>
            {extension.length > 0 && <span className="shrink-0">{extension}</span>}
          </span>
          <span className="text-xs font-normal text-muted-foreground" aria-live="polite">
            {busy ? 'Downloading…'
              : gone ? 'No longer available'
                : [size, 'Download'].filter(Boolean).join(' · ')}
          </span>
        </span>
        {busy ? <Spinner data-icon="inline-end" aria-hidden="true" />
          : !gone && <Download data-icon="inline-end" aria-hidden="true" />}
      </Button>
      {error !== null && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    </div>
  );
}
