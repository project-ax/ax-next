import { useEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { validateWebhookPath } from '@ax/routines-contract';
import { routineApi, type RoutineReceiver } from '@/lib/routines';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

export function WebhookAddressFields({ agentId, routineId, path, saved, disabled, onPendingChange }: {
  agentId: string; routineId?: string | undefined; path: string; saved: boolean; disabled: boolean;
  onPendingChange: (pending: boolean) => void;
}) {
  const [receiver, setReceiver] = useState<RoutineReceiver | null>(null);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const flight = useRef(false);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!routineId) return;
    let active = true;
    setReceiver(null); setFailed(false); setNotice('');
    void routineApi.getTaskReceiver({ agentId, routineId }).then(value => { if (active) setReceiver(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [agentId, routineId, generation]);
  async function replace() {
    if (flight.current || !routineId || !receiver) return;
    flight.current = true; setBusy(true); onPendingChange(true); setNotice('');
    try {
      const next = await routineApi.replaceTaskReceiver({ agentId, routineId }, receiver.version);
      if (alive.current) { setReceiver(next); setConfirm(false); setNotice('Address replaced. Update the address in the other app.'); }
    } catch {
      // The write may have landed. Hide the earlier address and read current state;
      // never retry a replacement blindly after an unknown response.
      if (alive.current) { setReceiver(null); setFailed(true); setConfirm(false); }
    } finally {
      flight.current = false;
      if (alive.current) { setBusy(false); onPendingChange(false); }
    }
  }
  if (!routineId) return <FieldDescription>Save this task to get its own webhook address.</FieldDescription>;
  if (failed) return <Alert variant="destructive"><AlertDescription>We couldn’t load the current address. Reload it before copying or replacing it.
    <Button type="button" variant="outline" disabled={disabled} onClick={() => setGeneration(v => v + 1)}>Retry app setup</Button>
  </AlertDescription></Alert>;
  if (!receiver) return <Skeleton aria-label="Loading webhook address" className="h-10 w-full" />;
  const preview = validateWebhookPath(path) ? `${new URL(receiver.url, window.location.origin).href}${path}` : null;
  return <Field>
    <FieldLabel>Webhook URL</FieldLabel>
    {preview ? <div className="flex min-w-0 gap-2"><Input aria-label="Webhook URL" readOnly value={preview} />
      <Button type="button" variant="outline" disabled={disabled} aria-label="Copy webhook URL" onClick={() => {
        void navigator.clipboard?.writeText(preview).then(() => setNotice('Copied webhook URL.')).catch(() => setNotice('Couldn’t copy. Select the URL to copy it.'));
      }}><Copy data-icon="inline-start" /></Button>
    </div> : <FieldDescription>Enter a valid path to preview the webhook URL.</FieldDescription>}
    <FieldDescription>{saved ? 'This address belongs only to this task.' : 'Preview only — save to apply path changes.'}</FieldDescription>
    {receiver.legacyActive && <FieldDescription>Existing app addresses still work. Replacing this address also turns off those earlier addresses for this task.</FieldDescription>}
    <Button type="button" variant="outline" className="self-start" disabled={disabled || busy} onClick={() => setConfirm(true)}>Replace address</Button>
    <span role="status" className="text-xs text-muted-foreground">{notice}</span>
    <Dialog open={confirm} onOpenChange={open => { if (!busy) setConfirm(open); }}>
      <DialogContent><DialogHeader><DialogTitle>Replace this task’s address?</DialogTitle>
        <DialogDescription>Its current and earlier addresses will stop accepting updates. Copy the new address into the other app afterward. Other tasks keep their addresses.</DialogDescription>
      </DialogHeader><DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm(false)}>Keep address</Button>
        <Button type="button" disabled={busy} onClick={() => { void replace(); }}>{busy ? 'Replacing…' : 'Replace address'}</Button>
      </DialogFooter></DialogContent>
    </Dialog>
  </Field>;
}
