import { useEffect, useState } from 'react';
import { getConnector, type Connector } from '@/lib/connectors';
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

/** A failed full fetch must never fall back to saving a metadata-only summary. */
export function ConnectorEditDialog(props: ConnectorEditDialogProps) {
  const { open, target, isAdmin = false } = props;
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
    void getConnector(
      id,
      isAdmin ? '/admin/connectors' : '/settings/connectors',
    ).then(
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
  }, [open, id, isAdmin, retry]);
  if (!open) return null;
  if (target === 'new') return <RemoteMcpConnectorForm {...props} />;
  if (loaded?.id === id) {
    if (loaded.connector.capabilities.mcpServers[0]?.transport === 'http')
      return <RemoteMcpConnectorForm {...props} connector={loaded.connector} />;
    return <LegacyConnectorEditDialog {...props} />;
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
