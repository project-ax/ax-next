import { useEffect, useRef, useState } from 'react';
import { AsyncState, ConfirmAction, Notice } from '@project-ax/ui';
import { focusAfterRemoval } from '@/lib/focus-after-removal';
import { ALWAYS_ALLOW_STILL_ASKS } from '@/components/workspace/decision-copy';
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
  const readVersion = useRef(0);
  const reload = useRef<() => void>(() => {});
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
            setError('Task permissions are unavailable.');
          }
        });
    };
    const changed = (event: Event) => {
      if (
        (event as CustomEvent<{ agentId: string }>).detail?.agentId === agentId
      )
        load();
    };
    reload.current = load;
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
    // A failure is shown inside the confirmation, and the grant stays.
    const revoked = await routineApi.revokeConsent(agentId);
    ++readVersion.current;
    setConsent(revoked);
    window.dispatchEvent(
      new CustomEvent('ax:routine-permissions-changed', {
        detail: { agentId },
      }),
    );
    // The Revoke button leaves with the grant; park focus on this section.
    focusAfterRemoval('[data-return-focus="routine-consent"]');
  }
  return (
    <section aria-label="Task permissions" className="flex flex-col gap-2" tabIndex={-1} data-return-focus="routine-consent">
      {consent === null && error === null && (
        <AsyncState status="loading" skeleton="lines" loadingLabel="Loading task permissions" />
      )}
      {consent !== null && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">
              {consent.enabled
                ? 'Always allow for this agent'
                : 'Ask before creating or editing tasks'}
            </p>
            <p className="text-sm text-muted-foreground">
              {consent.enabled
                ? `${agentName} may create and edit tasks for you. ${ALWAYS_ALLOW_STILL_ASKS}`
                : `Choose Always Allow on a request from ${agentName} to permit future creates and edits.`}
            </p>
          </div>
          {consent.enabled && (
            <ConfirmAction
              trigger={{ label: 'Revoke', intent: 'secondary', size: 'sm' }}
              title="Revoke this permission?"
              description={`${agentName} will ask before creating or editing tasks again. Anything already running may still have it until it finishes.`}
              confirmLabel="Revoke"
              errorMessage={() => 'We couldn’t revoke task permission. Try again.'}
              onConfirm={revoke}
            />
          )}
        </div>
      )}
      {error && (
        <Notice tone="danger" action={{ label: 'Try again', onClick: () => reload.current() }}>
          {error}
        </Notice>
      )}
    </section>
  );
}
