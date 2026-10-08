/**
 * AgentKeyDialog — a connector row's **Add key** (slice 3): the agent's own
 * key is missing (`setup: 'add-key'`), so whoever may choose the agent's
 * account — a team agent's team admin, a personal agent's owner — adds it.
 * Also how an OAuth connector that declares a header key gets that key after
 * its sign-in.
 *
 * The connector is loaded the same way the Add subview loads it
 * (`getConnector`, admin or settings route by role) and its slots come from
 * `agentKeyEntries`: api-key slots only — never a sign-in slot, never the
 * connector's own OAuth client secret. The form is `AddKeyDialog`
 * (`purpose: 'add-key'`): every slot, Save once all are filled. Each slot is
 * one `workspaceApi.setAgentKey` PUT — never the personal or company key
 * routes — and only the slot NAME is sent; the server derives the vault ref.
 * A refusal keeps the dialog open with what was typed and shows the api's
 * fixed sentence.
 *
 * Replacing a key that works is Remove, then Add — this only fills what's
 * missing, so there's no "saved" status read and no remove here.
 *
 * SECURITY: the keys are password fields, never rendered or logged.
 */
import { useEffect, useState } from 'react';
import { getConnector, type Connector } from '@/lib/connectors';
import { HttpError } from '@/lib/http';
import { workspaceApi, type AgentConnectorKey } from '@/lib/workspace-api';
import { AddKeyDialog } from './AddKeyDialog';

export interface AgentKeyDialogProps {
  agentId: string;
  /** The agent's display name. */
  agentName: string;
  /** A team agent: everyone using it uses this key. */
  teamAgent: boolean;
  connectorId: string;
  /** Shown while the connector loads. */
  connectorName: string;
  /** Picks the connector read route, same as the other connector dialogs. */
  isAdmin: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every key is saved: close and re-read. */
  onSaved: () => void;
}

export function AgentKeyDialog({
  agentId,
  agentName,
  teamAgent,
  connectorId,
  connectorName,
  isAdmin,
  onOpenChange,
  onSaved,
}: AgentKeyDialogProps) {
  const base = isAdmin ? '/admin/connectors' : '/settings/connectors';
  const [connector, setConnector] = useState<Connector | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setConnector(null);
    setFailed(false);
    getConnector(connectorId, base)
      .then((c) => {
        if (!cancelled) setConnector(c);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [connectorId, base]);

  async function save(keys: AgentConnectorKey[]) {
    try {
      // One slot at a time, in the connector's order: a refusal stops here.
      for (const k of keys) {
        await workspaceApi.setAgentKey(agentId, connectorId, k.slot, k.payload);
      }
    } catch (e) {
      // An HttpError's message is authored copy; anything else is not shown.
      throw new Error(
        e instanceof HttpError
          ? e.message
          : 'We couldn’t save the key just now. Please try again.',
      );
    }
    onSaved();
  }

  return (
    <AddKeyDialog
      purpose="add-key"
      connector={connector}
      connectorName={connectorName}
      failed={failed}
      agentName={agentName}
      teamAgent={teamAgent}
      open
      onOpenChange={onOpenChange}
      onSave={save}
    />
  );
}
