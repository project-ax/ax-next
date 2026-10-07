import { useEffect, useMemo, useState } from 'react';
import {
  getConnector,
  type Connector,
  type ConnectorPrefill,
} from '@/lib/connectors';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  LegacyConnectorEditDialog,
  type ConnectorEditDialogProps,
} from './LegacyConnectorEditDialog';
import { RemoteMcpConnectorForm } from './RemoteMcpConnectorForm';

export type { ConnectorEditDialogProps } from './LegacyConnectorEditDialog';

/**
 * Slice 2c — a request with no MCP server (hosts / keys / packages) opens the
 * general editor, which reads a connector to start from. This is that starting
 * point: NOT a saved connector — the target stays `'new'`, so Save creates it.
 * Shared by default (only a shared create clears the request).
 */
function draftFromPrefill(prefill: ConnectorPrefill): Connector {
  return {
    id: prefill.connectorId,
    name: prefill.name,
    description: '',
    usageNote: prefill.usageNote,
    keyMode: prefill.keyMode,
    visibility: 'shared',
    createdAt: '',
    updatedAt: '',
    capabilities: prefill.capabilities,
  };
}

/** A failed full fetch must never fall back to saving a metadata-only summary. */
export function ConnectorEditDialog(props: ConnectorEditDialogProps) {
  const { open, target, prefill } = props;
  // Memoized: the general editor re-seeds its form whenever this object changes.
  const prefillDraft = useMemo(
    () => (prefill ? draftFromPrefill(prefill) : undefined),
    [prefill],
  );
  const id = target === 'new' ? null : target.id;
  const [loaded, setLoaded] = useState<{
    id: string;
    connector: Connector;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setLoaded(null);
    setFailed(false);
    if (!open || !id) return;
    let stale = false;
    // Opened only from Admin › Connectors (slice 2a), so always the admin
    // bundle — the same one the editors below write through.
    void getConnector(id, '/admin/connectors').then(
      (connector) => {
        if (!stale) setLoaded({ id, connector });
      },
      () => {
        if (!stale) setFailed(true);
      },
    );
    return () => {
      stale = true;
    };
  }, [open, id, retry]);
  if (!open) return null;
  if (target === 'new') {
    // "Set it up": an MCP request opens the remote-server form (it reads the
    // prefill itself); anything else opens the general editor.
    if (prefillDraft && prefillDraft.capabilities.mcpServers.length === 0)
      return <LegacyConnectorEditDialog {...props} connector={prefillDraft} />;
    return <RemoteMcpConnectorForm {...props} />;
  }
  if (loaded?.id === id) {
    if (loaded.connector.capabilities.mcpServers.length > 0)
      return <RemoteMcpConnectorForm {...props} connector={loaded.connector} />;
    return <LegacyConnectorEditDialog {...props} connector={loaded.connector} />;
  }
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit connector</DialogTitle>
          <DialogDescription>
            Update the remote server and how we connect.
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <Alert variant="destructive">
            <AlertDescription>
              We couldn’t load this connector. Your existing settings are safe.
            </AlertDescription>
          </Alert>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Loading connector…
          </p>
        )}
        {failed && (
          <Button onClick={() => setRetry((n) => n + 1)}>Try again</Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
