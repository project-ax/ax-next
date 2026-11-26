/**
 * AddOwnerDialog — make someone an owner of an agent (TASK-1247, design §3, §7).
 *
 * Two steps in one dialog. First, find the person by name; people who already
 * own the agent are never offered. Then a plain confirmation, because owners
 * are fully trusted: they can change everything the agent does with its
 * creator's connections, and its routines run as the creator, so an owner's
 * changes also change what those routines do. The words are
 * `SHARING_COPY.owners.consequences`, shown as they are, and they're also what
 * the dialog announces. Nothing is written until the confirmation's Add
 * owner; Cancel writes nothing.
 *
 * The write is the whole owner list: every owner as the server last said them
 * (creator first), then the new person. A refusal shows inside the dialog, and
 * the list behind it stays as it was until a save's answer replaces it.
 *
 * The state lives in the open half, which mounts each time the dialog opens,
 * so a reopen starts from the search. Every name goes through `personLabel`.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Notice, Text } from '@project-ax/ui';
import type { SharingView } from '@ax/agents';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { setOwners, sharingErrorMessage, type PersonMatch } from '@/lib/agent-sharing-api';
import { SHARING_COPY, personLabel, type RoutinesRunAs } from '@/lib/sharing-copy';
import { useUser } from '@/lib/user-context';
import { PeoplePicker } from './PeoplePicker';

export interface AddOwnerDialogProps {
  open: boolean;
  agentId: string;
  agentName: string;
  /** The owners as the server last said them, creator first. */
  owners: SharingView['owners'];
  onSaved: (sharing: SharingView) => void;
  onClose: () => void;
}

export function AddOwnerDialog(props: AddOwnerDialogProps) {
  if (!props.open) return null;
  return <OpenAddOwnerDialog {...props} />;
}

function OpenAddOwnerDialog({ agentId, agentName, owners, onSaved, onClose }: AddOwnerDialogProps) {
  const me = useUser()?.id ?? null;
  const [person, setPerson] = useState<PersonMatch | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consequencesId = useId();
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const ownerIds = useMemo(() => new Set(owners.map((o) => o.id)), [owners]);
  // The routines run as the creator: "you" when that's who is reading.
  const creator = owners.find((o) => o.creator);
  const routinesRunAs: RoutinesRunAs =
    creator !== undefined && creator.id === me
      ? { kind: 'you' }
      : { kind: 'name', name: personLabel(creator?.displayName) };

  const add = async (chosen: PersonMatch) => {
    setSaving(true);
    setError(null);
    try {
      const sharing = await setOwners(agentId, [...owners.map((o) => o.id), chosen.id]);
      if (!live.current) return;
      onSaved(sharing);
      onClose();
    } catch (e) {
      if (live.current) setError(sharingErrorMessage(e, agentName));
    } finally {
      if (live.current) setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent
        className="break-words"
        aria-describedby={person === null ? undefined : consequencesId}
      >
        {person === null ? (
          <>
            <DialogHeader>
              <DialogTitle>{SHARING_COPY.owners.addTitle(agentName)}</DialogTitle>
            </DialogHeader>
            <PeoplePicker
              label={SHARING_COPY.owners.fieldLabel}
              placeholder={SHARING_COPY.owners.placeholder}
              excludeIds={ownerIds}
              onPickPerson={setPerson}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                {SHARING_COPY.owners.cancel}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {SHARING_COPY.owners.confirmTitle(personLabel(person.displayName), agentName)}
              </DialogTitle>
            </DialogHeader>
            <Text id={consequencesId}>
              {SHARING_COPY.owners.consequences(agentName, routinesRunAs)}
            </Text>
            {error !== null && (
              <Notice tone="danger">{error}</Notice>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
                {SHARING_COPY.owners.cancel}
              </Button>
              <Button type="button" disabled={saving} onClick={() => void add(person)}>
                {saving && <Spinner data-icon="inline-start" aria-hidden="true" />}
                {SHARING_COPY.owners.confirm}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
