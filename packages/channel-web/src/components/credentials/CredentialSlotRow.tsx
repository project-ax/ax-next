import { useEffect, useState, useCallback } from 'react';
import { SettingsRow } from '../settings/SettingsLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { Destination } from '@ax/credentials';
import { CredentialSlotForm } from './CredentialSlotForm';
import { adminCredentials, refForDestination } from '@/lib/credentials';
import { routineApi } from '@/lib/routines';
import { humanizeId, humanizeSlotLabel } from '@/lib/humanize';

export interface CredentialSlotRowProps {
  destination: Destination;
  slot: { label: string; kind: 'api-key'; description?: string };
  /** Admin-set keys only: a model provider's (global) or a routine's (agent). */
  scope: { scope: 'global' | 'agent'; ownerId: string | null };
  displayName?: string;
}

export function CredentialSlotRow({
  destination,
  slot,
  scope,
  displayName,
}: CredentialSlotRowProps) {
  const ref = refForDestination(destination);
  const [open, setOpen] = useState(false);
  const [isSet, setIsSet] = useState(false);
  const [routineInfo, setRoutineInfo] = useState<{
    ref: string;
    name: string;
    revision: string;
    manageSecret: boolean;
  } | null>(null);
  const routineAgentId =
    destination.kind === 'routine-hmac' ? destination.agentId : undefined;
  const routineId =
    destination.kind === 'routine-hmac' ? destination.routineId : undefined;
  const authorizedRoutine = routineInfo?.ref === ref ? routineInfo : null;
  useEffect(() => {
    let active = true;
    setRoutineInfo(null);
    if (routineAgentId !== undefined && routineId !== undefined) {
      void routineApi
        .get({ agentId: routineAgentId, routineId })
        .then((routine) => {
          if (active)
            setRoutineInfo({
              ref,
              name: routine.name,
              revision: routine.revision,
              manageSecret: routine.permissions.manageSecret,
            });
        })
        .catch(() => {
          if (active) setRoutineInfo(null);
        });
    }
    return () => {
      active = false;
    };
  }, [ref, routineAgentId, routineId]);
  // Display only. `ref` above is what actually decides where the key is stored,
  // and nothing here feeds it — reusing TASK-334's shared helper (invariant 4:
  // one humanizer, not one per surface).
  const humanLabel = humanizeSlotLabel(
    slot.label,
    destinationService(destination, authorizedRoutine?.name),
  );

  /*
   * (TASK-344 / audit E1 left this open; a browser walk closed it.)
   *
   * The sheet read:
   *
   *     Add your OpenRouter API key
   *     Used by OpenRouter.
   *
   * For a `provider` or `account` destination `humanDestination` returns the
   * bare service name, and `humanizeSlotLabel` has ALREADY folded that same
   * name into the title — so the description is a strict substring of the line
   * directly above it. Zero information, at the exact moment someone is
   * deciding whether to hand us a secret.
   *
   * It earns its place for every other kind, because those add a noun the title
   * does not have: "the Linear skill", "the daily-digest routine". So the test
   * is overlap, not destination kind — the same test `humanizeSlotLabel`
   * itself uses to avoid "Linear tracker Linear token".
   */
  const destinationLabel = humanDestination(
    destination,
    authorizedRoutine?.name,
  );
  const destinationAddsInfo =
    destinationLabel.length > 0 &&
    !humanLabel.toLowerCase().includes(destinationLabel.toLowerCase());

  const refresh = useCallback(async () => {
    try {
      const list = await adminCredentials.list();
      setIsSet(
        list.some(
          (c) =>
            c.ref === ref &&
            c.scope === scope.scope &&
            c.ownerId === scope.ownerId,
        ),
      );
    } catch (err) {
      // Treat list failure as "not set" so the UI doesn't show stale state.
      setIsSet(false);
      console.warn(
        'CredentialSlotRow: failed to refresh credential status',
        err,
      );
    }
  }, [ref, scope.scope, scope.ownerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      {displayName ? <SettingsRow label={displayName} value={isSet ? 'Key saved' : 'Not set'} onClick={() => setOpen(true)} /> : <div className="flex items-center justify-between gap-3 py-2">
        <div className="flex items-center gap-2">
          {/* (E1) The row led with the raw slot id in mono — `ANTHROPIC_API_KEY`
              as the name of the thing you are being asked for. */}
          <span className="text-sm">{humanLabel}</span>
          <Badge variant={isSet ? 'default' : 'outline'}>
            {isSet ? 'Saved' : 'Not set'}
          </Badge>
        </div>
        {/* (E1) "Set credential" is our noun, not the reader's. */}
        <Button
          size="sm"
          variant="outline"
          disabled={
            destination.kind === 'routine-hmac' &&
            !authorizedRoutine?.manageSecret
          }
          onClick={() => setOpen(true)}
        >
          {isSet ? 'Replace key' : 'Add key'}
        </Button>
      </div>}
      <Sheet open={open} onOpenChange={setOpen}>
        {/* Radix warns when a dialog has no description; tell it that is
            deliberate rather than leaving an empty one to satisfy it. */}
        <SheetContent
          {...(destinationAddsInfo ? {} : { 'aria-describedby': undefined })}
        >
          <SheetHeader>
            {/* (E1) Was "Set credential for provider anthropic, slot
                ANTHROPIC_API_KEY" — three machine identifiers in one sentence,
                at the moment a person is deciding whether to trust us with a
                secret. */}
            <SheetTitle>
              {isSet ? `Replace your ${humanLabel}` : `Add your ${humanLabel}`}
            </SheetTitle>
            {/* Which thing this key is actually for. The row it was opened from
                may be one of several, and "API key" alone does not say whose —
                except when the title already said it. See above. */}
            {destinationAddsInfo && (
              <SheetDescription>Used by {destinationLabel}.</SheetDescription>
            )}
          </SheetHeader>
          <div className="mt-4">
            <CredentialSlotForm
              destination={destination}
              slot={slot}
              scope={scope}
              current={{ set: isSet }}
              {...(destination.kind === 'routine-hmac' && authorizedRoutine
                ? { expectedRevision: authorizedRoutine.revision }
                : {})}
              onSaved={() => {
                setOpen(false);
                void refresh();
              }}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
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
