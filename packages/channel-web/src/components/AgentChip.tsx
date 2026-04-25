/**
 * AgentChip — the identity pill at the top of the sidebar.
 *
 * Reads agent state from `agent-store`. Click toggles the menu open;
 * the menu's row-click forwards through `agentStoreActions.pickAgent`,
 * which decides between PATCH (empty session), defer (non-empty), or
 * just-record (no session yet) per the deferred-switch contract.
 *
 * Display priority for the chip name: `pendingAgentId` > `selectedAgentId`
 * > first agent. The pending agent wins so the chip immediately reflects
 * a deferred switch even though no session exists for it yet.
 */
import { useEffect, useRef, useState } from 'react';
import { agentStoreActions, useAgentStore } from '../lib/agent-store';
import { AgentMenu } from './AgentMenu';

export function AgentChip() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const {
    agents,
    selectedAgentId,
    pendingAgentId,
    activeSessionId,
    activeSessionHasMessages,
  } = useAgentStore();

  const activeId = pendingAgentId ?? selectedAgentId;
  const active = agents.find((a) => a.id === activeId) ?? agents[0];

  // Outside-click closes the menu — same pattern as UserMenu.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const handlePick = (agentId: string): void => {
    setOpen(false);
    void agentStoreActions.pickAgent(agentId, {
      activeSessionId,
      hasMessages: activeSessionHasMessages,
    });
  };

  return (
    <div ref={wrapRef} className="agent-chip-wrap" style={{ position: 'relative' }}>
      <button
        className="agent-chip"
        aria-haspopup="true"
        aria-expanded={open ? 'true' : 'false'}
        type="button"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="agent-chip-avatar" aria-hidden="true">
          <span
            className="dot"
            style={active?.color ? { background: active.color } : undefined}
          />
        </span>
        <span className="agent-chip-name">{active?.name ?? '—'}</span>
        <svg className="agent-chip-caret" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M2.5 4 L5 6.5 L7.5 4"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && <AgentMenu agents={agents} activeId={activeId} onPick={handlePick} />}
    </div>
  );
}

/**
 * Hook that hydrates the agent list from `/api/agents` once on mount.
 * Split from the chip so a parent (Sidebar) can mount it exactly once
 * without coupling hydration to the chip's render tree.
 */
export function useHydrateAgents(): void {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/agents', { credentials: 'include' });
        if (!res.ok) return;
        const body = (await res.json()) as { agents?: unknown };
        if (cancelled) return;
        if (Array.isArray(body.agents)) {
          // Trust the mock-server shape; runtime type-coercion happens server-side.
          agentStoreActions.setAgents(body.agents as Parameters<typeof agentStoreActions.setAgents>[0]);
        }
      } catch (err) {
        console.warn('[agent-chip] hydrate failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}
