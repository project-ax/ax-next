/**
 * AgentOwners — who owns an agent, under "Who can use <agent>?" (TASK-1247).
 *
 * Owners are fully trusted, so Add owner asks first: AddOwnerDialog says
 * plainly what owners can change. Remove doesn't ask. It narrows who can
 * change the agent, and the design asks for no confirmation when narrowing.
 *
 * Remove is on every row except two. The creator's: the server refuses it,
 * and only the creator deletes the agent or edits its routines. And yours:
 * removing yourself would take this page away from you mid-edit, an edge this
 * card doesn't handle. If we can't tell who you are, no row gets Remove,
 * because any of them might be you.
 *
 * Every write sends the whole owner list, built from what the server last
 * said. So while a Remove is saving, nothing else here can start a write: one
 * built from the old list would bring back the person just removed. The list
 * changes only when a save's answer arrives (`onSaved`); a refusal leaves it
 * as it was and says why. Every name goes through `personLabel`.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { UserPlus, X } from 'lucide-react';
import { Inline, Notice, Stack, Text } from '@project-ax/ui';
import type { SharingView } from '@ax/agents';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OWNERS_MAX } from '@/lib/agent-sharing';
import { setOwners, sharingErrorMessage } from '@/lib/agent-sharing-api';
import { logRequestFailure } from '@/lib/http';
import { SHARING_COPY, personLabel } from '@/lib/sharing-copy';
import { useUser } from '@/lib/user-context';
import { AddOwnerDialog } from './AddOwnerDialog';

export interface AgentOwnersProps {
  agentId: string;
  agentName: string;
  /** Creator first (`view` in packages/agents/src/sharing/service.ts). */
  owners: SharingView['owners'];
  onSaved: (sharing: SharingView) => void;
}

export function AgentOwners({ agentId, agentName, owners, onSaved }: AgentOwnersProps) {
  const me = useUser()?.id ?? null;
  const headingId = useId();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const remove = async (id: string) => {
    setRemoving(true);
    setError(null);
    try {
      const sharing = await setOwners(
        agentId,
        owners.filter((o) => o.id !== id).map((o) => o.id),
      );
      if (live.current) onSaved(sharing);
    } catch (e) {
      logRequestFailure(e, 'sharing: remove owner');
      if (live.current) setError(sharingErrorMessage(e, agentName));
    } finally {
      if (live.current) setRemoving(false);
    }
  };

  return (
    <Stack gap="sm">
      <Text id={headingId} role="body-strong">
        {SHARING_COPY.owners.heading}
      </Text>
      <ul aria-labelledby={headingId}>
        {owners.map((o) => {
          const name = personLabel(o.displayName);
          const removable = me !== null && !o.creator && o.id !== me;
          return (
            <li key={o.id}>
              <Inline justify="between" gap="sm">
                <Inline gap="sm" wrap>
                  <Text>{name}</Text>
                  {o.creator && <Badge variant="secondary">{SHARING_COPY.owners.creator}</Badge>}
                  {o.id === me && <Badge variant="outline">{SHARING_COPY.owners.you}</Badge>}
                </Inline>
                {removable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={SHARING_COPY.owners.remove(name)}
                    title={SHARING_COPY.owners.remove(name)}
                    disabled={removing}
                    onClick={() => void remove(o.id)}
                  >
                    <X aria-hidden="true" />
                  </Button>
                )}
              </Inline>
            </li>
          );
        })}
      </ul>
      {error !== null && (
        <Notice tone="danger">{error}</Notice>
      )}
      {owners.length >= OWNERS_MAX ? (
        <Text role="meta">{SHARING_COPY.owners.cap}</Text>
      ) : (
        <Inline>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={removing}
            onClick={() => {
              setError(null);
              setAdding(true);
            }}
          >
            <UserPlus data-icon="inline-start" aria-hidden="true" />
            {SHARING_COPY.owners.add}
          </Button>
        </Inline>
      )}
      <AddOwnerDialog
        open={adding}
        agentId={agentId}
        agentName={agentName}
        owners={owners}
        onSaved={onSaved}
        onClose={() => setAdding(false)}
      />
    </Stack>
  );
}
