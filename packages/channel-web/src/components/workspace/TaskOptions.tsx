import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Spinner } from '@/components/ui/spinner';
import { CredentialSlotRow } from '@/components/credentials/CredentialSlotRow';
import { RoutineConsentSection } from '@/components/routines/RoutineConsentSection';
import { routineApi, RoutineApiError, type Routine } from '@/lib/routines';

export function TaskOptions(props: { agentId: string; routineId: string; agentName: string; onWriteSucceeded: () => void; onDeleted: () => void }) {
  return <Collapsible><CollapsibleTrigger asChild><Button variant="ghost">Task options</Button></CollapsibleTrigger>
    <CollapsibleContent className="pt-3"><Options {...props} /></CollapsibleContent></Collapsible>;
}
function Options({ agentId, routineId, agentName, onWriteSucceeded, onDeleted }: Parameters<typeof TaskOptions>[0]) {
  const [row, setRow] = useState<Routine | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [writeFailed, setWriteFailed] = useState(false);
  const [refused, setRefused] = useState(false);
  const operation = useRef<{ requestId: string; revision: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let current = true;
    void routineApi.get({ agentId, routineId }).then(result => {
      if (!current) return;
      if (!result.ownedByCaller || result.origin !== 'authored') { setFailed(true); return; }
      setRow(result); setFailed(false);
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; alive.current = false; };
  }, [agentId, routineId, version]);
  async function remove() {
    if (row === null || busy) return;
    operation.current ??= { requestId: crypto.randomUUID(), revision: row.revision };
    setBusy(true); setWriteFailed(false); setRefused(false);
    try {
      await routineApi.remove({ agentId, routineId, expectedRevision: operation.current.revision, requestId: operation.current.requestId });
      onWriteSucceeded(); if (alive.current) onDeleted();
    } catch (error) {
      if (alive.current) {
        if (error instanceof RoutineApiError && error.status >= 400 && error.status < 500) {
          operation.current = null; setRefused(true);
          if (error.status === 409) setVersion(value => value + 1);
        } else setWriteFailed(true);
      }
    }
    finally { if (alive.current) setBusy(false); }
  }
  return <div className="flex flex-col gap-4">
    <RoutineConsentSection agentId={agentId} agentName={agentName} />
    {failed ? <Alert variant="destructive"><AlertDescription>We couldn’t load task options.
      <Button variant="outline" onClick={() => setVersion(value => value + 1)}>Retry task options</Button></AlertDescription></Alert>
      : row === null ? <Spinner aria-label="Loading task options" /> : <>
        {row.webhook?.hmac && row.permissions.manageSecret && <CredentialSlotRow
          destination={{ kind: 'routine-hmac', agentId, routineId }} slot={{ label: 'Webhook HMAC secret', kind: 'api-key' }}
          scope={{ scope: 'agent', ownerId: agentId }} />}
        {row.permissions.stop && (confirming ? <Alert><AlertDescription className="flex flex-col gap-3">
          <p>Delete this task? It will leave Tasks and no new runs will start. A run already in progress may finish.</p>
          {refused && <p role="alert">The task could not be deleted. Review its current permissions and try again.</p>}
          {writeFailed && <p role="status">We couldn’t confirm the deletion. Retry sends the same request.</p>}
          <div className="flex gap-2"><Button variant="destructive" disabled={busy} onClick={() => void remove()}>{writeFailed ? 'Retry deletion' : 'Delete task'}</Button>
            <Button variant="outline" disabled={busy || writeFailed} onClick={() => setConfirming(false)}>Cancel</Button></div>
        </AlertDescription></Alert> : <Button variant="outline" className="self-start" onClick={() => setConfirming(true)}>Delete task</Button>)}
      </>}
  </div>;
}
