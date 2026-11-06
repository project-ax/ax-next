/**
 * The agent's artifacts: a compact list of the finished things it made for you
 * (reports, pages, spreadsheets). List only — opening one is the parent's job
 * (`onOpen`), so the chat's artifact card can open the same viewer.
 *
 * Each row has an icon square (the slot a thumbnail will fill later), the
 * title, and "Type · EXT" underneath.
 */
import { useState } from 'react';
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
import { artifactTypeLabel } from '@/lib/artifact-labels';
import { saveBlob } from '@/lib/file-download';
import { httpFetch, logRequestFailure } from '@/lib/http';
import { useAgentArtifacts } from '@/lib/use-agent-artifacts';
import { workspaceApi } from '@/lib/workspace-api';
import type { ArtifactSummary } from '@/lib/workspace-types';

const KIND_ICONS: Record<ArtifactKind, LucideIcon> = {
  document: FileText,
  web: Globe,
  spreadsheet: SheetIcon,
  image: ImageIcon,
  code: Code2,
  file: File,
};

const BUSY_NOTE = 'One download at a time, please — try again in a moment.';
const FAILED_NOTE = 'That download didn’t start, so nothing was saved. Try again in a moment.';

function ArtifactRow({ artifact, onOpen }: { artifact: ArtifactSummary; onOpen: () => void }) {
  const Icon = KIND_ICONS[artifact.kind];
  const line =
    artifact.extension === ''
      ? artifactTypeLabel(artifact.kind)
      : `${artifactTypeLabel(artifact.kind)} · ${artifact.extension}`;
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
  const url = workspaceApi.artifactsDownloadAllUrl(agentId);

  /*
    The link stays a real link (middle-click, "save link as"), but a plain click
    asks first: a refusal (429 one-at-a-time, 413 too much) arrives as JSON with
    its own sentence, and a browser download bar would only say "Failed".
  */
  async function downloadAll(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    setNote(null);
    try {
      const res = await httpFetch(url);
      if (res.ok) {
        saveBlob(await res.blob(), `${agentName} artifacts.zip`);
        return;
      }
      let message: string | null = null;
      try {
        const body: unknown = await res.json();
        if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') {
          message = body.message;
        }
      } catch {
        // not JSON: fall through to our own sentence
      }
      setNote(message ?? (res.status === 429 ? BUSY_NOTE : FAILED_NOTE));
    } catch (err) {
      logRequestFailure(err, 'artifacts-download-all');
      setNote(FAILED_NOTE);
    }
  }

  if (status === 'loading') {
    return (
      <div className="space-y-2 py-2" aria-label="Loading artifacts">
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
          <a href={url} download onClick={(e) => void downloadAll(e)}>
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
      <div className="flex flex-col gap-0.5">
        {artifacts.map((a) => (
          <ArtifactRow key={a.artifactId} artifact={a} onOpen={() => onOpen(a.artifactId)} />
        ))}
      </div>
    </div>
  );
}
