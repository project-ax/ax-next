import { useCallback, useEffect, useState } from 'react';
import { AsyncState, Card, ConfirmAction, EmptyState, List, ListRow } from '@project-ax/ui';
import { focusAfterRemoval } from '@/lib/focus-after-removal';
import { Button } from '@/components/ui/button';
import { listChatAgents, type ChatAgentSummary } from '@/lib/agents';
import { listAllAllowedSites, setSiteAgents } from '@/lib/connections';
import { SiteAgentsDialog } from './SiteAgentsDialog';

/**
 * "Allowed sites" — the durable "always allow" egress host grants of the
 * user's PERSONAL agents, presented as ONE list. Each host appears once and
 * shows which agents it applies to; per-host Edit opens the agent
 * multi-select, Remove revokes it for every agent. "All agents" means every
 * personal agent the user has now — a grant per agent — so the underlying
 * egress least-privilege boundary (each session's allowlist is per agent) is
 * unchanged; this is purely a management view over those rows.
 *
 * A TEAM agent's sites belong to the agent and reach every member (TASK-1212),
 * so they are not listed or edited here: any member could otherwise change
 * what the whole team's agent may reach. They live in that agent's settings
 * (Connectors), where only its owners and team admins can remove them. The
 * server refuses these routes for a team agent too; this filter is the
 * friendly half. Without the agent list we cannot tell personal from team, so
 * the panel says so instead of guessing.
 *
 * NOT connectors: these are individual hosts, not credentialed services. Hosts
 * render through React text nodes (auto-escaped); never raw inner HTML. shadcn
 * primitives + semantic tokens only (invariant #6).
 */
export function AllowedSitesPanel() {
  const [agents, setAgents] = useState<ChatAgentSummary[]>([]);
  // Some agents, none of them personal: nothing here is theirs to manage.
  const [onlyTeamAgents, setOnlyTeamAgents] = useState(false);
  const [grants, setGrants] = useState<Array<{ host: string; agentId: string }> | null>(null);
  // False until the agent list loads; stays false when it can't be read.
  const [agentsLoaded, setAgentsLoaded] = useState(false);
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

  const loadAgents = useCallback((isCancelled: () => boolean) => {
    return listChatAgents()
      .then((a) => {
        if (isCancelled()) return;
        const personal = a.filter((x) => x.visibility === 'personal');
        setAgents(personal);
        setOnlyTeamAgents(a.length > 0 && personal.length === 0);
        setAgentsLoaded(true);
      })
      .catch(() => {
        // Without the agent list we cannot tell personal agents from team
        // ones, so listing every grant would put a team agent's sites here.
        if (!isCancelled()) {
          setError(
            'We couldn’t load your agents just now, so we can’t show your allowed sites.',
          );
        }
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadAgents(() => cancelled);
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [loadAgents, refresh]);

  // Re-read both lists. The error clears first so a retry that fails again
  // shows the notice again rather than a stale one.
  const retryReads = (): void => {
    setError(null);
    setGrants(null);
    void loadAgents(() => false);
    void refresh();
  };

  // host → agentIds (sorted host order). Derived from the flat grant list.
  const byHost = new Map<string, string[]>();
  const personalIds = new Set(agents.map((a) => a.agentId));
  for (const g of agentsLoaded ? (grants ?? []) : []) {
    if (!personalIds.has(g.agentId)) continue;
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
    // A failure is shown inside the confirmation, and the site stays listed.
    await setSiteAgents(host, [], byHost.get(host) ?? []);
    await refresh();
    // The site's row is gone; park focus on the panel's primary action.
    focusAfterRemoval('[data-return-focus="allowed-sites"]');
  };

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Allowed sites</h2>
          {/* (TASK-344 / audit E6) Matches the lead-in A12 put on the permission
              card: say what the list IS before showing it, in the same words.
              This opened on "Not connectors" — a negation about our own
              taxonomy, leading with what the thing is not. */}
          <p className="text-xs text-muted-foreground">
            Sites your agents may reach. These are plain web addresses rather
            than connected services, and each one lists which agents it applies
            to — add a site ahead of time, or allow it when an agent asks
            mid-task. A team agent’s sites are in that agent’s settings, under
            Connectors.
          </p>
        </div>
        <Button size="sm" data-return-focus="allowed-sites" disabled={agents.length === 0} onClick={() => setAdding(true)}>
          Add a site
        </Button>
      </div>

      {error && (
        <AsyncState
          status="error"
          skeleton="rows"
          loadingLabel="Loading allowed sites"
          error={{ message: error, onRetry: retryReads }}
        />
      )}

      <Card flush>
        {(grants === null || !agentsLoaded) && !error && (
          <AsyncState status="loading" skeleton="rows" loadingLabel="Loading allowed sites" />
        )}
        {grants !== null && agentsLoaded && !error && hosts.length === 0 && (
          // With Add disabled, "add one above" would point at nothing.
          <EmptyState
            title={onlyTeamAgents ? 'Your agents are all team agents' : 'No allowed sites yet'}
            description={
              onlyTeamAgents
                ? 'Their sites are in each agent’s settings, under Connectors.'
                : 'Add one above.'
            }
          />
        )}
        {hosts.length > 0 && (
          <List label="Allowed sites">
            {hosts.map((host) => {
              const ids = byHost.get(host) ?? [];
              return (
                <ListRow
                  key={host}
                  title={host}
                  description={isAllAgents(ids) ? 'All agents' : ids.slice().sort().map(agentName).join(', ')}
                  trailing={<>
                    <Button variant="outline" size="sm" onClick={() => setEditingHost(host)}>
                      Edit
                    </Button>
                    <ConfirmAction
                      trigger={{ label: 'Remove', intent: 'quiet', size: 'sm' }}
                      title={`Remove ${host}?`}
                      description={`Your agents can no longer reach ${host} until you allow it again.`}
                      confirmLabel="Remove site"
                      errorMessage={(e) => (e instanceof Error ? e.message : String(e))}
                      onConfirm={() => removeHost(host)}
                    />
                  </>}
                />
              );
            })}
          </List>
        )}
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
