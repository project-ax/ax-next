import { useEffect, useState } from 'react';
import { routineApi, type Routine } from '@/lib/routines';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { CredentialSlotRow } from '@/components/credentials/CredentialSlotRow';
import { WebhookAddressFields } from '@/components/routines/WebhookAddressFields';

/** Private setup stays behind a current owner/edit read; generic task details carry no address. */
export function TaskAppUpdates({ agentId, routineId, onEdit }: { agentId: string; routineId: string; onEdit: () => void }) {
  // A new target starts with no loaded address or credential state, even before effects run.
  return <AppSetup key={`${agentId}/${routineId}`} agentId={agentId} routineId={routineId} onEdit={onEdit} />;
}
function AppSetup({ agentId, routineId, onEdit }: Parameters<typeof TaskAppUpdates>[0]) {
  const [row, setRow] = useState<Routine | null>(null);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    setRow(null); setFailed(false);
    void routineApi.get({ agentId, routineId }).then(value => {
      if (!current) return;
      if (value.agentId !== agentId || value.routineId !== routineId || !value.ownedByCaller || !value.permissions.edit || value.origin !== 'authored' || value.webhook === null) {
        setFailed(true); return;
      }
      setRow(value);
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [agentId, routineId, generation]);
  return <Card aria-label="App update setup">
    <CardHeader><CardTitle>Updates from another app</CardTitle>
      <CardDescription>{row?.kind === 'repeat' ? 'Each accepted update queues one run.' : `Batch updates into a check-in within ${row?.webhook?.respondWithin ?? '5m'}, during active hours.`}</CardDescription>
    </CardHeader>
    <CardContent>
      {failed ? <Alert variant="destructive"><AlertDescription>We couldn’t load app setup. Your access or the task may have changed.
        <Button type="button" variant="outline" onClick={() => setGeneration(value => value + 1)}>Reload app setup</Button>
      </AlertDescription></Alert> : row?.webhook ? <FieldGroup>
        <p className="text-sm">Paste this address into the other app’s webhook settings.</p>
        <WebhookAddressFields agentId={agentId} routineId={routineId} path={row.webhook.path} saved disabled={busy} onPendingChange={setBusy} />
        {row.webhook.hmac && row.permissions.manageSecret ? <CredentialSlotRow
          destination={{ kind: 'routine-hmac', agentId, routineId }} slot={{ label: 'Webhook signing secret', kind: 'api-key' }}
          scope={{ scope: 'agent', ownerId: agentId }} /> : <p className="text-sm text-muted-foreground">{row.webhook.hmac ? 'Signing secret management is currently unavailable.' : 'Signature verification is recommended. Choose the app in Edit app setup, then save its signing secret here.'}</p>}
        <p className="text-sm text-muted-foreground">The address and signing secret stay private. The agent receives only the app’s updates.</p>
      </FieldGroup> : <Skeleton aria-label="Loading app setup" className="h-24 w-full" />}
    </CardContent>
    <CardFooter><Button type="button" variant="outline" disabled={row === null || busy} onClick={onEdit}>Edit app setup</Button></CardFooter>
  </Card>;
}
