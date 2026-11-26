/**
 * ShareConfirmDialog — the one confirmation before more people can use an
 * agent (TASK-1247, design §7).
 *
 * Sharing an agent shares what it can reach, so this says it plainly: every
 * connection that travels with the agent, by name, with the account each one
 * is signed in to; everything the agent remembers; its files, artifacts and
 * Instructions.
 *
 * It fails closed. The connections are read fresh each time it opens (the
 * body remounts), and Share stays off until that read lands. If the read
 * fails, or answers something we can't read, Share stays off and Try again
 * reads again: a dialog that can't say what it would share doesn't share.
 *
 * Which connections travel: every row of the agent's connections read except
 * `legacy-owned` ones. Those are the viewer's own connectors, which the agent
 * uses only for the viewer (`routes-workspace.ts`'s connectors read), so naming
 * them would describe a share that doesn't happen. Every other row is named,
 * signed in or not, including a source this client doesn't know yet: an
 * over-full list is safe, a short one isn't. An agent whose runner loads no
 * connectors (`connectorsSupported: false`) shares none, unless the agent has
 * connections attached: then a read that names none of them is not believed,
 * and is shown as failed (see `travelling`).
 *
 * Words come from `SHARING_COPY.confirm`. Connection and person names go
 * through `personLabel` (fenced). The account is provider text, sanitized where
 * it's stored: a text node in its own `<bdi>`, as the connectors tab shows it.
 */
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { PersonView } from '@ax/agents';
import { Notice, Stack, Text } from '@project-ax/ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { logRequestFailure } from '@/lib/http';
import { SHARING_COPY, personLabel } from '@/lib/sharing-copy';
import { workspaceApi } from '@/lib/workspace-api';
import type { AgentConnectorRow, AgentConnectorsRead } from '@/lib/workspace-types';

export interface ShareConfirmDialogProps {
  open: boolean;
  agentId: string;
  agentName: string;
  /**
   * The connector ids attached to the agent, from its own record. If there
   * are any and the connections read names none of them, the read is treated
   * as failed (Share off, Try again).
   */
  attachedConnectorIds: readonly string[];
  who: { kind: 'everyone' } | { kind: 'people'; added: PersonView[] };
  saving: boolean;
  /** A failed Share, shown inside the dialog. */
  error: string | null;
  onShare: () => void;
  onRemoveConnectionsFirst: () => void;
  onCancel: () => void;
}

type ConnectionsRead =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; connections: AgentConnectorRow[] };

/** The read answered, but in a way that contradicts what the agent has attached. */
class ConnectionsMismatch extends Error {
  constructor() {
    super('the connections read names none of the connections attached to the agent');
    this.name = 'ConnectionsMismatch';
  }
}

/**
 * The connections that travel with the agent (see the header). Throws on an
 * answer it can't read, which the caller turns into "couldn't check".
 *
 * Also throws when the agent has connections attached but the read names none
 * of them (an empty list, only legacy rows, or `connectorsSupported: false`):
 * a 200 that lost the attached rows on the way must not read as "nothing to
 * share". Naming at least one is enough: an attachment whose connector has
 * since left the catalog drops out of the read for good, and requiring every
 * one would lock Share off forever.
 */
function travelling(read: AgentConnectorsRead, attachedIds: readonly string[]): AgentConnectorRow[] {
  const rows =
    read.connectorsSupported === false
      ? []
      : read.connectors.filter((row) => row.source !== 'legacy-owned');
  if (attachedIds.length > 0 && !rows.some((row) => attachedIds.includes(row.id))) {
    throw new ConnectionsMismatch();
  }
  return rows;
}

/*
  Copy lines are strings, but some of their words are elements here: a
  connection's name in bold, its account in a <bdi>. So each slot goes into the
  copy function as a marker, and the line is cut apart around the markers. A
  marker is a control character (U+001A) around the slot's number. No copy line,
  fenced name or agent name can hold one: fenceLine turns controls into spaces,
  and @ax/agents refuses them in a display name.
*/
const MARK = String.fromCharCode(0x1a);
const SLOT = new RegExp(`${MARK}(\\d+)${MARK}`);
const slot = (i: number): string => `${MARK}${i}${MARK}`;

