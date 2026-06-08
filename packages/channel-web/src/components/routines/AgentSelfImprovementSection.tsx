/**
 * AgentSelfImprovementSection — the per-agent "Skill self-improvement"
 * toggle (TASK-179).
 *
 * What it does, in plain terms: each agent can review what it has learned
 * and write its own skills from procedures it keeps repeating. That's the
 * `skill-reflection` system default routine. It's ON by default; this
 * surface lets an owner turn it off for a specific agent.
 *
 * Per-agent, not global: we render one Switch per agent the signed-in user
 * owns (the agent store only ever carries the caller's agents — see
 * hydrate-agents.ts). Each row fetches that agent's `skill-reflection`
 * state from `routines:list-agent-defaults` (via the owner-scoped
 * /settings/routines/:agentId/defaults route) and flips it through
 * `routines:set-agent-default-enabled`. Absence of an override = ON.
 *
 * Server is the source of truth: every read and write is owner-scoped on
 * the server (agents:resolve), so a forced render of a row for an agent
 * the user doesn't own would just surface a 403 — the gate isn't here.
 */
import { useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { PaneStatus } from '../PaneStatus';
import { useAgentStore } from '@/lib/agent-store';
import { routines } from '@/lib/routines';

const SKILL_REFLECTION_ID = 'skill-reflection';

/** The shared helper copy for the toggle — provided by the task spec and
 *  reviewed via ux-design. Plain language, "this agent" not "you". */
const HELP_COPY =
  "When on, this agent reviews what it's learned and writes its own skills from procedures it's repeated. On by default; turn off to stop it.";

interface RowState {
  /** undefined = still loading; null = no skill-reflection default exists
   *  (e.g. global master switch removed it from the catalog). */
  enabled: boolean | null | undefined;
  saving: boolean;
  error: string | null;
}

function AgentToggleRow({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [state, setState] = useState<RowState>({
    enabled: undefined,
    saving: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const defaults = await routines.listAgentDefaults(agentId);
        const reflection = defaults.find(
          (d) => d.defaultRoutineId === SKILL_REFLECTION_ID,
        );
        if (cancelled) return;
        setState((s) => ({
          ...s,
          enabled: reflection ? reflection.enabled : null,
          error: null,
        }));
      } catch (err) {
        if (cancelled) return;
        setState((s) => ({
          ...s,
          enabled: undefined,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  async function onToggle(next: boolean): Promise<void> {
    const previous = state.enabled;
    // Optimistic flip so the Switch feels instant; roll back on failure.
    setState((s) => ({ ...s, enabled: next, saving: true, error: null }));
    try {
      await routines.setAgentDefaultEnabled({
        agentId,
        defaultRoutineId: SKILL_REFLECTION_ID,
        enabled: next,
      });
      setState((s) => ({ ...s, saving: false }));
    } catch (err) {
      setState((s) => ({
        ...s,
        enabled: previous,
        saving: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const switchId = `skill-reflection-${agentId}`;
  // No skill-reflection default in the catalog → nothing to toggle for this
  // agent; skip the row entirely rather than show a dead control.
  if (state.enabled === null) return null;

  return (
    <div className="flex flex-col gap-1.5 py-3 border-b border-rule-soft last:border-b-0">
      <div className="flex items-center gap-3">
        <label
          htmlFor={switchId}
          className="flex-1 min-w-0 text-[14px] font-medium tracking-[-0.01em] text-foreground truncate cursor-pointer"
        >
          {agentName}
        </label>
        <Switch
          id={switchId}
          aria-label={`Skill self-improvement for ${agentName}`}
          checked={state.enabled === true}
          disabled={state.enabled === undefined || state.saving}
          onCheckedChange={(v) => void onToggle(v)}
        />
      </div>
      {state.error !== null && (
        <PaneStatus variant="error">Couldn't save: {state.error}</PaneStatus>
      )}
    </div>
  );
}

export function AgentSelfImprovementSection() {
  const { agents, agentsStatus } = useAgentStore();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[15px]">Skill self-improvement</CardTitle>
        <CardDescription>{HELP_COPY}</CardDescription>
      </CardHeader>
      <CardContent>
        {agentsStatus === 'loading' ? (
          <PaneStatus variant="loading">Loading your agents…</PaneStatus>
        ) : agentsStatus === 'error' ? (
          <PaneStatus variant="error">
            Couldn't load your agents. Try reopening this panel.
          </PaneStatus>
        ) : agents.length === 0 ? (
          <PaneStatus variant="empty">
            No agents yet — create one to manage its self-improvement.
          </PaneStatus>
        ) : (
          <div className="flex flex-col">
            {agents.map((a) => (
              <AgentToggleRow key={a.id} agentId={a.id} agentName={a.name} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
