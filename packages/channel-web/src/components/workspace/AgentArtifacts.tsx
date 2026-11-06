/**
 * The agent's artifacts: a compact list of the finished things it made for you
 * (reports, pages, spreadsheets). List only — opening one is the parent's job
 * (`onOpen`), so the chat's artifact card can open the same viewer.
 *
 * Each row has an icon square (the slot a thumbnail will fill later), the
 * title, and "Type · EXT" underneath.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Code2,
  Download,
  File,
  FileText,
  Globe,
  Image as ImageIcon,
  Sheet as SheetIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ArtifactKind } from '@ax/ipc-protocol/content-blocks';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { artifactTypeLine } from '@/lib/artifact-labels';
import { DOWNLOAD_STARTED_MS, DOWNLOAD_STARTED_NOTE, saveFromUrl } from '@/lib/file-download';
import { logRequestFailure } from '@/lib/http';
import { useAgentArtifacts } from '@/lib/use-agent-artifacts';
import { ArtifactsDownloadRefused, workspaceApi } from '@/lib/workspace-api';
import type { ArtifactSummary } from '@/lib/workspace-types';

export const KIND_ICONS: Record<ArtifactKind, LucideIcon> = {
  document: FileText,
  web: Globe,
  spreadsheet: SheetIcon,
  image: ImageIcon,
  code: Code2,
  file: File,
};

const FAILED_NOTE = 'That download didn’t start, so nothing was saved. Try again in a moment.';
const BUSY_NOTE = 'One download at a time, please — try again in a moment.';
const TOO_BIG_NOTE = 'That’s too much to bundle at once — download them one at a time.';

/** What a refused Download all says: the server's own sentence, else one by status. */
function downloadNote(e: unknown): string {
  if (e instanceof ArtifactsDownloadRefused) {
    if (e.serverMessage !== null) return e.serverMessage;
    if (e.status === 429) return BUSY_NOTE;
    if (e.status === 413) return TOO_BIG_NOTE;
  }
  return FAILED_NOTE;
}

function ArtifactRow({ artifact, onOpen }: { artifact: ArtifactSummary; onOpen: () => void }) {
  const Icon = KIND_ICONS[artifact.kind];
  const line = artifactTypeLine(artifact);
  return (
    <Button
      variant="ghost"
      type="button"
      onClick={onOpen}
      title={artifact.title}
      className="h-auto w-full justify-start gap-3 overflow-hidden rounded-sm px-2.5 py-2 text-left font-normal hover:bg-muted"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon size={16} aria-hidden />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] text-foreground">{artifact.title}</span>
        <span className="truncate text-[12px] text-muted-foreground">{line}</span>
      </span>
    </Button>
  );
}

export function AgentArtifacts({
  agentId,
  agentName,
  onOpen,
}: {
  agentId: string;
  agentName: string;
  onOpen(artifactId: string): void;
}) {
  const { status, artifacts, reload } = useAgentArtifacts(agentId);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = workspaceApi.artifactsDownloadAllUrl(agentId);
  // Written synchronously, so two clicks in one frame start one download.
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  // A note is about the list it was shown over; a reload or another agent clears it.
  useEffect(() => {
    setNote(null);
  }, [agentId, status]);

  /*
    The link stays a real link (middle-click, "save link as"), but a plain click
    asks the route first (`?probe=1`): a refusal arrives as JSON with its own
    sentence, which a browser download bar would only call "Failed". On a yes the
    BROWSER takes the download (it streams to disk, the tab never holds the zip,
    and the name comes from the server's Content-Disposition).
  */
  function downloadAll(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNote(null);
    void (async () => {
      let handedOver = false;
      try {
        saveFromUrl(await workspaceApi.probeArtifactsDownload(agentId));
        handedOver = true;
        if (mounted.current) {
          setNote(DOWNLOAD_STARTED_NOTE);
          timer.current = setTimeout(() => {
            timer.current = undefined;
            inFlight.current = false;
            setNote(null);
          }, DOWNLOAD_STARTED_MS);
        }
      } catch (err) {
        logRequestFailure(err, 'artifacts-download-all');
        if (mounted.current) setNote(downloadNote(err));
      } finally {
        if (!handedOver) inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    })();
  }

  if (status === 'loading') {
    return (
      <div className="space-y-2 py-2" role="status">
        <span className="sr-only">Loading…</span>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <Alert className="mt-2">
        <AlertDescription className="flex flex-col items-start gap-2">
          <span>We couldn’t load {agentName}’s artifacts just now. Nothing was lost.</span>
          <Button size="sm" variant="outline" type="button" onClick={reload}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (artifacts.length === 0) {
    return (
      <Empty className="p-3 md:p-3">
        <EmptyHeader>
          <EmptyDescription>
            Ask your agent to make you a report, page or spreadsheet — it’ll show up here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div>
      <div className="flex justify-end pb-1">
        <Button asChild variant="ghost" size="sm" className="gap-1.5 text-[12px] text-muted-foreground">
          <a href={url} download="" aria-disabled={busy} onClick={downloadAll}>
            <Download size={13} aria-hidden />
            Download all
          </a>
        </Button>
      </div>
      {note !== null && (
        <Alert className="mb-2" role="status">
          <AlertDescription>{note}</AlertDescription>
        </Alert>
      )}
      <ul className="flex flex-col gap-0.5">
        {artifacts.map((a) => (
          <li key={a.artifactId}>
            <ArtifactRow artifact={a} onOpen={() => onOpen(a.artifactId)} />
          </li>
        ))}
      </ul>
    </div>
  );
}
