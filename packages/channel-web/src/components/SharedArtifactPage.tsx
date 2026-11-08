/**
 * The share page, `/a/<code>` (spec §6.1): one artifact, full page, for a
 * signed-in teammate holding its link.
 *
 * The name, who made it and when, the same preview the owner sees
 * (`ArtifactPreview`, fed by the link's own routes), Download, and a small
 * "Made with AI by a teammate". Deliberately nothing else: no version picker
 * (a link shows the current version only), no chat, no list, no owner menu.
 *
 * What it draws is untrusted (I5): the title is text, and the preview carries
 * its own rules (sandboxed frame from the content origin, no referrer). The
 * code is a capability (§6.3): it is only ever in a request address here, and
 * `shared-artifacts-api` keeps it out of every error and log line.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { saveFromContentOrigin } from '@/lib/file-download';
import { HttpError, logRequestFailure } from '@/lib/http';
import { sharedArtifactsApi } from '@/lib/shared-artifacts-api';
import { useResolvedTheme } from '@/lib/theme';
import { toastActions } from '@/lib/toast-store';
import { timeAgo } from '@/lib/workspace-time';
import { artifactPreviewKind, type ArtifactTokenPurpose, type SharedArtifactView } from '@/lib/workspace-types';
import { ArtifactPreview } from './workspace/ArtifactPreview';
import { DOWNLOAD_FAILED } from './workspace/ArtifactViewer';

export const LINK_DEAD = "This link doesn't work anymore — ask whoever sent it for a fresh one.";
export const LINK_RATE_LIMITED = 'Too many tries — wait a minute and try again.';
const LINK_FAILED = 'We couldn’t open this just now. Nothing was lost.';

type PageState =
  | { status: 'loading' }
  | { status: 'ready'; artifact: SharedArtifactView }
  | { status: 'dead' }
  | { status: 'rate-limited' }
  | { status: 'failed' };

function useSharedArtifact(code: string): [PageState, () => void] {
  const [state, setState] = useState<PageState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0);
  useEffect(() => {
    const id = ++request.current;
    setState({ status: 'loading' });
    sharedArtifactsApi.artifact(code).then(
      (artifact) => {
        if (request.current === id) setState({ status: 'ready', artifact });
      },
      (e: unknown) => {
        if (request.current !== id) return;
        logRequestFailure(e, 'shared-artifact');
        if (e instanceof HttpError && e.status === 404) setState({ status: 'dead' });
        else if (e instanceof HttpError && e.status === 429) setState({ status: 'rate-limited' });
        else setState({ status: 'failed' });
      },
    );
    return () => {
      request.current++;
    };
  }, [code, attempt]);
  return [state, useCallback(() => setAttempt((n) => n + 1), [])];
}

function Notice({ text, retry }: { text: string; retry?: () => void }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>{text}</EmptyTitle>
      </EmptyHeader>
      {retry && (
        <EmptyContent>
          <Button type="button" variant="outline" onClick={retry}>
            Try again
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

function Shared({ code, artifact }: { code: string; artifact: SharedArtifactView }) {
  const [downloading, setDownloading] = useState(false);
  const inFlight = useRef(false);

  const theme = useResolvedTheme();
  const loadToken = useCallback(
    (purpose: ArtifactTokenPurpose) =>
      purpose === 'view' ? sharedArtifactsApi.token(code, purpose, theme) : sharedArtifactsApi.token(code, purpose),
    [code, theme],
  );
  const loadText = useCallback(() => sharedArtifactsApi.text(code), [code]);

  const download = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setDownloading(true);
    void (async () => {
      try {
        saveFromContentOrigin((await loadToken('download')).url);
      } catch (e) {
        logRequestFailure(e, 'shared-artifact-download');
        toastActions.error(DOWNLOAD_FAILED);
      } finally {
        inFlight.current = false;
        setDownloading(false);
      }
    })();
  }, [loadToken]);

  const when = timeAgo(artifact.updatedAt) ?? 'a while ago';
  return (
    <>
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="truncate text-xl font-semibold text-foreground">{artifact.title}</h1>
          <p className="text-sm text-muted-foreground">
            Made by {artifact.agentName ?? 'an agent'} · updated {when}
          </p>
        </div>
        <Button type="button" variant="outline" disabled={downloading} onClick={download}>
          {downloading ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" aria-hidden />}
          Download
        </Button>
      </header>
      <Separator />
      <main className="flex min-h-0 flex-1 flex-col">
        <ArtifactPreview
          preview={artifactPreviewKind(artifact.preview)}
          title={artifact.title}
          loadToken={loadToken}
          loadText={loadText}
          onDownload={download}
        />
      </main>
      <p className="text-center text-xs text-muted-foreground">Made with AI by a teammate</p>
    </>
  );
}

export function SharedArtifactPage({ code }: { code: string }) {
  const [state, retry] = useSharedArtifact(code);
  return (
    <div className="flex min-h-screen flex-col bg-background font-sans text-foreground">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6">
        {state.status === 'loading' && (
          <div className="flex flex-1 flex-col gap-3" role="status">
            <span className="sr-only">Loading…</span>
            <Skeleton className="h-7 w-1/3" />
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="min-h-[480px] w-full flex-1" />
          </div>
        )}
        {state.status === 'ready' && <Shared code={code} artifact={state.artifact} />}
        {state.status === 'dead' && <Notice text={LINK_DEAD} />}
        {state.status === 'rate-limited' && <Notice text={LINK_RATE_LIMITED} retry={retry} />}
        {state.status === 'failed' && <Notice text={LINK_FAILED} retry={retry} />}
      </div>
    </div>
  );
}
