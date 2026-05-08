/**
 * AgentChip — the identity pill in the session header.
 *
 * Reads agent state from `agent-store`. Click toggles the menu open;
 * picking a row commits the agent immediately. On a non-empty session
 * the chat surface is reset (assistant-ui new thread + cleared active
 * session) so the freshly picked agent gets a blank thread to talk
 * into — Invariant I10: agents are immutable on existing conversations,
 * so a new conversation row is the only correct outcome.
 *
 * Display priority for the chip name: `pendingAgentId` (legacy field
 * retained while migration finishes; always null in the current flow)
 * > `selectedAgentId` > first agent.
 */
import { useEffect, useRef, useState } from 'react';
import { useAui } from '@assistant-ui/react';
import { agentStoreActions, useAgentStore } from '../lib/agent-store';
import { sessionStoreActions } from '../lib/session-store';
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

    if (wasNonEmpty) {
      // Reset the chat surface so the freshly-picked agent gets a
      // blank thread to talk into.
      try {
        aui.threads().switchToNewThread();
      } catch (err) {
        console.warn('[agent-chip] switchToNewThread failed', err);
      }
      // Clear active session in both stores. The sidebar deselects
      // the previous session, and the next user message POSTs with
      // conversationId: null so the server creates a fresh
      // conversation row under the new agent (Invariant I10 — agents
      // are immutable on existing conversations, so a new row is the
      // only correct answer).
      sessionStoreActions.newLocalConversation();
    }

    // Commit the agent immediately. Earlier behaviour kept the prior
    // selectedAgentId until the next message via a `pendingAgentId`
    // indirection — we now commit on pick so the chip + the next
    // message both refer to the freshly picked agent. With
    // activeSessionId already cleared above, pickAgent's
    // hasMessages=false branch fires and just records the selection.
    void agentStoreActions.pickAgent(agentId, {
      activeSessionId: null,
      hasMessages: false,
    });
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        className={cn(
          'agent-chip group flex max-w-full items-center gap-2 min-w-0 cursor-pointer',
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
        <span className="min-w-0 flex-1 truncate text-[15px] tracking-[-0.01em] leading-none text-foreground">
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
