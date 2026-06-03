import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { listChatAgents, type ChatAgentSummary } from '@/lib/agents';
import { listAllAllowedSites, setSiteAgents } from '@/lib/connections';
import { SiteAgentsDialog } from './SiteAgentsDialog';

/**
 * "Allowed sites" — the durable per-(user, agent) "always allow" egress host
 * grants, presented as ONE list across all the user's agents. Each host appears
 * once and shows which agents it applies to; per-host Edit opens the agent
 * multi-select, Remove revokes it for every agent. "All agents" means every
 * agent the user has now — a grant per agent — so the underlying egress
 * least-privilege boundary (each session's allowlist is still per-(user, agent))
 * is unchanged; this is purely a management view over those rows.
 *
 * NOT connectors: these are individual hosts, not credentialed services. Hosts
 * render through React text nodes (auto-escaped); never raw inner HTML. shadcn
 * primitives + semantic tokens only (invariant #6).
 */
export function AllowedSitesPanel() {
  const [agents, setAgents] = useState<ChatAgentSummary[]>([]);
  const [grants, setGrants] = useState<Array<{ host: string; agentId: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingHost, setEditingHost] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return listAllAllowedSites()
      .then((g) => setGrants(g.map((x) => ({ host: x.host, agentId: x.agentId }))))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setGrants([]);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    listChatAgents()
      .then((a) => {
        if (!cancelled) setAgents(a);
      })
      .catch(() => {
        // Best-effort: without the agent list the panel still lists hosts; the
        // agent names just fall back to ids and Add is disabled.
      });
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // host → agentIds (sorted host order). Derived from the flat grant list.
  const byHost = new Map<string, string[]>();
  for (const g of grants ?? []) {
    const set = byHost.get(g.host) ?? [];
    set.push(g.agentId);
    byHost.set(g.host, set);
  }
  const hosts = [...byHost.keys()].sort();

  const agentName = (id: string): string =>
    agents.find((a) => a.agentId === id)?.displayName ?? id;
  const isAllAgents = (ids: string[]): boolean =>
    agents.length > 0 && agents.every((a) => ids.includes(a.agentId));

  const removeHost = async (host: string): Promise<void> => {
    try {
      await setSiteAgents(host, [], byHost.get(host) ?? []);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="flex flex-col gap-3.5 border-t border-border pt-5 mt-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Allowed sites</h3>
          <p className="text-xs text-muted-foreground">
            Not connectors — individual hosts your agents are allowed to reach.
            Each site lists which agents it applies to; add one ahead of time, or
            grant it “always allow” when an agent asks mid-task.
          </p>
        </div>
        <Button size="sm" disabled={agents.length === 0} onClick={() => setAdding(true)}>
          Add a site
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="divide-y divide-border">
        {grants === null && !error && (
          <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>
        )}
        {grants !== null && hosts.length === 0 && (
          <div className="px-4 py-3 text-sm text-muted-foreground">
            No allowed sites yet — add one above.
          </div>
        )}
        {hosts.map((host) => {
          const ids = byHost.get(host) ?? [];
          return (
            <div
              key={host}
              data-testid={`allowed-site-${host}`}
              className="flex items-center gap-3 px-4 py-2.5"
            >
              <span className="flex-1 min-w-0 truncate text-sm text-foreground">{host}</span>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {isAllAgents(ids) ? (
                  <Badge variant="secondary">All agents</Badge>
                ) : (
                  ids
                    .slice()
                    .sort()
                    .map((id) => (
                      <Badge key={id} variant="secondary">
                        {agentName(id)}
                      </Badge>
                    ))
                )}
              </div>
              <Button variant="outline" size="sm" onClick={() => setEditingHost(host)}>
                Edit
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void removeHost(host)}>
                Remove
              </Button>
            </div>
          );
        })}
      </Card>

      {adding && (
        <SiteAgentsDialog
          mode="add"
          open
          agents={agents}
          initialAgentIds={[]}
          onOpenChange={(o) => {
            if (!o) setAdding(false);
          }}
          onSaved={() => {
            setAdding(false);
            void refresh();
          }}
        />
      )}

      {editingHost !== null && (
        <SiteAgentsDialog
          mode="edit"
          open
          agents={agents}
          initialHost={editingHost}
          initialAgentIds={byHost.get(editingHost) ?? []}
          onOpenChange={(o) => {
            if (!o) setEditingHost(null);
          }}
          onSaved={() => {
            setEditingHost(null);
            void refresh();
          }}
        />
      )}
    </section>
  );
}
