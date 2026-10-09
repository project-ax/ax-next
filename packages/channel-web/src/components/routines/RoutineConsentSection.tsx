import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { routineApi, type RoutineConsent } from '@/lib/routines';

export function RoutineConsentSection({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName: string;
}) {
  const [consent, setConsent] = useState<RoutineConsent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const readVersion = useRef(0);
  useEffect(() => {
    let active = true;
    setConsent(null);
    setError(null);
    const load = () => {
      const version = ++readVersion.current;
      void routineApi
        .getConsent(agentId)
        .then((value) => {
          if (active && version === readVersion.current) {
            setConsent(value);
            setError(null);
          }
        })
        .catch(() => {
          if (active && version === readVersion.current) {
            setConsent(null);
            setError('Routine permissions are unavailable.');
          }
        });
    };
    const changed = (event: Event) => {
      if (
        (event as CustomEvent<{ agentId: string }>).detail?.agentId === agentId
      )
        load();
    };
    load();
    const poll = window.setInterval(load, 5000);
    window.addEventListener('ax:routine-permissions-changed', changed);
    return () => {
      active = false;
      window.clearInterval(poll);
      window.removeEventListener('ax:routine-permissions-changed', changed);
    };
  }, [agentId]);
  async function revoke() {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      const revoked = await routineApi.revokeConsent(agentId);
      ++readVersion.current;
      setConsent(revoked);
      window.dispatchEvent(
        new CustomEvent('ax:routine-permissions-changed', {
          detail: { agentId },
        }),
      );
    } catch {
      setError('We couldn’t revoke routine permission. Try again.');
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  return (
    <section aria-label="Routine permissions" className="flex flex-col gap-2">
      {consent === null && error === null && (
        <Skeleton
          aria-label="Loading routine permissions"
          className="h-8 w-full"
        />
      )}
      {consent !== null && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">
              {consent.enabled
                ? 'Always allow for this agent'
                : 'Ask before creating or editing routines'}
            </p>
            <p className="text-sm text-muted-foreground">
              {consent.enabled
                ? `${agentName} may create and edit routines for you. Delete and Fire now still ask.`
                : `Choose Always Allow on a request from ${agentName} to permit future creates and edits.`}
            </p>
          </div>
          {consent.enabled && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void revoke()}
            >
              {busy ? 'Revoking…' : 'Revoke'}
            </Button>
          )}
        </div>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
