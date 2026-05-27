/**
 * ConnectionsTab (TASK-42) — the Settings "Connections" surface: a per-(user,
 * agent) view of "what this agent can do," merged from default / agent-global /
 * per-user sources by the channel-web BFF. An agent switcher picks the agent;
 * default + agent-global skills are locked, user-added skills are removable.
 *
 * Skill descriptions are admin/agent-authored UNTRUSTED text — they render
 * through React text nodes, so React auto-escapes them; this component never
 * sets raw inner HTML.
 */
import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
  getConnections,
  detachConnectionSkill,
  getAllowedSites,
  revokeAllowedSite,
  type ConnectionSkill,
  type AllowedSite,
} from '@/lib/connections';

const SOURCE_LABEL: Record<ConnectionSkill['source'], string> = {
  default: 'default',
  agent: 'agent',
  user: 'you',
};

/** ISO timestamp → short locale date for the "always · <when>" hint. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function ConnectionsTab() {
  const [agents, setAgents] = useState<ChatAgentSummary[]>([]);
  const [agentId, setAgentId] = useState<string>('');
  const [skills, setSkills] = useState<ConnectionSkill[] | null>(null);
  const [sites, setSites] = useState<AllowedSite[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listChatAgents()
      .then((a) => {
        setAgents(a);
        if (a[0]) setAgentId(a[0].agentId);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const load = useCallback((id: string) => {
    if (!id) return;
    setSkills(null);
    setSites(null);
    setError(null);
    getConnections(id)
      .then((r) => setSkills(r.skills))
      .catch((e: unknown) => setError(String(e)));
    getAllowedSites(id)
      .then((r) => setSites(r.hosts))
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => {
    load(agentId);
  }, [agentId, load]);

  const remove = async (skillId: string) => {
    try {
      await detachConnectionSkill(agentId, skillId);
      load(agentId);
    } catch (e: unknown) {
      setError(String(e));
    }
  };

  const revokeSite = async (host: string) => {
    try {
      await revokeAllowedSite(agentId, host);
      load(agentId);
    } catch (e: unknown) {
      setError(String(e));
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">What this agent can do</h3>
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

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="divide-y divide-border">
        {skills === null && !error && (
          <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>
        )}
        {skills?.length === 0 && (
          <div className="px-4 py-3 text-sm text-muted-foreground">No skills yet.</div>
        )}
        {skills?.map((s) => (
          <div key={s.skillId} className="flex items-center gap-3 px-4 py-2.5">
            <span className="flex-1 min-w-0 truncate text-sm text-foreground">
              {s.description || s.skillId}
            </span>
            <Badge variant="secondary">{SOURCE_LABEL[s.source]}</Badge>
            {s.removable ? (
              <Button variant="ghost" size="sm" onClick={() => remove(s.skillId)}>
                Remove
              </Button>
            ) : (
              <span className="w-[64px] text-right text-[11px] text-muted-foreground">
                locked
              </span>
            )}
          </div>
        ))}
      </Card>

      {/* Allowed sites — the durable "always for this agent" host grants
          (design P3/P6). Revoking removes the durable grant so it is not
          re-loaded into the next session's allowlist. Hosts are untrusted text
          → React text nodes (auto-escaped); never raw inner HTML. */}
      <h3 className="text-sm font-medium text-foreground">Allowed sites (this agent)</h3>
      <Card className="divide-y divide-border">
        {sites === null && !error && (
          <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>
        )}
        {sites?.length === 0 && (
          <div className="px-4 py-3 text-sm text-muted-foreground">No allowed sites.</div>
        )}
        {sites?.map((site) => (
          <div key={site.host} className="flex items-center gap-3 px-4 py-2.5">
            <span className="flex-1 min-w-0 truncate text-sm text-foreground">{site.host}</span>
            <span className="text-[11px] text-muted-foreground">
              always · {shortDate(site.grantedAt)}
            </span>
            <Button variant="ghost" size="sm" onClick={() => revokeSite(site.host)}>
              Revoke
            </Button>
          </div>
        ))}
      </Card>
    </div>
  );
}
