/**
 * AgentChip — the identity pill at the top of the sidebar.
 *
 * Reads agent state from `agent-store`. Click toggles the menu open;
 * the menu's row-click forwards through `agentStoreActions.pickAgent`,
 * which decides between defer (non-empty session) or just-record (no
 * session yet) per the deferred-switch contract.
 *
 * Display priority for the chip name: `pendingAgentId` >
 * `selectedAgentId` > first agent. The pending agent wins so the chip
 * immediately reflects a deferred switch even though no session exists
 * for it yet.
 *
 * Switching agents on a non-empty session also drives assistant-ui to
 * a fresh local thread so the chat pane goes blank (the welcome empty
 * state). Without this, the previous session's history would remain
 * visible until the user typed something.
 */
import { useEffect, useRef, useState } from 'react';
import { useAui } from '@assistant-ui/react';
import { agentStoreActions, useAgentStore } from '../lib/agent-store';
import { AgentMenu } from './AgentMenu';
import { AvatarTile } from './AvatarTile';
import { cn } from '@/lib/utils';

export function AgentChip() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const aui = useAui();
  const {
    agents,
    selectedAgentId,
    pendingAgentId,
    activeSessionId,
    activeSessionHasMessages,
  } = useAgentStore();

  const activeId = pendingAgentId ?? selectedAgentId;
  const active = agents.find((a) => a.id === activeId) ?? agents[0];

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
    const wasNonEmpty = activeSessionHasMessages;
    void agentStoreActions.pickAgent(agentId, {
      activeSessionId,
      hasMessages: activeSessionHasMessages,
    });
    if (wasNonEmpty) {
      try {
        aui.threads().switchToNewThread();
      } catch (err) {
        console.warn('[agent-chip] switchToNewThread failed', err);
      }
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        className={cn(
          'agent-chip group flex items-center gap-2 min-w-0 cursor-pointer',
          'pl-2 pr-2.5 py-[7px] rounded-lg transition-colors',
          'hover:bg-muted aria-expanded:bg-muted',
        )}
        aria-haspopup="true"
        aria-expanded={open ? 'true' : 'false'}
        type="button"
        onClick={() => setOpen((v) => !v)}
      >
        <AvatarTile size={22}>
          <span
            className="h-[5px] w-[5px] rounded-full bg-primary"
            style={active?.color ? { background: active.color } : undefined}
          />
        </AvatarTile>
        <span className="text-[15px] tracking-[-0.01em] leading-none text-foreground">
          {active?.name ?? '—'}
        </span>
        <svg
          viewBox="0 0 10 10"
          aria-hidden="true"
          className="
            ml-auto shrink-0 h-2.5 w-2.5 text-muted-foreground
            transition-transform duration-150 group-aria-expanded:rotate-180
          "
        >
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

export function useHydrateAgents(): void {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/chat/agents', {
          credentials: 'include',
        });
        if (!res.ok) return;
        const body = (await res.json()) as unknown;
        if (cancelled) return;
        if (!Array.isArray(body)) return;
        const wireAgents = body as Array<{
          agentId: string;
          displayName: string;
          visibility: 'personal' | 'team';
        }>;
        const mapped = wireAgents.map((a) => ({
          id: a.agentId,
          owner_id: '',
          owner_type: a.visibility === 'team' ? ('team' as const) : ('user' as const),
          name: a.displayName,
          tag: '',
          desc: '',
          color: agentColorFor(a.agentId),
          system_prompt: '',
          allowed_tools: [],
          mcp_config_ids: [],
          model: '',
          created_at: 0,
          updated_at: 0,
        }));
        agentStoreActions.setAgents(mapped);
      } catch (err) {
        console.warn('[agent-chip] hydrate failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}

function agentColorFor(agentId: string): string {
  const palette = ['#7aa6c9', '#b08968', '#9c89b8', '#90a955', '#d4a373', '#9b5de5'];
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] ?? '#888';
}
