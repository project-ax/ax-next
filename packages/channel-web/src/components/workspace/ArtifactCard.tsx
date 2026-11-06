/**
 * A published artifact, drawn in the turn that published it: name, "Type · EXT",
 * Open (the wide viewer, owned by AgentView) and Copy link. The title is
 * untrusted text and only ever a text child.
 */
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { artifactTypeLine } from '@/lib/artifact-labels';
import { copyShareLink } from '@/lib/copy-share-link';
import { saveFromContentOrigin } from '@/lib/file-download';
import { logRequestFailure } from '@/lib/http';
import { toastActions } from '@/lib/toast-store';
import { workspaceApi } from '@/lib/workspace-api';
import type { ThreadArtifact } from '@/lib/workspace-types';
import { KIND_ICONS } from './AgentArtifacts';
import { ShareLinkDialog } from './ShareLinkDialog';

/**
 * `onOpen` is absent on surfaces with no viewer (the check-in page): the card
 * then offers Download instead of Open, so the deliverable is never hidden.
 */
export function ArtifactCard({ artifact, onOpen }: {
  artifact: ThreadArtifact;
  onOpen?: ((artifactId: string) => void) | undefined;
}) {
  const [downloading, setDownloading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const Icon = KIND_ICONS[artifact.kind];

  async function copyLink() {
    if (copying) return;
    setCopying(true);
    try {
      // Called synchronously from the click: Safari needs the gesture.
      const outcome = await copyShareLink(artifact.artifactId);
      if (outcome.kind === 'manual') setManualUrl(outcome.url);
    } finally {
      setCopying(false);
    }
  }

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
    <Card className="flex-row items-center gap-3 p-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{artifact.title}</div>
        <div className="truncate text-xs text-muted-foreground">{artifactTypeLine(artifact)}</div>
      </div>
      {onOpen !== undefined
        ? <Button size="sm" onClick={() => onOpen(artifact.artifactId)}>Open</Button>
        : <Button size="sm" disabled={downloading} onClick={() => void download()}>Download</Button>}
      <Button size="sm" variant="outline" disabled={copying} onClick={() => void copyLink()}>Copy link</Button>
      <ShareLinkDialog url={manualUrl} onClose={() => setManualUrl(null)} />
    </Card>
  );
}