/** `line` with `nodes[i]` where `slot(i)` was. */
function fillSlots(line: string, nodes: readonly ReactNode[]): ReactNode[] {
  return line
    .split(SLOT)
    .map((part, i) => <Fragment key={i}>{i % 2 === 0 ? part : (nodes[Number(part)] ?? null)}</Fragment>);
}

/** "Gmail (signed in as …)": the name fenced and bold, the account in a <bdi>. */
function ConnectionName({ row }: { row: AgentConnectorRow }) {
  const account = row.signedIn?.account;
  return (
    <>
      <strong>{personLabel(row.name)}</strong>
      {account ? <> ({fillSlots(SHARING_COPY.confirm.signedInAs(slot(0)), [<bdi>{account}</bdi>])})</> : null}
    </>
  );
}

function ConnectionsLine({ agentName, connections }: { agentName: string; connections: AgentConnectorRow[] }) {
  const line = SHARING_COPY.confirm.connections(
    agentName,
    connections.map((_, i) => slot(i)),
  );
  return (
    <Text>
      {fillSlots(
        line,
        connections.map((row) => <ConnectionName key={row.id} row={row} />),
      )}
    </Text>
  );
}

export function ShareConfirmDialog(props: ShareConfirmDialogProps) {
  const { open, saving, onCancel, agentId } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onCancel();
      }}
    >
      <DialogContent className="break-words">
        {/* Mounted only while open, and again per agent: an answer never
            outlives the opening (or the agent) it was read for. */}
        <ShareConfirmBody key={agentId} {...props} />
      </DialogContent>
    </Dialog>
  );
}

function ShareConfirmBody({
  agentId,
  agentName,
  attachedConnectorIds,
  who,
  saving,
  error,
  onShare,
  onRemoveConnectionsFirst,
  onCancel,
}: ShareConfirmDialogProps) {
  const [read, setRead] = useState<ConnectionsRead>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    workspaceApi
      .connectors(agentId)
      .then((answer) => travelling(answer, attachedConnectorIds))
      .then(
        (connections) => {
          if (live) setRead({ status: 'ready', connections });
        },
        (e: unknown) => {
          logRequestFailure(e, 'sharing: read connections to confirm');
          if (live) setRead({ status: 'failed' });
        },
      );
    return () => {
      live = false;
    };
  }, [agentId, attempt, attachedConnectorIds]);

  const connections = read.status === 'ready' ? read.connections : [];
  const canShare = read.status === 'ready' && !saving;
  const title = SHARING_COPY.confirm.title(
    agentName,
    who.kind === 'everyone' ? 'everyone' : who.added.map((person) => personLabel(person.displayName)),
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{SHARING_COPY.confirm.lead}</DialogDescription>
      </DialogHeader>
      <Stack gap="md">
        {read.status === 'loading' && <Text role="meta">{SHARING_COPY.confirm.loading}</Text>}
        {read.status === 'failed' && (
          <Notice
            tone="danger"
            action={{
              label: SHARING_COPY.confirm.tryAgain,
              onClick: () => {
                setRead({ status: 'loading' });
                setAttempt((n) => n + 1);
              },
            }}
          >
            {SHARING_COPY.confirm.connectionsFailed(agentName)}
          </Notice>
        )}
        {connections.length > 0 && <ConnectionsLine agentName={agentName} connections={connections} />}
        <Text>{SHARING_COPY.confirm.memory(agentName)}</Text>
        <Text>{SHARING_COPY.confirm.filesAndInstructions(agentName)}</Text>
      </Stack>
      {error !== null && (
        <Notice tone="danger">{error}</Notice>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>
          {SHARING_COPY.confirm.cancel}
        </Button>
        {connections.length > 0 && (
          <Button type="button" variant="outline" disabled={saving} onClick={onRemoveConnectionsFirst}>
            {SHARING_COPY.confirm.removeConnectionsFirst}
          </Button>
        )}
        <Button type="button" disabled={!canShare} onClick={onShare}>
          {saving && <Spinner data-icon="inline-start" aria-hidden="true" />}
          {SHARING_COPY.confirm.share}
        </Button>
      </DialogFooter>
    </>
  );
}
