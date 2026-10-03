/**
 * The Connectors tab's "Other abilities" switches, as state (TASK-738).
 *
 * Never optimistic. A switch here changes what an agent may reach, so it
 * draws what the server says AFTER the write — while a write is in flight the
 * switch is disabled at its old position, and a failed write leaves it there
 * with a sentence saying nothing changed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HttpError } from './http';
import { workspaceApi } from './workspace-api';
import type { AgentAbilities, AgentAbility } from './workspace-types';

export type AbilitiesStatus = 'loading' | 'ok' | 'unavailable' | 'failed';

export interface AgentAbilitiesState {
  abilities: AgentAbilities | null;
  status: AbilitiesStatus;
  /** Switches with a write in flight. */
  pending: ReadonlySet<AgentAbility>;
  /** Flip one switch. Resolves `true` once the server holds the new state. */
  set: (ability: AgentAbility, enabled: boolean) => Promise<boolean>;
}

export function useAgentAbilities(agentId: string): AgentAbilitiesState {
  const [abilities, setAbilities] = useState<AgentAbilities | null>(null);
  const [status, setStatus] = useState<AbilitiesStatus>('loading');
  const [pending, setPending] = useState<ReadonlySet<AgentAbility>>(new Set());
  // Switching agents quickly must not paint one agent's switches under
  // another's name: only the newest scope's answers land.
  const scope = useRef(0);

  useEffect(() => {
    const id = ++scope.current;
    setAbilities(null);
    setStatus('loading');
    setPending(new Set());
    void (async () => {
      try {
        const out = await workspaceApi.abilities(agentId);
        if (scope.current !== id) return;
        setAbilities(out.abilities);
        setStatus('ok');
      } catch (e) {
        if (scope.current !== id) return;
        setStatus(e instanceof HttpError && e.status === 503 ? 'unavailable' : 'failed');
      }
    })();
  }, [agentId]);

  const set = useCallback(
    async (ability: AgentAbility, enabled: boolean): Promise<boolean> => {
      const id = scope.current;
      setPending((prev) => new Set(prev).add(ability));
      try {
        const out = await workspaceApi.setAbility(agentId, ability, enabled);
        if (scope.current === id) setAbilities(out.abilities);
        return true;
      } catch {
        return false;
      } finally {
        if (scope.current === id) {
          setPending((prev) => {
            const next = new Set(prev);
            next.delete(ability);
            return next;
          });
        }
      }
    },
    [agentId],
  );

  return { abilities, status, pending, set };
}
