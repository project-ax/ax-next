/**
 * ConnectorsTab — the Settings "Connectors" surface (connectors-first-class
 * UI/IA reorg). The user's connector library: connected services their agents
 * can reach, each behind a single calm name.
 *
 * This collapses the audit's mislabeled "Connections" tab + the jargon-heavy
 * "MCP servers" form into one **Connectors** surface. A connector is the
 * first-class ACCESS object; whether it's backed by MCP, a CLI, or a direct
 * API is a MECHANISM that NEVER shows here — the default view names only the
 * service, what it needs (a key / nothing), and connected state. Editing the
 * mechanism lives in the admin Connector registry (behind its Advanced
 * disclosure); a non-admin manages the library and connects, not the wiring.
 *
 * Source badge (design §UI/IA): a connector wears the single "Catalog" tag iff
 * it's admin-curated default-on OR shared into the workspace; a private own
 * connector shows none. A solo user with only private connectors sees no badges
 * and no "catalog" language.
 *
 * Wire: reuses `/admin/connectors` (lib/connectors) — that route is
 * `auth:require-user`-gated + owner-scoped (TASK-98), so a non-admin lists their
 * OWN connectors through it. No new BFF endpoint. Per-agent connector
 * ATTACHMENT stays deferred (design Out of scope).
 *
 * Untrusted text (connector name / description / usageNote) renders through
 * React text nodes (auto-escaped) — never raw HTML.
 */
import { useCallback, useEffect, useState } from 'react';
import { listConnectors, type ConnectorSummary } from '@/lib/connectors';
import { SourceBadge, connectorSource } from '@/components/SourceBadge';
import { RoleCard } from '@/components/admin/RoleCard';
import { StatusDot } from '@/components/admin/StatusDot';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { listChatAgents, type ChatAgentSummary } from '@/lib/agents';
import {
  getAllowedSites,
  revokeAllowedSite,
  type AllowedSite,
} from '@/lib/connections';

/** Mechanism-free "what it needs" caption — keyMode only, no transport vocab. */
function needsCaption(c: ConnectorSummary): string {
  return c.keyMode === 'workspace' ? 'Needs a shared key' : 'Needs a personal key';
}

/** ISO timestamp → short locale date for the "always · <when>" hint. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function ConnectorsTab({ isAdmin }: { isAdmin: boolean }) {
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Allowed sites — the durable per-(user, agent) "always allow" host grants
  // (design P3/P6; backed by @ax/host-grants, TASK-54). A service an agent
  // reaches is a connection too, so the host-grant mirror lives under
  // Connectors. An agent switcher scopes the list.
  const [agents, setAgents] = useState<ChatAgentSummary[]>([]);
  const [agentId, setAgentId] = useState<string>('');
  const [sites, setSites] = useState<AllowedSite[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    listConnectors()
      .then((list) => {
        if (!cancelled) setConnectors(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setConnectors([]);
        }
      });
    listChatAgents()
      .then((a) => {
        if (cancelled) return;
        setAgents(a);
        if (a[0]) setAgentId(a[0].agentId);
      })
      .catch(() => {
        // Best-effort: a missing agent list just hides the allowed-sites card.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadSites = useCallback((id: string) => {
    if (!id) return;
    setSites(null);
    getAllowedSites(id)
      .then((r) => setSites(r.hosts))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    loadSites(agentId);
  }, [agentId, loadSites]);

  const revokeSite = async (host: string) => {
    try {
      await revokeAllowedSite(agentId, host);
      loadSites(agentId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div>
        <h3 className="text-sm font-medium text-foreground">Connected services</h3>
        <p className="text-xs text-muted-foreground">
          Services your assistant can reach. Each one bundles what it needs —
          a key, the data it talks to — behind a single name.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {connectors === null && !error && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}

      {connectors !== null && connectors.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">
          No connected services yet. {isAdmin ? 'Add one from the connector registry to get started.' : 'Your assistant will offer to connect a service when it needs one.'}
        </p>
      )}

      {connectors !== null && connectors.length > 0 && (
        <div className="flex flex-col gap-3.5">
          {connectors.map((c) => (
            <div key={c.id} data-testid={`connector-tile-${c.id}`}>
              <RoleCard pill="service" title={c.name} caption={needsCaption(c)}>
                <div className="flex items-center justify-end gap-2">
                  <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground mr-auto">
                    <StatusDot variant="ok" />
                    connected
                  </span>
                  <SourceBadge source={connectorSource(c)} />
                </div>
              </RoleCard>
            </div>
          ))}
        </div>
      )}

      {/* Allowed sites — the durable "always for this agent" host grants
          (design P3/P6). Revoking removes the durable grant so it is not
          re-loaded into the next session's allowlist. Hosts are untrusted text
          → React text nodes (auto-escaped); never raw inner HTML. */}
      {agents.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-3 pt-2">
            <h3 className="text-sm font-medium text-foreground">
              Allowed sites
            </h3>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.agentId} value={a.agentId}>
                    {a.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Card className="divide-y divide-border">
            {sites === null && !error && (
              <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>
            )}
            {sites?.length === 0 && (
              <div className="px-4 py-3 text-sm text-muted-foreground">
                No allowed sites.
              </div>
            )}
            {sites?.map((site) => (
              <div key={site.host} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex-1 min-w-0 truncate text-sm text-foreground">
                  {site.host}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  always · {shortDate(site.grantedAt)}
                </span>
                <Button variant="ghost" size="sm" onClick={() => revokeSite(site.host)}>
                  Revoke
                </Button>
              </div>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}
