/**
 * A published artifact, drawn in the turn that published it: icon, name and
 * "Type · EXT". The whole card is the control — one click opens it in the side
 * panel (the viewer, owned by AgentView), where Download and Copy link live.
 * The title is untrusted text and only ever a text child.
 */
import { useState } from 'react';
import { FileTile, toast } from '@project-ax/ui';
import { artifactTypeLine } from '@/lib/artifact-labels';
import { saveFromContentOrigin } from '@/lib/file-download';
import { logRequestFailure } from '@/lib/http';
import { workspaceApi } from '@/lib/workspace-api';
import type { ThreadArtifact } from '@/lib/workspace-types';

/**
 * `onOpen` is absent on surfaces with no viewer (the check-in page): a click
 * then downloads instead, so the deliverable is never hidden. While the
 * download link is minted the card is busy: it keeps focus and ignores clicks.
 */
export function ArtifactCard({ artifact, onOpen }: {
  artifact: ThreadArtifact;
  onOpen?: ((artifactId: string) => void) | undefined;
}) {
  const [downloading, setDownloading] = useState(false);

  async function download() {
    if (downloading) return;
    setDownloading(true);
    try {
      saveFromContentOrigin((await workspaceApi.artifactToken(artifact.artifactId, artifact.version, 'download')).url);
    } catch (e) {
      logRequestFailure(e, 'artifact-download');
      toast.show({ title: 'That download didn’t start, so nothing was saved. Try again in a moment.', tone: 'danger' });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <FileTile
      variant="card"
      name={artifact.title}
      kind={artifact.extension}
      detail={artifactTypeLine(artifact)}
      actionLabel={onOpen !== undefined ? 'Open' : 'Download'}
      onOpen={() => (onOpen !== undefined ? onOpen(artifact.artifactId) : void download())}
      {...(downloading ? { status: 'working' as const } : {})}
    />
  );
}
