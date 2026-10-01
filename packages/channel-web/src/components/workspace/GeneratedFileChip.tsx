import { useRef, useState } from 'react';
import { Download, FileText, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { clampAttachmentName } from '@/lib/attachment-name';
import { saveBlob } from '@/lib/file-download';
import { httpFetch, HttpError } from '@/lib/http';
import { filenameFromContentDisposition } from '@/lib/workspace-api';
import type { ThreadAttachment } from '@/lib/workspace-types';

/** Durable outputs use conversation-scoped downloads, never model-authored URLs. */
export function GeneratedFileChip({ file, conversationId }: {
  file: ThreadAttachment;
  conversationId: string;
}) {
  const extension = /\.[a-z0-9]{1,12}$/i.exec(file.displayName)?.[0] ?? '';
  const stem = clampAttachmentName(extension.length > 0
    ? file.displayName.slice(0, -extension.length) : file.displayName);
  const name = stem + extension;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const size = typeof file.sizeBytes === 'number' && file.sizeBytes >= 0
    ? file.sizeBytes < 1024 ? `${file.sizeBytes} B`
      : file.sizeBytes < 1024 * 1024 ? `${(file.sizeBytes / 1024).toFixed(1)} KB`
        : `${(file.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
    : null;

  async function download() {
    if (inFlight.current || file.path === null) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await httpFetch(
        `/api/files?path=${encodeURIComponent(file.path)}&conversationId=${encodeURIComponent(conversationId)}`,
      );
      if (!response.ok) throw new HttpError('file download', response.status);
      saveBlob(await response.blob(),
        filenameFromContentDisposition(response.headers.get('content-disposition')) ?? 'download');
    } catch (e) {
      setError(e instanceof HttpError && e.status === 404
        ? 'This file is no longer available to download.'
        : e instanceof HttpError && e.status === 403
          ? 'This account does not have access to that file.'
          : 'We could not download this file just now. Try again.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full max-w-xs flex-col gap-2">
      <Button type="button" variant="outline" disabled={busy || file.path === null}
        aria-label={`${busy ? 'Downloading' : 'Download'} ${name}`}
        aria-busy={busy} onClick={() => void download()}
        className="h-auto min-h-11 w-full justify-start gap-3 px-3 py-2 text-left">
        <FileText data-icon="inline-start" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0">
            <span className="truncate">{stem}</span>
            {extension.length > 0 && <span className="shrink-0">{extension}</span>}
          </span>
          <span className="text-xs font-normal text-muted-foreground" aria-live="polite">
            {busy ? 'Downloading…' : [size, 'Download'].filter(Boolean).join(' · ')}
          </span>
        </span>
        {busy ? <LoaderCircle data-icon="inline-end" className="animate-spin" aria-hidden="true" />
          : <Download data-icon="inline-end" aria-hidden="true" />}
      </Button>
      {error !== null && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    </div>
  );
}
