/**
 * AudienceDialog — choose who can use an agent (TASK-1247, design §3).
 *
 * One field, like document sharing: Just me and Everyone first, then people
 * found by name. What's chosen so far shows as removable rows, and removing
 * the last person leaves Just me. "Same people as…" copies another of your
 * shared agents' lists into the draft (a copy, not a link: design §8 Q4).
 *
 * Saving depends on the change, judged against the audience as saved when
 * Save is pressed (read fresh, since another owner may have changed it):
 *  - widening (anyone new can use it) opens ShareConfirmDialog first, which
 *    names the agent's connections. Its Cancel comes back here, draft intact;
 *  - anything else saves straight away. Narrowing also says people may still
 *    remember what the agent told them.
 *
 * Owners can always use the agent, so they're never offered and never listed,
 * and once there's more than one owner the "Just me" choice reads "Just its
 * owners" (the ux-designer pass).
 *
 * The state lives in the open half, which mounts each time the dialog opens,
 * so a reopen starts from what's saved. Every name goes through `personLabel`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { Inline, Notice, Stack, Text } from '@project-ax/ui';
import type { SharingView } from '@ax/agents';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { getAdminAgent, listAdminAgents, type AdminAgent } from '@/lib/admin';
import {
  AUDIENCE_MEMBERS_MAX,
  addedPeople,
  draftFrom,
  isNarrowing,
  isWidening,
  sameAudience,
  sharedAgentChoices,
  toAudienceBody,
  type DraftAudience,
} from '@/lib/agent-sharing';
import { setAudience, sharingErrorMessage, type PersonMatch } from '@/lib/agent-sharing-api';
import { logRequestFailure } from '@/lib/http';
import { SHARING_COPY, personLabel } from '@/lib/sharing-copy';
import { PeoplePicker } from './PeoplePicker';
import { ShareConfirmDialog, type ShareConfirmDialogProps } from './ShareConfirmDialog';

export interface AudienceDialogProps {
  open: boolean;
  agentId: string;
  agentName: string;
  saved: SharingView['audience'];
  /** Owners can always use it: never offered, never listed. */
  ownerIds: ReadonlySet<string>;
  onSaved: (sharing: SharingView) => void;
  onOpenConnections: () => void;
  onClose: () => void;
}

const JUST_ME = 'just-me';
const EVERYONE = 'everyone';

/** A copied audience without this agent's owners. Nobody left means Just me. */
function withoutOwners(d: DraftAudience, ownerIds: ReadonlySet<string>): DraftAudience {
  if (d.kind !== 'list') return d;
  const members = d.members.filter((m) => !ownerIds.has(m.id));
  return members.length === 0 ? { kind: 'just-me' } : { kind: 'list', members };
}

export function AudienceDialog(props: AudienceDialogProps) {
  if (!props.open) return null;
  return <OpenAudienceDialog {...props} />;
}

