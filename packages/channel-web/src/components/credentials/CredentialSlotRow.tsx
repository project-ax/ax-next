import { useEffect, useState, useCallback, useRef } from 'react';
import { SettingsRow } from '../settings/SettingsLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { Destination } from '@ax/credentials';
import { CredentialSlotForm } from './CredentialSlotForm';
import { adminCredentials, refForDestination, routineSecretConfigured } from '@/lib/credentials';
import { routineApi } from '@/lib/routines';
import { humanizeId, humanizeSlotLabel } from '@/lib/humanize';

export interface CredentialSlotRowProps {
  destination: Destination;
  slot: { label: string; kind: 'api-key'; description?: string };
  scope: { scope: 'global' | 'agent'; ownerId: string | null };
  displayName?: string;
}

export function CredentialSlotRow(props: CredentialSlotRowProps) {
  // A new target gets its own sheet, draft and request lifetime. A late save
  // or status response cannot close or overwrite another task's draft.
  const identity = JSON.stringify([refForDestination(props.destination), props.scope.scope, props.scope.ownerId]);
  return <CredentialSlotTarget key={identity} {...props} />;
}

function CredentialSlotTarget({ destination, slot, scope, displayName }: CredentialSlotRowProps) {
  const ref = refForDestination(destination);
  const [open, setOpen] = useState(false);
  const [isSet, setIsSet] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [routineInfo, setRoutineInfo] = useState<{ name: string; revision: string; manageSecret: boolean } | null>(null);
  const lifetime = useRef(0);
  const routineAgentId = destination.kind === 'routine-hmac' ? destination.agentId : undefined;
  const routineId = destination.kind === 'routine-hmac' ? destination.routineId : undefined;
  const refresh = useCallback(async () => {
    const request = ++lifetime.current;
    setStatus('loading');
    try {
      if (routineAgentId !== undefined && routineId !== undefined) {
        const [routine, configured] = await Promise.all([
          routineApi.get({ agentId: routineAgentId, routineId }),
          routineSecretConfigured({ kind: 'routine-hmac', agentId: routineAgentId, routineId }),
        ]);
        if (request !== lifetime.current) return;
        setRoutineInfo({ name: routine.name, revision: routine.revision, manageSecret: routine.permissions.manageSecret });
        setIsSet(configured);
      } else {
        const list = await adminCredentials.list();
        if (request !== lifetime.current) return;
        setIsSet(list.some(c => c.ref === ref && c.scope === scope.scope && c.ownerId === scope.ownerId));
      }
      setStatus('ready');
    } catch {
      if (request !== lifetime.current) return;
      // An outage is not evidence that no key exists. Never render response
      // details: they could contain credential data from a failing provider.
      setStatus('error');
      setRoutineInfo(null);
    }
  }, [ref, scope.scope, scope.ownerId, routineAgentId, routineId]);
  useEffect(() => {
    void refresh();
    return () => { lifetime.current++; };
  }, [refresh]);
  const humanLabel = humanizeSlotLabel(slot.label, destinationService(destination, routineInfo?.name));
  const destinationLabel = humanDestination(destination, routineInfo?.name);
  const destinationAddsInfo = destinationLabel.length > 0 && !humanLabel.toLowerCase().includes(destinationLabel.toLowerCase());
  const canManage = status === 'ready' && (destination.kind !== 'routine-hmac' || routineInfo?.manageSecret === true);
  const statusLabel = status === 'loading' ? 'Checking…' : status === 'error' ? 'Unavailable' : isSet ? 'Saved' : 'Not set';

  return <>
    {displayName ? <SettingsRow label={displayName} value={status === 'ready' && isSet ? 'Key saved' : statusLabel} onClick={() => { if (canManage) setOpen(true); }} /> : <div className="flex items-center justify-between gap-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-sm">{humanLabel}</span>
        <Badge variant={status === 'ready' && isSet ? 'default' : 'outline'}>{statusLabel}</Badge>
      </div>
      <Button size="sm" variant="outline" disabled={!canManage} onClick={() => setOpen(true)}>{isSet ? 'Replace key' : 'Add key'}</Button>
    </div>}
    {status === 'error' && <Alert variant="destructive">
      <AlertDescription>
        {destination.kind === 'routine-hmac' ? 'Could not check the signing secret.' : 'Could not check this key.'}
        <Button size="sm" variant="outline" onClick={() => void refresh()}>Retry</Button>
      </AlertDescription>
    </Alert>}
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent {...(destinationAddsInfo ? {} : { 'aria-describedby': undefined })}>
        <SheetHeader>
          <SheetTitle>{isSet ? `Replace your ${humanLabel}` : `Add your ${humanLabel}`}</SheetTitle>
          {destinationAddsInfo && <SheetDescription>Used by {destinationLabel}.</SheetDescription>}
        </SheetHeader>
        <div className="mt-4">
          <CredentialSlotForm destination={destination} slot={slot} scope={scope} current={{ set: isSet }}
            {...(destination.kind === 'routine-hmac' && routineInfo?.manageSecret ? { expectedRevision: routineInfo.revision } : {})}
            onSaved={() => { setOpen(false); void refresh(); }} />
        </div>
      </SheetContent>
    </Sheet>
  </>;
}

/**
 * (TASK-344 / audit E1) The service a credential belongs to, for LABELLING
 * only — never for routing. `refForDestination` remains the only thing that
 * decides where a key is stored.
 */
function destinationService(
  d: Destination,
  routineName?: string,
): string | undefined {
  switch (d.kind) {
    case 'provider':
      return d.provider;
    case 'account':
      return d.service;
    case 'skill-slot':
      return d.skillId;
    case 'routine-hmac':
      return routineName;
  }
}

/**
 * (E1) Was "provider anthropic" / "skill linear" / "account anthropic" — the
 * wire's own vocabulary, lowercase, in a sentence shown to a person about to
 * hand over a secret.
 */
function humanDestination(d: Destination, routineName?: string): string {
  const name = destinationService(d, routineName);
  const label = name === undefined ? '' : humanizeId(name);
  switch (d.kind) {
    case 'provider':
    case 'account':
      return label;
    case 'skill-slot':
      return `the ${label} skill`;
    case 'routine-hmac':
      return routineName ? `the ${routineName} routine` : 'the routine';
  }
}
