import { useEffect, useState, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { Destination } from '@ax/credentials';
import { CredentialSlotForm } from './CredentialSlotForm';
import { adminCredentials, myCredentials, refForDestination } from '@/lib/credentials';

export interface CredentialSlotRowProps {
  destination: Destination;
  slot: { label: string; kind: 'api-key'; description?: string };
  scope: { scope: 'global' | 'user' | 'agent'; ownerId: string | null };
}

export function CredentialSlotRow({ destination, slot, scope }: CredentialSlotRowProps) {
  const ref = refForDestination(destination);
  const [open, setOpen] = useState(false);
  const [isSet, setIsSet] = useState(false);

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
          <span className="font-mono text-xs">{slot.label}</span>
          <Badge variant={isSet ? 'default' : 'outline'}>
            {isSet ? 'Set' : 'Not set'}
          </Badge>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          {isSet ? 'Replace' : 'Set credential'}
        </Button>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>
              Set credential for {humanDestination(destination)}, slot {slot.label}
            </SheetTitle>
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

function humanDestination(d: Destination): string {
  switch (d.kind) {
    case 'provider':
      return `provider ${d.provider}`;
    case 'skill-slot':
      return `skill ${d.skillId}`;
    case 'mcp-env':
      return `MCP server ${d.serverId}`;
    case 'mcp-header':
      return `MCP server ${d.serverId}`;
    case 'routine-hmac':
      return `routine ${d.routinePath}`;
    case 'account':
      return `account ${d.service}`;
  }
}