function OpenAudienceDialog({
  agentId,
  agentName,
  saved,
  ownerIds,
  onSaved,
  onOpenConnections,
  onClose,
}: AudienceDialogProps) {
  const savedDraft = useMemo(() => draftFrom(saved), [saved]);
  const [draft, setDraft] = useState<DraftAudience>(savedDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ShareConfirmDialogProps['who'] | null>(null);
  const [choices, setChoices] = useState<AdminAgent[]>([]);
  /** The agent's attached connector ids, from the read Save makes. */
  const [attachedConnectorIds, setAttachedConnectorIds] = useState<readonly string[]>([]);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // "Same people as…" is a shortcut: if the list can't be read, it just isn't
  // offered (and the failure is logged for an operator).
  useEffect(() => {
    listAdminAgents().then(
      (agents) => {
        if (live.current) setChoices(sharedAgentChoices(agents, agentId));
      },
      (e: unknown) => logRequestFailure(e, 'sharing: list agents for Same people as'),
    );
  }, [agentId]);

  const excludeIds = useMemo(() => {
    const ids = new Set(ownerIds);
    if (draft.kind === 'list') for (const m of draft.members) ids.add(m.id);
    return ids;
  }, [ownerIds, draft]);

  const edit = (next: DraftAudience) => {
    setDraft(next);
    setError(null);
    setCopyError(null);
  };

  const pickPerson = (person: PersonMatch) => {
    const view = { id: person.id, displayName: person.displayName };
    if (draft.kind !== 'list') return edit({ kind: 'list', members: [view] });
    if (draft.members.some((m) => m.id === person.id)) return;
    edit({ kind: 'list', members: [...draft.members, view] });
  };

  const removePerson = (id: string) => {
    if (draft.kind !== 'list') return;
    const members = draft.members.filter((m) => m.id !== id);
    edit(members.length === 0 ? { kind: 'just-me' } : { kind: 'list', members });
  };

  const copyFrom = async (source: AdminAgent) => {
    setCopyError(null);
    try {
      const audience = (await getAdminAgent(source.id)).sharing?.audience;
      if (audience === undefined) throw new Error('no sharing on the source agent');
      if (live.current) edit(withoutOwners(draftFrom(audience), ownerIds));
    } catch (e) {
      logRequestFailure(e, 'sharing: read the agent to copy from');
      if (live.current) setCopyError(SHARING_COPY.picker.copyFailed(personLabel(source.displayName)));
    }
  };

  const write = async () => {
    setSaving(true);
    setError(null);
    try {
      const sharing = await setAudience(agentId, toAudienceBody(draft));
      if (!live.current) return;
      onSaved(sharing);
      onClose();
    } catch (e) {
      logRequestFailure(e, 'sharing: save audience');
      if (live.current) setError(sharingErrorMessage(e, agentName));
    } finally {
      if (live.current) setSaving(false);
    }
  };

  // Widening is judged against the audience as saved NOW, not as the section
  // last read it: another owner may have narrowed it in another tab, and a
  // widening from there must still ask first. If that read fails, nothing is
  // written.
  const save = async () => {
    setSaving(true);
    setError(null);
    let current: DraftAudience;
    let attached: readonly string[];
    try {
      const fresh = await getAdminAgent(agentId);
      const audience = fresh.sharing?.audience;
      if (audience === undefined) throw new Error('no sharing on the agent');
      current = draftFrom(audience);
      attached = fresh.connectorAttachments ?? [];
    } catch (e) {
      logRequestFailure(e, 'sharing: read the audience as saved');
      if (live.current) {
        setError(SHARING_COPY.errors.generic);
        setSaving(false);
      }
      return;
    }
    if (!live.current) return;
    if (isWidening(current, draft)) {
      setSaving(false);
      setAttachedConnectorIds(attached);
      setConfirming(
        draft.kind === 'everyone'
          ? { kind: 'everyone' }
          : { kind: 'people', added: addedPeople(current, draft) },
      );
      return;
    }
    await write();
  };

  const atCap = draft.kind === 'list' && draft.members.length >= AUDIENCE_MEMBERS_MAX;
  const unchanged = sameAudience(savedDraft, draft);
  const narrowed = isNarrowing(savedDraft, draft);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent className="break-words" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{SHARING_COPY.picker.title(agentName)}</DialogTitle>
        </DialogHeader>
        <Stack gap="md">
          <PeoplePicker
            label={SHARING_COPY.picker.fieldLabel}
            placeholder={SHARING_COPY.picker.placeholder}
            excludeIds={excludeIds}
            fixedOptions={[
              // Owners can always use it, so with co-owners this reads "Just its owners".
              { id: JUST_ME, label: SHARING_COPY.audience.justMe(ownerIds.size) },
              {
                id: EVERYONE,
                label: SHARING_COPY.picker.everyoneOption,
                hint: SHARING_COPY.picker.everyoneHint,
              },
            ]}
            onPickFixed={(id) => edit(id === EVERYONE ? { kind: 'everyone' } : { kind: 'just-me' })}
            onPickPerson={pickPerson}
            disabled={saving}
            peopleDisabled={atCap}
          />
          {atCap && <Text role="meta">{SHARING_COPY.picker.peopleCap}</Text>}
          {choices.length > 0 && (
            <Inline justify="end">
              {/* Not modal: a modal menu inside a dialog can leave the page unclickable. */}
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm" disabled={saving}>
                    {SHARING_COPY.picker.sameAs}
                    <ChevronDown data-icon="inline-end" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    {choices.map((a) => (
                      <DropdownMenuItem key={a.id} onSelect={() => void copyFrom(a)}>
                        {SHARING_COPY.picker.sameAsItem(personLabel(a.displayName))}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </Inline>
          )}
          <DraftRows
            agentName={agentName}
            draft={draft}
            disabled={saving}
            onRemovePerson={removePerson}
            onRemoveEveryone={() => edit({ kind: 'just-me' })}
          />
          {copyError !== null && (
            <Notice tone="danger">{copyError}</Notice>
          )}
          {narrowed && (
            <Notice tone="info">{SHARING_COPY.picker.narrowed(agentName)}</Notice>
          )}
          {error !== null && confirming === null && (
            <Notice tone="danger">{error}</Notice>
          )}
        </Stack>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
            {SHARING_COPY.picker.cancel}
          </Button>
          <Button type="button" disabled={unchanged || saving} onClick={() => void save()}>
            {saving && confirming === null && <Spinner data-icon="inline-start" aria-hidden="true" />}
            {SHARING_COPY.picker.save}
          </Button>
        </DialogFooter>
        {confirming !== null && (
          <ShareConfirmDialog
            open
            agentId={agentId}
            agentName={agentName}
            attachedConnectorIds={attachedConnectorIds}
            who={confirming}
            saving={saving}
            error={error}
            onShare={() => void write()}
            onRemoveConnectionsFirst={() => {
              setConfirming(null);
              onClose();
              onOpenConnections();
            }}
            onCancel={() => {
              setConfirming(null);
              setError(null);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DraftRows({
  agentName,
  draft,
  disabled,
  onRemovePerson,
  onRemoveEveryone,
}: {
  agentName: string;
  draft: DraftAudience;
  disabled: boolean;
  onRemovePerson: (id: string) => void;
  onRemoveEveryone: () => void;
}) {
  if (draft.kind === 'just-me') {
    return <Text role="meta">{SHARING_COPY.picker.emptyDraft(agentName)}</Text>;
  }
  if (draft.kind === 'everyone') {
    return (
      <DraftRow
        label={SHARING_COPY.audience.everyone}
        hint={SHARING_COPY.picker.everyoneHint}
        disabled={disabled}
        onRemove={onRemoveEveryone}
      />
    );
  }
  return (
    <ul aria-label={SHARING_COPY.picker.fieldLabel}>
      {draft.members.map((m) => (
        <li key={m.id}>
          <DraftRow
            label={personLabel(m.displayName)}
            disabled={disabled}
            onRemove={() => onRemovePerson(m.id)}
          />
        </li>
      ))}
    </ul>
  );
}

function DraftRow({
  label,
  hint,
  disabled,
  onRemove,
}: {
  label: string;
  hint?: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <Inline justify="between" gap="sm">
      <Stack gap="none">
        <Text>{label}</Text>
        {hint !== undefined && <Text role="meta">{hint}</Text>}
      </Stack>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={SHARING_COPY.picker.remove(label)}
        disabled={disabled}
        onClick={onRemove}
      >
        <X aria-hidden="true" />
      </Button>
    </Inline>
  );
}
