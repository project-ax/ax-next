/**
 * A published artifact, drawn in the turn that published it: icon, name and
 * "Type · EXT". The whole card is the control — one click opens it in the side
 * panel (the viewer, owned by AgentView), where Download and Copy link live.
 * The title is untrusted text and only ever a text child.
 */
import { useState } from 'react';
import { ChevronRight, Download } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { artifactTypeLine } from '@/lib/artifact-labels';
import { saveFromContentOrigin } from '@/lib/file-download';
import { logRequestFailure } from '@/lib/http';
import { toastActions } from '@/lib/toast-store';
import { workspaceApi } from '@/lib/workspace-api';
import type { ThreadArtifact } from '@/lib/workspace-types';
import { KIND_ICONS } from './AgentArtifacts';

/**
 * `onOpen` is absent on surfaces with no viewer (the check-in page): a click
 * then downloads instead, so the deliverable is never hidden.
 */
export function ArtifactCard({ artifact, onOpen }: {
  artifact: ThreadArtifact;
  onOpen?: ((artifactId: string) => void) | undefined;
}) {
  const [downloading, setDownloading] = useState(false);
  const Icon = KIND_ICONS[artifact.kind];

  async function download() {
    if (downloading) return;
    setDownloading(true);
    try {
      saveFromContentOrigin((await workspaceApi.artifactToken(artifact.artifactId, artifact.version, 'download')).url);
    } catch (e) {
      logRequestFailure(e, 'artifact-download');
      toastActions.error('That download didn’t start, so nothing was saved. Try again in a moment.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <button
      type="button"
      disabled={downloading}
      onClick={() => (onOpen !== undefined ? onOpen(artifact.artifactId) : void download())}
      className="group flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left text-card-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{artifact.title}</span>
        <span className="truncate text-xs text-muted-foreground">{artifactTypeLine(artifact)}</span>
      </span>
      {downloading ? (
        <Spinner className="size-4 shrink-0 text-muted-foreground" />
      ) : onOpen !== undefined ? (
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      ) : (
        <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
    </button>
  );
}
