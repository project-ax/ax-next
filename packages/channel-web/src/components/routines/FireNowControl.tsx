/**
 * FireNowControl — per-row "Fire now" affordance.
 *
 *   - interval/cron: a single Button that fires immediately. Toast-style
 *     feedback is rendered inline below the row (no Sonner dependency).
 *   - webhook: clicking the Button reveals an inline JSON textarea + a
 *     Submit. This avoids a nested-Dialog which would create
 *     focus-trap / aria headaches when a modal is open over the Routines tab.
 *
 * Successful fire bumps the parent's refresh key so the routine's
 * last_status / last_run_at reflect the new row immediately.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { routines, type Routine } from '../../lib/routines';

interface Props {
  routine: Routine;
  onFired: () => void;
}

export function FireNowControl({ routine, onFired }: Props) {
  const isWebhook = routine.trigger.kind === 'webhook';
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function doFire(parsedPayload: unknown): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      const out = await routines.fireNow({
        agentId: routine.agentId,
        path: routine.path,
        ...(parsedPayload !== undefined ? { payload: parsedPayload } : {}),
      });
      setStatus({ kind: 'ok', text: `Fired (#${out.fireId}, ${out.status})` });
      onFired();
      // Auto-dismiss the success line so the row doesn't stay noisy.
      setTimeout(() => setStatus(null), 2_500);
      if (isWebhook) setOpen(false);
    } catch (err) {
      setStatus({
        kind: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  function onClickFire(): void {
    if (!isWebhook) {
      void doFire(undefined);
      return;
    }
    setOpen((v) => !v);
  }

  function onSubmitWebhook(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (err) {
      setStatus({
        kind: 'err',
        text: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    void doFire(parsed);
  }

  return (
    <div className="flex flex-col items-end gap-1 shrink-0">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={onClickFire}
        aria-expanded={isWebhook ? open : undefined}
      >
        {busy ? 'Firing…' : 'Fire now'}
      </Button>
      {isWebhook && open && (
        <div className="w-[280px] flex flex-col gap-1.5 animate-in fade-in-0 slide-in-from-top-1 duration-150">
          <Textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            placeholder='{"key": "value"}'
            aria-label="JSON payload for webhook fire"
            rows={3}
            className="font-mono text-[11.5px]"
          />
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={onSubmitWebhook} disabled={busy}>
              {busy ? 'Firing…' : 'Submit'}
            </Button>
          </div>
        </div>
      )}
      {status !== null && (
        <span
          className={
            status.kind === 'ok'
              ? 'text-[11px] text-muted-foreground'
              : 'text-[11px] text-destructive max-w-[280px] text-right'
          }
        >
          {status.text}
        </span>
      )}
    </div>
  );
}
