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
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { AsyncState, Card, Notice, Stack, Text } from '@project-ax/ui';
import { useAgentStore } from '@/lib/agent-store';
import { routineApi } from '@/lib/routines';

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
  /** The read of this agent's defaults failed. */
  readError: string | null;
  /** Flipping the switch failed. */
  error: string | null;
}

function AgentToggleRow({
  agentId,
  agentName,
  onChanged,
  focused = false,
}: {
  onChanged?: (() => void) | undefined;
  agentId: string;
  agentName: string;
  focused?: boolean;
}) {
  const [state, setState] = useState<RowState>({
    enabled: undefined,
    saving: false,
    readError: null,
    error: null,
  });
  // Bumped by "Try again" so the read runs again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ enabled: undefined, saving: false, readError: null, error: null });
    void (async () => {
      try {
        const defaults = await routineApi.listAgentDefaults(agentId);
        const reflection = defaults.find(
          (d) => d.defaultRoutineId === SKILL_REFLECTION_ID,
        );
        if (cancelled) return;
        setState((s) => ({
          ...s,
          enabled: reflection ? reflection.enabled : null,
          readError: null,
        }));
      } catch (err) {
        if (cancelled) return;
        setState((s) => ({
          ...s,
          enabled: undefined,
          readError: err instanceof Error ? err.message : String(err),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, attempt]);

  async function onToggle(next: boolean): Promise<void> {
    const previous = state.enabled;
    // Optimistic flip so the Switch feels instant; roll back on failure.
    setState((s) => ({ ...s, enabled: next, saving: true, error: null }));
    try {
      await routineApi.setAgentDefaultEnabled({
        agentId,
        defaultRoutineId: SKILL_REFLECTION_ID,
        enabled: next,
      });
      setState((s) => ({ ...s, saving: false }));
      onChanged?.();
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
    <div className={`flex flex-col gap-1.5 py-3 ${focused ? '' : 'border-b border-rule-soft last:border-b-0'}`}>
      <div className="flex items-center gap-3">
        <label
          htmlFor={switchId}
          className="flex-1 min-w-0 text-[14px] font-medium tracking-[-0.01em] text-foreground truncate cursor-pointer"
        >
          {focused ? 'Skill self-improvement' : agentName}
        </label>
        {focused && <span className="text-xs text-muted-foreground">{state.enabled === undefined ? 'Loading…' : state.enabled ? 'On' : 'Off'}</span>}
        <Switch
          id={switchId}
          aria-label={`Skill self-improvement for ${agentName}`}
          checked={state.enabled === true}
          disabled={state.enabled === undefined || state.saving}
          onCheckedChange={(v) => void onToggle(v)}
        />
      </div>
      {focused && <>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{agentName} reviews what it has learned and writes skills from procedures it keeps repeating.</p>
        {state.enabled !== undefined && <p className="text-xs text-muted-foreground">{state.enabled ? 'Turn this off to stop new self-improvement runs.' : `Off. ${agentName}’s existing skills stay installed.`}</p>}
      </>}
      {state.readError !== null && (
        <AsyncState
          status="error"
          skeleton="lines"
          loadingLabel={`Loading ${agentName}’s setting`}
          error={{
            message: `Couldn't load this setting: ${state.readError}`,
            onRetry: () => setAttempt((n) => n + 1),
          }}
        />
      )}
      {state.error !== null && <Notice tone="danger">{`Couldn't save: ${state.error}`}</Notice>}
    </div>
  );
}

export function AgentSelfImprovementSection({
  agentId,
  agentName,
  onChanged,
  onViewSkills,
}: {
  agentId?: string | undefined;
  agentName?: string | undefined;
  onChanged?: (() => void) | undefined;
  onViewSkills?: (() => void) | undefined;
} = {}) {
  const { agents, agentsStatus } = useAgentStore();

  if (agentId) return <div className="flex flex-col gap-5">
    <AgentToggleRow key={agentId} agentId={agentId} agentName={agentName ?? 'This agent'} onChanged={onChanged} focused />
    <Separator />
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm">Skills {agentName ?? 'this agent'} writes</p>
      <p className="text-sm text-muted-foreground">Find {agentName ?? 'this agent'}’s authored skills in Skills → Installed.</p>
      {onViewSkills && <Button variant="outline" onClick={onViewSkills}>View skills</Button>}
    </div>
  </div>;

  return (
    <Card>
      <Stack gap="lg">
      <Stack gap="xs">
        <Text role="body-strong">Skill self-improvement</Text>
        <Text role="meta">{HELP_COPY}</Text>
      </Stack>
      <Stack gap="md">
        <AsyncState
          status={
            agentsStatus === 'loading'
              ? 'loading'
              : agentsStatus === 'error'
                ? 'error'
                : agents.length === 0
                  ? 'empty'
                  : 'ready'
          }
          skeleton="rows"
          loadingLabel="Loading your agents…"
          error={{ message: "Couldn't load your agents. Try reopening this panel." }}
          empty={{
            title: 'No agents yet',
            description: 'Create one to manage its self-improvement.',
          }}
        >
          <div className="flex flex-col">
            {agents.map((a) => (
              <AgentToggleRow key={a.id} agentId={a.id} agentName={a.name} onChanged={onChanged} />
            ))}
          </div>
        </AsyncState>
      </Stack>
    </Stack>
    </Card>
  );
}

/** Existing catalog overrides stay reachable, including heartbeat. */
export function AgentDefaultControls({ agentId, onChanged }: { agentId: string; onChanged?: (() => void) | undefined }) {
  const [rows, setRows] = useState<
    import('@/lib/routines').AgentDefaultState[] | null
  >(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Bumped by "Try again" so the read runs again.
  const [attempt, setAttempt] = useState(0);
  const flight = useRef(false);
  useEffect(() => {
    let active = true;
    setRows(null);
    setReadError(null);
    setError(null);
    void routineApi
      .listAgentDefaults(agentId)
      .then((defaults) => {
        if (active)
          setRows(
            defaults.filter((d) => d.defaultRoutineId !== SKILL_REFLECTION_ID),
          );
      })
      .catch(() => {
        if (active) setReadError('Default routines are unavailable.');
      });
    return () => {
      active = false;
    };
  }, [agentId, attempt]);
  return (
    <Card>
      <Stack gap="lg">
      <Stack gap="xs">
        <Text role="body-strong">Default routines</Text>
        <Text role="meta">Existing routines provided by the workspace.</Text>
      </Stack>
      <Stack gap="md">
        {readError !== null && (
          <AsyncState
            status="error"
            skeleton="rows"
            loadingLabel="Loading default routines…"
            error={{ message: readError, onRetry: () => setAttempt((n) => n + 1) }}
          />
        )}
        {error !== null && <Notice tone="danger">{error}</Notice>}
        {rows === null && readError === null && (
          <AsyncState status="loading" skeleton="rows" loadingLabel="Loading default routines…" />
        )}
        {rows?.map((row) => (
          <div
            key={row.defaultRoutineId}
            className="flex items-center justify-between gap-3 py-3"
          >
            <label
              htmlFor={`default-${row.defaultRoutineId}`}
              className="text-sm"
            >
              {row.name}
            </label>
            <Switch
              id={`default-${row.defaultRoutineId}`}
              checked={row.enabled}
              disabled={busy !== null}
              onCheckedChange={(enabled) => {
                if (flight.current) return;
                flight.current = true;
                setBusy(row.defaultRoutineId);
                setError(null);
                void routineApi
                  .setAgentDefaultEnabled({
                    agentId,
                    defaultRoutineId: row.defaultRoutineId,
                    enabled,
                  })
                  .then(() =>
                    setRows(
                      (previous) =>
                        previous?.map((d) =>
                          d.defaultRoutineId === row.defaultRoutineId
                            ? { ...d, enabled }
                            : d,
                        ) ?? null,
                    ),
                  )
                  .then(() => onChanged?.())
                  .catch(() =>
                    setError(
                      'We couldn’t change this default routine. Try again.',
                    ),
                  )
                  .finally(() => {
                    flight.current = false;
                    setBusy(null);
                  });
              }}
            />
          </div>
        ))}
      </Stack>
    </Stack>
    </Card>
  );
}
