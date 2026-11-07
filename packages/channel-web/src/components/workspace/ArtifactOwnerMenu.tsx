/**
 * The viewer's ⋯ menu: rename, the share link's off switch and reset, and
 * delete. Everything that takes something away from someone asks first, in
 * plain words, and says what happens to people already holding the link.
 */
import { useState } from 'react';
import { Ellipsis } from 'lucide-react';
import { ARTIFACT_TITLE_MAX } from '@ax/ipc-protocol/content-blocks';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { copyLinkFrom } from '@/lib/copy-share-link';
import { HttpError, logRequestFailure } from '@/lib/http';
import { toastActions } from '@/lib/toast-store';
import { workspaceApi } from '@/lib/workspace-api';
import type { ArtifactDetail, ArtifactSummary } from '@/lib/workspace-types';
import { ShareLinkDialog } from './ShareLinkDialog';

type Pending = 'rename' | 'link-off' | 'link-new' | 'delete';

const FAILED = 'That didn’t work, so nothing changed. Try again in a moment.';
const BAD_NAME = `That name won’t work. Use up to ${ARTIFACT_TITLE_MAX} characters, on one line.`;
const OLD_LINK = 'Anyone using the old link will lose access right away.';

const CONFIRM: Record<Exclude<Pending, 'rename'>, { title: string; description: string; action: string }> = {
  'link-off': {
    title: 'Turn off the link?',
    description: `${OLD_LINK} You can make a new one later with Copy link.`,
    action: 'Turn off link',
  },
  'link-new': {
    title: 'Get a new link?',
    description: `${OLD_LINK} We’ll copy the new one for you.`,
    action: 'Get a new link',
  },
  delete: {
    title: 'Delete this artifact?',
    description: 'Its link stops working and every version is gone. This can’t be undone.',
    action: 'Delete artifact',
  },
};

export function ArtifactOwnerMenu({
  artifact,
  onChanged,
}: {
  artifact: ArtifactDetail;
  /** The artifact as it is now, or `null` once it's deleted. */
  onChanged(next: ArtifactSummary | null): void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  // What the dialog shows: the last thing opened, kept while it animates shut,
  // so a closing confirm never flips to the Rename copy.
  const [shown, setShown] = useState<Pending>('rename');
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function open(next: Pending) {
    setPending(next);
    setShown(next);
    setError(null);
    setNameError(null);
    if (next === 'rename') setTitle(artifact.title);
  }

  async function act() {
    if (pending === null || busy) return;
    setBusy(true);
    setError(null);
    setNameError(null);
    try {
      if (pending === 'rename') {
        onChanged(await workspaceApi.renameArtifact(artifact.artifactId, title.trim()));
      } else if (pending === 'link-off') {
        await workspaceApi.setArtifactLink(artifact.artifactId, 'off');
        onChanged({ ...artifact, linkOn: false });
        toastActions.show({ title: 'Link turned off' });
      } else if (pending === 'link-new') {
        // Started in the click, before any await, so Safari allows the copy.
        const outcome = await copyLinkFrom(() => workspaceApi.setArtifactLink(artifact.artifactId, 'rotate'));
        if (outcome.kind === 'failed') {
          setError(FAILED);
          return;
        }
        onChanged({ ...artifact, linkOn: true });
        if (outcome.kind === 'copied') toastActions.show({ title: 'New link copied' });
        else setManualUrl(outcome.url);
      } else {
        await workspaceApi.deleteArtifact(artifact.artifactId);
        toastActions.show({ title: 'Artifact deleted' });
        onChanged(null);
      }
      setPending(null);
    } catch (e) {
      logRequestFailure(e, `artifact-${pending}`);
      if (pending === 'rename' && e instanceof HttpError && e.status === 400) setNameError(BAD_NAME);
      else setError(FAILED);
    } finally {
      setBusy(false);
    }
  }

  const confirm = shown !== 'rename' ? CONFIRM[shown] : null;

  return (
    <>
      {/* Not modal: the dialogs it opens may remove what the menu sits on. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label="More actions">
            <Ellipsis aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4}>
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => open('rename')}>Rename…</DropdownMenuItem>
            {artifact.linkOn && (
              <>
                <DropdownMenuItem onSelect={() => open('link-off')}>Turn off link…</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => open('link-new')}>Get a new link…</DropdownMenuItem>
              </>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => open('delete')}
            >
              Delete artifact…
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={pending !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen && !busy) setPending(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.title ?? 'Rename artifact'}</DialogTitle>
            <DialogDescription>{confirm?.description ?? 'Give it a name that’s easy to find later.'}</DialogDescription>
          </DialogHeader>
          {shown === 'rename' && (
            <form
              id="artifact-rename"
              onSubmit={(e) => {
                e.preventDefault();
                void act();
              }}
            >
              <FieldGroup>
                <Field data-invalid={nameError !== null || undefined}>
                  <FieldLabel htmlFor="artifact-title">Name</FieldLabel>
                  <Input
                    id="artifact-title"
                    value={title}
                    maxLength={ARTIFACT_TITLE_MAX}
                    aria-invalid={nameError !== null || undefined}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      setNameError(null);
                    }}
                  />
                  {nameError !== null && <FieldError>{nameError}</FieldError>}
                </Field>
              </FieldGroup>
            </form>
          )}
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </Button>
            {shown === 'rename' ? (
              <Button type="submit" form="artifact-rename" disabled={busy || title.trim() === ''}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            ) : (
              <Button
                type="button"
                variant={shown === 'delete' ? 'destructive' : 'default'}
                disabled={busy}
                onClick={() => void act()}
              >
                {confirm?.action}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ShareLinkDialog url={manualUrl} onClose={() => setManualUrl(null)} />
    </>
  );
}
