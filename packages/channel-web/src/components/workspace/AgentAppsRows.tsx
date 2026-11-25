/**
 * The rows of an agent's Apps section, and its Unlink confirmation: split out
 * of `AgentApps.tsx`, which owns the state and the writes. App names,
 * connector names and tool names are untrusted text, rendered as text only.
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button as AxButton, ConfirmAction } from '@project-ax/ui';
import type { AppGrant, AppLink, ViewerApproval } from '@ax/apps-bridge-contract';
import { Badge } from '@/components/ui/badge';
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
  const nameId = `app-${link.appId}-name`;
  // While the app is being unlinked, nothing else on its row can start.
  const unlinking = busy.has(link.appId);
  // The grant whose Remove is awaiting confirmation.
  const [removing, setRemoving] = useState<AppGrant | null>(null);
  return (
    <li aria-labelledby={nameId} className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span id={nameId} className="break-words text-[14px] font-medium">
            {link.appName}
          </span>
          <span className="truncate font-mono text-[12px] text-muted-foreground">{link.appId}</span>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-1">
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
          </div>
        )}
      </div>
      {link.grants.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          {canManage ? 'It can’t use any connectors yet. Add one to get it going.' : 'It can’t use any connectors yet.'}
        </p>
      ) : (
        <ul aria-label={`What ${link.appName} can use`} className="m-0 flex list-none flex-col gap-2 p-0">
          {link.grants.map((grant) => {
            const rowBusy = unlinking || busy.has(`${link.appId}:${grant.connectorId}`);
            return (
              <li key={grant.connectorId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted px-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium">{grant.connectorName}</span>
                    <Badge variant="secondary" size="compact">
                      {APP_MODE_COPY[grant.mode].badge}
                    </Badge>
                  </div>
                  <span className="break-all font-mono text-[12px] text-muted-foreground">
                    {grant.tools.map((t) => t.name).join(', ')}
                  </span>
                </div>
                {canManage && (
                  <div className="flex gap-1">
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
                  </div>
                )}
              </li>
            );
          })}
        </ul>
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
    </li>
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
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="break-words text-[14px] font-medium">{approval.appName}</span>
        <span className="text-[12.5px] text-muted-foreground">Uses {approval.connectorName} as you</span>
      </div>
      <AxButton
        intent="quiet"
        size="sm"
        disabled={busy}
        onClick={() => setAsking(true)}
        aria-label={`Revoke ${approval.appName} using ${approval.connectorName}`}
      >
        Revoke
      </AxButton>
      <ConfirmAction
        open={asking}
        onOpenChange={setAsking}
        title="Revoke this permission?"
        description={`${approval.appName} stops using ${approval.connectorName} as you, straight away.`}
        confirmLabel="Revoke"
        onConfirm={onRevoke}
      />
    </li>
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
