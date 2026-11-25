/**
 * AgentSharing — the Sharing section of an agent's settings (TASK-1247).
 *
 * "Who can use <agent>?" with what's saved and a Change button, which opens
 * AudienceDialog; the owners list goes underneath. It reads the agent's
 * sharing from `GET /admin/agents/:id`, which answers it only to the agent's
 * owners, and holds what every save answers, so the row is the confirmation.
 *
 * A team agent has no audience to choose: everyone on its team can use it, so
 * it says that and offers nothing. Someone who isn't an owner is told to ask
 * one (the server refuses their writes either way).
 */
import { useEffect, useMemo, useState } from 'react';
import { Inline, Stack, Text } from '@project-ax/ui';
import type { SharingView } from '@ax/agents';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { getAdminAgent } from '@/lib/admin';
import { SHARING_COPY, personLabel } from '@/lib/sharing-copy';
import type { AgentDetail } from '@/lib/workspace-api';
import type { AgentSettingsSection } from '@/lib/workspace-route';
import { AudienceDialog } from './AudienceDialog';

export interface AgentSharingProps {
  agent: AgentDetail['agent'];
  onSection: (section: AgentSettingsSection) => void;
}

type Load =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'team' }
  | { status: 'not-owner' }
  | { status: 'ready'; sharing: SharingView };

/** What the row says about who can use it now. */
function audienceSummary(sharing: SharingView): string {
  const { audience, owners } = sharing;
  if (audience.kind === 'just-me') return SHARING_COPY.audience.justMe(owners.length);
  if (audience.kind === 'everyone') return SHARING_COPY.audience.everyone;
  return SHARING_COPY.audience.people(
    audience.members.slice(0, 2).map((m) => personLabel(m.displayName)),
    audience.members.length,
  );
}

export function AgentSharing({ agent, onSection }: AgentSharingProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      let next: Load;
      try {
        const a = await getAdminAgent(agent.id);
        if (a.visibility === 'team') next = { status: 'team' };
        else if (a.sharing === undefined) next = { status: 'not-owner' };
        else next = { status: 'ready', sharing: a.sharing };
      } catch {
        next = { status: 'failed' };
      }
      if (live) setLoad(next);
    })();
    return () => {
      live = false;
    };
  }, [agent.id, attempt]);

  const sharing = load.status === 'ready' ? load.sharing : null;
  const ownerIds = useMemo(
    () => new Set(sharing === null ? [] : sharing.owners.map((o) => o.id)),
    [sharing],
  );

  if (load.status === 'loading') return <Text role="meta">{SHARING_COPY.loading}</Text>;
  if (load.status === 'team') return <Text>{SHARING_COPY.team(agent.name)}</Text>;
  if (load.status === 'not-owner') return <Text>{SHARING_COPY.errors.forbidden(agent.name)}</Text>;
  if (load.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <Stack gap="sm" align="start">
            {SHARING_COPY.errors.loadFailed(agent.name)}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setLoad({ status: 'loading' });
                setAttempt((n) => n + 1);
              }}
            >
              {SHARING_COPY.tryAgain}
            </Button>
          </Stack>
        </AlertDescription>
      </Alert>
    );
  }

  // Every save answers with the settings as saved: they replace what's shown.
  const onSaved = (next: SharingView) => setLoad({ status: 'ready', sharing: next });

  return (
    <Stack gap="xl">
      <Inline justify="between" align="start" gap="md">
        <Stack gap="xs">
          <Text role="body-strong">{SHARING_COPY.heading(agent.name)}</Text>
          <Text role="meta">{audienceSummary(load.sharing)}</Text>
        </Stack>
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
          {SHARING_COPY.change}
        </Button>
      </Inline>
      {/* Task 8 renders the owners here:
          <AgentOwners agentId={agent.id} agentName={agent.name}
                       owners={load.sharing.owners} onSaved={onSaved} /> */}
      <AudienceDialog
        open={editing}
        agentId={agent.id}
        agentName={agent.name}
        saved={load.sharing.audience}
        ownerIds={ownerIds}
        onSaved={onSaved}
        onOpenConnections={() => onSection('connectors')}
        onClose={() => setEditing(false)}
      />
    </Stack>
  );
}
