import { useEffect, useState, useCallback } from 'react';
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
import { adminCredentials, myCredentials, refForDestination } from '@/lib/credentials';
import { humanizeId, humanizeSlotLabel } from '@/lib/humanize';

export interface CredentialSlotRowProps {
  destination: Destination;
  slot: { label: string; kind: 'api-key'; description?: string };
  scope: { scope: 'global' | 'user' | 'agent'; ownerId: string | null };
}

export function CredentialSlotRow({ destination, slot, scope }: CredentialSlotRowProps) {
  const ref = refForDestination(destination);
  const [open, setOpen] = useState(false);
  const [isSet, setIsSet] = useState(false);
  // Display only. `ref` above is what actually decides where the key is stored,
  // and nothing here feeds it — reusing TASK-334's shared helper (invariant 4:
  // one humanizer, not one per surface).
  const humanLabel = humanizeSlotLabel(slot.label, destinationService(destination));

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
   * does not have: "the Linear skill", "the Linear server", "the daily-digest
   * routine". So the test is overlap, not destination kind — the same test
   * `humanizeSlotLabel` itself uses to avoid "Linear tracker Linear token".
   */
  const destinationLabel = humanDestination(destination);
  const destinationAddsInfo =
    destinationLabel.length > 0 &&
    !humanLabel.toLowerCase().includes(destinationLabel.toLowerCase());

  const refresh = useCallback(async () => {
    try {
      const list =
        scope.scope === 'user'
          ? await myCredentials.list()
          : await adminCredentials.list();
      setIsSet(
        list.some(
          (c) => c.ref === ref && c.scope === scope.scope && c.ownerId === scope.ownerId,
        ),
      );
    } catch (err) {
      // Treat list failure as "not set" so the UI doesn't show stale state.
      setIsSet(false);
      console.warn('CredentialSlotRow: failed to refresh credential status', err);
    }
  }, [ref, scope.scope, scope.ownerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <div className="flex items-center justify-between gap-3 py-2">
        <div className="flex items-center gap-2">
          {/* (E1) The row led with the raw slot id in mono — `ANTHROPIC_API_KEY`
              as the name of the thing you are being asked for. */}
          <span className="text-sm">{humanLabel}</span>
          <Badge variant={isSet ? 'default' : 'outline'}>
            {isSet ? 'Saved' : 'Not set'}
          </Badge>
        </div>
        {/* (E1) "Set credential" is our noun, not the reader's. */}
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          {isSet ? 'Replace key' : 'Add key'}
        </Button>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        {/* Radix warns when a dialog has no description; tell it that is
            deliberate rather than leaving an empty one to satisfy it. */}
        <SheetContent {...(destinationAddsInfo ? {} : { 'aria-describedby': undefined })}>
          <SheetHeader>
            {/* (E1) Was "Set credential for provider anthropic, slot
                ANTHROPIC_API_KEY" — three machine identifiers in one sentence,
                at the moment a person is deciding whether to trust us with a
                secret. */}
            <SheetTitle>{isSet ? `Replace your ${humanLabel}` : `Add your ${humanLabel}`}</SheetTitle>
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
function destinationService(d: Destination): string | undefined {
  switch (d.kind) {
    case 'provider':
      return d.provider;
    case 'account':
      return d.service;
    case 'skill-slot':
      return d.skillId;
    case 'mcp-env':
    case 'mcp-header':
      return d.serverId;
    case 'routine-hmac':
      // A routine path is a file path, not a name; `humanizeId` on
      // `.ax/routines/daily-digest.md` would produce "Ax routines daily digest
      // md". Take the stem.
      return d.routinePath.split('/').pop()?.replace(/\.md$/, '');
  }
}

/**
 * (E1) Was "provider anthropic" / "skill linear" / "account anthropic" — the
 * wire's own vocabulary, lowercase, in a sentence shown to a person about to
 * hand over a secret.
 */
function humanDestination(d: Destination): string {
  const name = destinationService(d);
  const label = name === undefined ? '' : humanizeId(name);
  switch (d.kind) {
    case 'provider':
    case 'account':
      return label;
    case 'skill-slot':
      return `the ${label} skill`;
    case 'mcp-env':
    case 'mcp-header':
      return `the ${label} server`;
    case 'routine-hmac':
      return `the ${label} routine`;
  }
}
