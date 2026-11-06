/**
 * One artifact, open beside the chat: its preview, its versions, and the
 * owner's controls. `AgentView` owns which artifact is open (P7); this draws it.
 *
 * Header: ‹ Back, the name and type, ✕; then the version picker (with
 * "Restore this version" while an older one is picked), Download, Copy link
 * and the ⋯ menu.
 *
 * No `message` listener and no `postMessage` anywhere here (§6.5): the page in
 * the frame has nobody to talk to.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Download, Link as LinkIcon, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { artifactTypeLine } from '@/lib/artifact-labels';
import { copyShareLink } from '@/lib/copy-share-link';
import { saveFromContentOrigin } from '@/lib/file-download';
import { logRequestFailure } from '@/lib/http';
import { toastActions } from '@/lib/toast-store';
import { useArtifact } from '@/lib/use-artifact';
import { workspaceApi } from '@/lib/workspace-api';
import { timeAgo } from '@/lib/workspace-time';
import { artifactPreviewKind, type ArtifactTokenPurpose, type ArtifactVersion } from '@/lib/workspace-types';
import { ArtifactOwnerMenu } from './ArtifactOwnerMenu';
import { ArtifactPreview } from './ArtifactPreview';
import { ShareLinkDialog } from './ShareLinkDialog';
import { IconAction } from './task-bits';

export const DOWNLOAD_FAILED = 'That download didn’t start, so nothing was saved. Try again in a moment.';
const RESTORE_FAILED = 'We couldn’t restore that version just now. Nothing changed.';

/** "v3 · 2 hr ago" — the clock words come from the one time module. */
function versionLabel(v: ArtifactVersion): string {
  const when = timeAgo(v.createdAt);
  return when === null ? `v${v.version}` : `v${v.version} · ${when}`;
}

export function ArtifactViewer({
  artifactId,
  agentName,
  onBack,
  onClose,
  recheckKey = 0,
}: {
  artifactId: string;
  agentName: string;
  onBack(): void;
  onClose(): void;
  /**
   * Moves when a new version may have landed (a thread re-read, a failed turn,
   * Open on this same card): the viewer re-reads quietly. With no version
   * picked it shows whatever is current, so a new version takes the frame; an
   * older one the person picked stays picked.
   */
  recheckKey?: number;
}) {
  const { status, artifact, reload, refresh, apply } = useArtifact(artifactId, recheckKey);
  // null: whichever version is current.
  const [picked, setPicked] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const downloadInFlight = useRef(false);
  useEffect(() => setPicked(null), [artifactId]);

  const current = artifact?.currentVersion ?? null;
  const version = picked ?? current;

  const loadToken = useCallback(
    async (purpose: ArtifactTokenPurpose) => {
      if (version === null) throw new Error('no version yet');
      return workspaceApi.artifactToken(artifactId, version, purpose);
    },
    [artifactId, version],
  );
  const loadText = useCallback(async () => {
    if (version === null) throw new Error('no version yet');
    return workspaceApi.artifactText(artifactId, version);
  }, [artifactId, version]);

  const download = useCallback(() => {
    if (downloadInFlight.current) return;
    downloadInFlight.current = true;
    setDownloading(true);
    void (async () => {
      try {
        saveFromContentOrigin((await loadToken('download')).url);
      } catch (e) {
        logRequestFailure(e, 'artifact-download');
        toastActions.error(DOWNLOAD_FAILED);
      } finally {
        downloadInFlight.current = false;
        setDownloading(false);
      }
    })();
  }, [loadToken]);

  async function copyLink() {
    if (copying) return;
    setCopying(true);
    // No await before this call: the clipboard write must start in the click.
    const outcome = await copyShareLink(artifactId);
    setCopying(false);
    if (outcome.kind === 'manual') setManualUrl(outcome.url);
    // The link may have just been turned on: the ⋯ menu should know.
    refresh();
  }

  async function restore() {
    if (picked === null || restoring) return;
    setRestoring(true);
    try {
      await workspaceApi.restoreArtifact(artifactId, picked);
      toastActions.show({ title: `Restored v${picked}` });
      setPicked(null);
      refresh();
    } catch (e) {
      logRequestFailure(e, 'artifact-restore');
      toastActions.error(RESTORE_FAILED);
    } finally {
      setRestoring(false);
    }
  }

  const back = (
    <Button type="button" variant="ghost" size="sm" onClick={onBack} className="-ml-2 text-muted-foreground">
      <ChevronLeft data-icon="inline-start" aria-hidden />
      Back
    </Button>
  );
  const close = <IconAction icon={X} label="Close" variant="ghost" onClick={onClose} />;

  if (status !== 'ready' || artifact === null) {
    return (
      <div className="flex flex-col gap-2 py-1">
        <div className="flex items-center justify-between gap-2">
          {back}
          {close}
        </div>
        {status === 'loading' ? (
          <div role="status" className="flex flex-col gap-2">
            <span className="sr-only">Loading…</span>
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-[320px] w-full" />
          </div>
        ) : (
          <Alert>
            <AlertDescription className="flex flex-col items-start gap-2">
              {status === 'gone' ? (
                <span>We couldn’t find this artifact. It may have been deleted.</span>
              ) : (
                <>
                  <span>We couldn’t open {agentName}’s artifact just now. Nothing was lost.</span>
                  <Button size="sm" variant="outline" type="button" onClick={reload}>
                    Try again
                  </Button>
                </>
              )}
            </AlertDescription>
          </Alert>
        )}
      </div>
    );
  }

  const versions = [...artifact.versions].sort((a, b) => b.version - a.version);
  /*
    The preview word describes the CURRENT version. An older version saved as a
    different type could be anything, so it gets Download only rather than a
    preview chosen for some other kind of file.
  */
  const shownVersion = versions.find((v) => v.version === version);
  const preview =
    shownVersion !== undefined && shownVersion.mediaType !== artifact.mediaType
      ? 'none'
      : artifactPreviewKind(artifact.preview);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 py-1">
      <div className="flex items-center gap-2">
        {back}
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="truncate text-[14px] font-medium text-foreground">
            {artifact.title}
          </h3>
          <span className="truncate text-[12px] text-muted-foreground">{artifactTypeLine(artifact)}</span>
        </div>
        {close}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={String(version)}
          onValueChange={(v) => {
            const n = Number(v);
            setPicked(n === artifact.currentVersion ? null : n);
          }}
        >
          <SelectTrigger aria-label="Version" className="h-8 w-auto gap-2 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {versions.map((v) => (
                <SelectItem key={v.version} value={String(v.version)}>
                  {versionLabel(v)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {picked !== null && (
          <Button type="button" size="sm" variant="outline" disabled={restoring} onClick={() => void restore()}>
            {restoring && <Spinner data-icon="inline-start" />}
            Restore this version
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1">
          <IconAction
            icon={Download}
            label="Download"
            variant="ghost"
            disabled={downloading}
            reason="Getting your download ready…"
            onClick={download}
          />
          <IconAction
            icon={LinkIcon}
            label="Copy link"
            variant="ghost"
            disabled={copying}
            reason="Copying the link…"
            onClick={() => void copyLink()}
          />
          <ArtifactOwnerMenu
            artifact={artifact}
            onChanged={(next) => {
              if (next === null) onBack();
              else apply(next);
            }}
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ArtifactPreview
          // A new version is a new preview: fresh token, fresh text.
          key={version}
          preview={preview}
          title={artifact.title}
          loadToken={loadToken}
          loadText={loadText}
          onDownload={download}
        />
      </div>
      <ShareLinkDialog url={manualUrl} onClose={() => setManualUrl(null)} />
    </div>
  );
}
