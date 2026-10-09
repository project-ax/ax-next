import { useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { routineApi, RoutineApiError, type Routine } from '@/lib/routines';
export function FireNowControl({
  routine,
  onFired,
  onPendingChange,
}: {
  routine: Routine;
  onFired: () => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const flight = useRef(false);
  const operation = useRef<{
    agentId: string;
    routineId: string;
    expectedRevision: string;
    requestId: string;
  } | null>(null);
  async function fire() {
    if (flight.current || !routine.permissions.fire || !routine.enabled) return;
    flight.current = true;
    onPendingChange?.(true);
    setBusy(true);
    setStatus(null);
    operation.current ??= {
      agentId: routine.agentId,
      routineId: routine.routineId,
      expectedRevision: routine.revision,
      requestId: crypto.randomUUID(),
    };
    try {
      const result = await routineApi.fireNow(operation.current);
      operation.current = null;
      onFired();
      setFailed(result.status === 'error');
      setStatus(
        result.status === 'ok'
          ? 'Run accepted. Check recent runs for the outcome.'
          : 'We couldn’t start this run. Please try again.',
      );
    } catch (e) {
      setFailed(true);
      setStatus(
        e instanceof RoutineApiError
          ? e.message
          : 'We couldn’t confirm this run. Retry sends the same request.',
      );
      if (e instanceof RoutineApiError && e.status > 0 && e.status < 500)
        operation.current = null;
    } finally {
      flight.current = false;
      setBusy(false);
      onPendingChange?.(operation.current !== null);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={busy || !routine.permissions.fire || !routine.enabled}
        onClick={() => void fire()}
      >
        {busy ? 'Starting…' : 'Fire now'}
      </Button>
      {status &&
        (failed ? (
          <Alert variant="destructive">
            <AlertDescription>{status}</AlertDescription>
          </Alert>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            {status}
          </p>
        ))}
    </div>
  );
}
