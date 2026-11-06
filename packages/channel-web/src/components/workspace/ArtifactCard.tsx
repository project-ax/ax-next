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
import type { ThreadArtifact } from '@/lib/workspace-types';
import { KIND_ICONS } from './AgentArtifacts';
import { ShareLinkDialog } from './ShareLinkDialog';

export function ArtifactCard({ artifact, onOpen }: {
  artifact: ThreadArtifact;
  onOpen(artifactId: string): void;
}) {
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

  return (
    <Card className="flex-row items-center gap-3 p-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{artifact.title}</div>
        <div className="truncate text-xs text-muted-foreground">{artifactTypeLine(artifact)}</div>
      </div>
      <Button size="sm" onClick={() => onOpen(artifact.artifactId)}>Open</Button>
      <Button size="sm" variant="outline" disabled={copying} onClick={() => void copyLink()}>Copy link</Button>
      <ShareLinkDialog url={manualUrl} onClose={() => setManualUrl(null)} />
    </Card>
  );
}
