import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { setSiteAgents } from '@/lib/connections';
import type { ChatAgentSummary } from '@/lib/agents';

/**
 * Add or edit which agents an allowed-site host applies to. One dialog for both
 * flows: `add` enters a new host + picks agents; `edit` adjusts the agent set of
 * an existing host. "All agents" means EVERY agent you have right now (a grant
 * per agent) — the per-(user, agent) egress boundary is unchanged; this is just a
 * management view over those rows.
 *
 * The typed host is UNTRUSTED — the server (@ax/host-grants) is the authoritative
 * validator + cap; this field only relays it and surfaces the rejection inline.
 * shadcn primitives + semantic tokens only (invariant #6).
 */
export function SiteAgentsDialog({
  mode,
  open,
  onOpenChange,
  agents,
  initialHost,
  initialAgentIds,
  onSaved,
}: {
  mode: 'add' | 'edit';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: ChatAgentSummary[];
  initialHost?: string;
  initialAgentIds: string[];
  onSaved: () => void;
}) {
  const [host, setHost] = useState(initialHost ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(initialAgentIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to the supplied initial state each time the dialog opens (so a reopen
  // never carries over a prior edit). In add mode default to ALL agents — the
  // common intent — which the user can narrow before saving.
  useEffect(() => {
    if (!open) return;
    setHost(initialHost ?? '');
    setSelected(
      mode === 'add' ? new Set(agents.map((a) => a.agentId)) : new Set(initialAgentIds),
    );
    setError(null);
  }, [open]);

  const allChecked = agents.length > 0 && agents.every((a) => selected.has(a.agentId));

  function toggleAll(): void {
    setSelected(allChecked ? new Set() : new Set(agents.map((a) => a.agentId)));
  }
  function toggleAgent(agentId: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  const trimmedHost = host.trim();
  const canSave =
    !busy && selected.size > 0 && (mode === 'edit' || trimmedHost.length > 0);

  async function save(): Promise<void> {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const targetHost = mode === 'add' ? trimmedHost : (initialHost ?? '');
      await setSiteAgents(targetHost, [...selected], initialAgentIds);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onOpenChange(false))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'add' ? 'Add a site' : `Edit agents for ${initialHost ?? ''}`}
          </DialogTitle>
          <DialogDescription>
            Choose which of your agents may reach this site. “All agents” covers
            every agent you have now.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {mode === 'add' && (
            <div className="grid gap-1.5">
              <Label htmlFor="allowed-site-host">Site</Label>
              <Input
                id="allowed-site-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="example.com"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">Applies to</span>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox
                aria-label="All agents"
                checked={allChecked}
                onCheckedChange={() => toggleAll()}
              />
              All agents
            </label>
            <div className="flex flex-col gap-2 border-t border-border pt-2">
              {agents.map((a) => (
                <label
                  key={a.agentId}
                  className="flex items-center gap-2 text-sm text-foreground"
                >
                  <Checkbox
                    aria-label={a.displayName}
                    checked={selected.has(a.agentId)}
                    onCheckedChange={() => toggleAgent(a.agentId)}
                  />
                  {a.displayName}
                </label>
              ))}
            </div>
          </div>

          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!canSave} onClick={() => void save()}>
              {busy ? 'Saving…' : mode === 'add' ? 'Add' : 'Save'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
