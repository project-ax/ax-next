/**
 * One artifact version, drawn for reading. The owner's viewer and the share
 * page both use it.
 *
 * WHAT IT DRAWS IS UNTRUSTED (I5, spec §6.5). An agent wrote these bytes, and
 * an agent can be talked into anything by what it read. So:
 *
 *   - HTML is never put into this document. It loads in an iframe from a
 *     minted address on the CONTENT origin — a different site — with
 *     `sandbox="allow-scripts allow-downloads"`. Never `allow-same-origin`
 *     (the page would get an origin it could use), never
 *     `allow-top-navigation` (it could navigate this tab to a look-alike
 *     sign-in page). No referrer, and no `message` listener here at all:
 *     there is no channel for the page to talk back on.
 *   - Images load from the same kind of address, with no referrer.
 *   - Markdown goes through `Markdown`: no raw HTML, images as alt text,
 *     unsafe links blanked.
 *   - Text is text, in a `<pre>`.
 *   - PDFs and anything else are not previewed (D11) — Download only.
 *
 * Tokens live five minutes, so one is minted every time this mounts (or the
 * version changes, which hands us a new `loadToken`): an iframe opened later
 * never reuses an expired address.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Markdown } from '@/components/Markdown';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { checkContentOriginUrl } from '@/lib/file-download';
import { logRequestFailure } from '@/lib/http';
import type { ArtifactPreviewKind } from '@/lib/workspace-types';

/** Exactly these two, nothing more (§6.5). Pinned by the "iframe sandbox and referrer policy" test. */
const IFRAME_SANDBOX = 'allow-scripts allow-downloads';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed' };

/** Run `load` on mount and whenever it changes; the latest call wins. */
function useLoad<T>(load: () => Promise<T>, context: string): [Load<T>, () => void] {
  const [result, setResult] = useState<Load<T>>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0);
  useEffect(() => {
    const id = ++request.current;
    setResult({ state: 'loading' });
    load().then(
      (value) => {
        if (request.current === id) setResult({ state: 'ready', value });
      },
      (e: unknown) => {
        if (request.current !== id) return;
        logRequestFailure(e, context);
        setResult({ state: 'failed' });
      },
    );
    return () => {
      request.current++;
    };
  }, [load, attempt, context]);
  return [result, useCallback(() => setAttempt((n) => n + 1), [])];
}

function Loading() {
  return (
    <div className="flex flex-1 flex-col gap-2 py-2" role="status">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-full min-h-[240px] w-full" />
    </div>
  );
}

function Failed({ retry }: { retry: () => void }) {
  return (
    <Alert className="mt-2">
      <AlertDescription className="flex flex-col items-start gap-2">
        <span>We couldn’t open this just now. Nothing was lost.</span>
        <Button size="sm" variant="outline" type="button" onClick={retry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function DownloadOnly({ title, description, onDownload }: { title: string; description: string; onDownload(): void }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button type="button" variant="outline" onClick={onDownload}>
          <Download data-icon="inline-start" aria-hidden />
          Download
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function FromContentOrigin({
  preview,
  title,
  loadToken,
}: {
  preview: 'html' | 'image';
  title: string;
  loadToken(purpose: 'view'): Promise<{ url: string }>;
}) {
  // A minted address is checked before it is used: content origin, /v/, never
  // the app's own origin. Anything else fails closed into the error state.
  const load = useCallback(async () => {
    const token = await loadToken('view');
    checkContentOriginUrl(token.url, 'view');
    return token;
  }, [loadToken]);
  const [token, retry] = useLoad(load, 'artifact-view-token');
  if (token.state === 'loading') return <Loading />;
  if (token.state === 'failed') return <Failed retry={retry} />;
  if (preview === 'image') {
    return (
      <div className="flex flex-1 items-start justify-center py-2">
        <img src={token.value.url} alt={title} referrerPolicy="no-referrer" className="h-auto max-w-full rounded-md" />
      </div>
    );
  }
  return (
    <iframe
      src={token.value.url}
      sandbox={IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      title={title}
      className="min-h-[480px] w-full flex-1 rounded-md border border-border bg-background"
    />
  );
}

function AsText({
  preview,
  loadText,
}: {
  preview: 'markdown' | 'text';
  loadText(): Promise<{ text: string; truncated: boolean }>;
}) {
  const [text, retry] = useLoad(loadText, 'artifact-text');
  if (text.state === 'loading') return <Loading />;
  if (text.state === 'failed') return <Failed retry={retry} />;
  return (
    <div className="flex flex-col gap-2 py-2">
      {text.value.truncated && (
        <p className="text-[12px] text-muted-foreground">Showing the beginning of this file.</p>
      )}
      {preview === 'markdown' ? (
        <Markdown text={text.value.text} />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-foreground">{text.value.text}</pre>
      )}
    </div>
  );
}

export function ArtifactPreview({
  preview,
  title,
  loadToken,
  loadText,
  onDownload,
}: {
  preview: ArtifactPreviewKind;
  title: string;
  loadToken(purpose: 'view' | 'download'): Promise<{ url: string }>;
  loadText(): Promise<{ text: string; truncated: boolean }>;
  onDownload(): void;
}) {
  switch (preview) {
    case 'html':
    case 'image':
      return <FromContentOrigin preview={preview} title={title} loadToken={loadToken} />;
    case 'markdown':
    case 'text':
      return <AsText preview={preview} loadText={loadText} />;
    case 'pdf':
      return (
        <DownloadOnly
          title="Download to open"
          description="PDFs open in your own viewer, not in here."
          onDownload={onDownload}
        />
      );
    default:
      return (
        <DownloadOnly
          title="We can’t preview this one yet"
          description="Download it to open it in the app it was made for."
          onDownload={onDownload}
        />
      );
  }
}
