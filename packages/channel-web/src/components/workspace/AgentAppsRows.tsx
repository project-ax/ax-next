/**
 * The rows of an agent's Apps section, and its Unlink confirmation: split out
 * of `AgentApps.tsx`, which owns the state and the writes. App names,
 * connector names and tool names are untrusted text, rendered as text only.
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button as AxButton, ConfirmAction, List, ListRow, StatusBadge, Text } from '@project-ax/ui';
import type { AppGrant, AppLink, ViewerApproval } from '@ax/apps-bridge-contract';
import { Button } from '@/components/ui/button';
import { APP_MODE_COPY } from './AppGrantEditor';

export function LinkRow({
  link,
  canManage,
  busy,
  onAdd,
  onEdit,
  onRemove,
  onUnlink,
}: {
  link: AppLink;
  canManage: boolean;
  busy: ReadonlySet<string>;
  onAdd: () => void;
  onEdit: (grant: AppGrant) => void;
  /** Resolves once the write is done; a refusal is the page's to show. */
  onRemove: (grant: AppGrant) => Promise<void>;
  onUnlink: () => void;
}) {
  // While the app is being unlinked, nothing else on its row can start.
  const unlinking = busy.has(link.appId);
  // The grant whose Remove is awaiting confirmation.
  const [removing, setRemoving] = useState<AppGrant | null>(null);
  return (
    <ListRow
      title={link.appName}
      meta={link.appId}
      {...(canManage
        ? {
            trailing: (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={unlinking}
                  onClick={onAdd}
                  aria-label={`Add a connector to ${link.appName}`}
                >
                  <Plus data-icon="inline-start" aria-hidden="true" />
                  Add a connector
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={unlinking}
                  onClick={onUnlink}
                  aria-label={`Unlink ${link.appName}`}
                >
                  Unlink
                </Button>
              </>
            ),
          }
        : {})}
      below={
        <>
          {link.grants.length === 0 ? (
            <Text role="meta">
              {canManage ? 'It can’t use any connectors yet. Add one to get it going.' : 'It can’t use any connectors yet.'}
            </Text>
          ) : (
            <List label={`What ${link.appName} can use`} density="compact">
              {link.grants.map((grant) => {
                const rowBusy = unlinking || busy.has(`${link.appId}:${grant.connectorId}`);
                return (
                  <ListRow
                    key={grant.connectorId}
                    title={grant.connectorName}
                    meta={
                      <StatusBadge tone="neutral" size="sm">
                        {APP_MODE_COPY[grant.mode].badge}
                      </StatusBadge>
                    }
                    below={<Text role="meta">{grant.tools.map((t) => t.name).join(', ')}</Text>}
                    {...(canManage
                      ? {
                          trailing: (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={rowBusy}
                                onClick={() => onEdit(grant)}
                                aria-label={`Edit ${grant.connectorName} for ${link.appName}`}
                              >
                                Edit
                              </Button>
                              <AxButton
                                intent="quiet"
                                size="sm"
                                busy={rowBusy}
                                disabled={rowBusy}
                                onClick={() => setRemoving(grant)}
                                aria-label={`Remove ${grant.connectorName} from ${link.appName}`}
                              >
                                Remove
                              </AxButton>
                            </>
                          ),
                        }
                      : {})}
                  />
                );
              })}
            </List>
          )}
          <ConfirmAction
            open={removing !== null}
            onOpenChange={(open) => {
              if (!open) setRemoving(null);
            }}
            title={removing === null ? 'Remove this connector?' : `Remove ${removing.connectorName} from ${link.appName}?`}
            description={`${link.appName} stops using ${removing?.connectorName ?? 'this connector'} straight away. The app stays linked and keeps any other connectors you gave it.`}
            confirmLabel="Remove connector"
            onConfirm={() => (removing !== null ? onRemove(removing) : undefined)}
          />
        </>
      }
    />
  );
}

export function ApprovalRow({
  approval,
  busy,
  onRevoke,
}: {
  approval: ViewerApproval;
  busy: boolean;
  /** Resolves once the write is done; a refusal is the page's to show. */
  onRevoke: () => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <ListRow
      title={approval.appName}
      description={`Uses ${approval.connectorName} as you`}
      trailing={
        <AxButton
          intent="quiet"
          size="sm"
          disabled={busy}
          onClick={() => setAsking(true)}
          aria-label={`Revoke ${approval.appName} using ${approval.connectorName}`}
        >
          Revoke
        </AxButton>
      }
      below={
        <ConfirmAction
          open={asking}
          onOpenChange={setAsking}
          title="Revoke this permission?"
          description={`${approval.appName} stops using ${approval.connectorName} as you, straight away.`}
          confirmLabel="Revoke"
          onConfirm={onRevoke}
        />
      }
    />
  );
}

export function UnlinkDialog({
  link,
  agentName,
  onCancel,
  onConfirm,
}: {
  link: AppLink | null;
  agentName: string;
  onCancel: () => void;
  /** Resolves once the write is done; a refusal is the page's to show. */
  onConfirm: (link: AppLink) => Promise<void>;
}) {
  return (
    <ConfirmAction
      open={link !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={`Unlink ${link?.appName ?? ''}?`}
      description={`It stops using ${agentName} straight away, along with every connector you gave it. To use it again, link it with a new code.`}
      confirmLabel="Unlink"
      onConfirm={() => (link !== null ? onConfirm(link) : undefined)}
    />
  );
}
