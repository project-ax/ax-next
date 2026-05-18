import { useMemo, useRef, useCallback, useEffect } from 'react';
import {
  type AssistantRuntime,
  useRemoteThreadListRuntime,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import { useChat } from '@ai-sdk/react';
import { axThreadListAdapter } from './thread-list-adapter';
import { createAxHistoryAdapter } from './history-adapter';
import { AxChatTransport } from './transport';
import { useAgentStore } from './agent-store';
import { sessionStoreActions, useSessionStore } from './session-store';
import { useThinkingStore } from './thinking-store';
import { AxAttachmentAdapter } from './ax-attachment-adapter';
import { setActiveConversationId } from './use-conversation-id';

const useChatThreadRuntime = (transport: AxChatTransport): AssistantRuntime => {
  const id = useAuiState(({ threadListItem }) => threadListItem.id);
  const aui = useAui();
  // Re-fetch with ?includeThinking=true when the toggle flips on, so the
  // history adapter pulls thinking blocks the next time a thread loads.
  const { visible: thinkingVisible } = useThinkingStore();

  const history = useMemo(
    () =>
      createAxHistoryAdapter(
        () => aui.threadListItem().getState().remoteId,
        { includeThinking: thinkingVisible },
      ),
    [aui, thinkingVisible],
  );

  // Phase 3: AxAttachmentAdapter mediates POST /api/attachments. Stable
  // across the hook lifetime — no per-prop state, so a single instance
  // is enough.
  const attachments = useMemo(() => new AxAttachmentAdapter(), []);

  const chat = useChat({ id, transport });
  return useAISDKRuntime(chat, {
    adapters: { history, attachments },
  });
};

/**
 * Custom hook that creates a chat runtime with AX-backed thread persistence.
 *
 * The transport's `getAgentId` resolver reads the live agent-store snapshot
 * so the next user message goes to whichever agent the chip currently shows
 * (pendingAgentId wins, falling back to selectedAgentId, then the first
 * agent in the list — same priority as AgentChip).
 *
 * `getConversationId` / `setConversationId` keep the chat-flow's
 * conversationId aligned with the transport's notion of "the current
 * conversation". For MVP this is component-local state; a future
 * router-driven URL `?c=...` lookup hooks in here without changing the
 * transport.
 */
export const useAxChatRuntime = (
  user?: string,
): AssistantRuntime => {
  const { selectedAgentId, pendingAgentId, agents } = useAgentStore();
  const agentRef = useRef({ selectedAgentId, pendingAgentId, agents });
  agentRef.current = { selectedAgentId, pendingAgentId, agents };

  // Conversation id is transport-local only — no consumer in this hook
  // reads it after the server returns it. A ref (not useState) is enough
  // and avoids forcing a re-render that would tear down the chat.
  const conversationRef = useRef<string | null>(null);

  const handleSetConversationId = useCallback((id: string) => {
    conversationRef.current = id;
    // Publish the freshly-minted id to subscribers (AttachmentChip,
    // ArtifactChip) via the module-level store so they can build
    // GET /api/files URLs without prop-drilling.
    setActiveConversationId(id);
    // The server just minted a fresh conversation row (typical first
    // message after a "+ new session" click or an agent switch).
    // Promote it to the sidebar's active session immediately so the
    // row that's about to appear in the list lights up its accent
    // bar, and bump the list version so SessionList re-fetches and
    // surfaces the new row in the next render.
    sessionStoreActions.setActiveSession(id, true);
    sessionStoreActions.bumpVersion();
  }, []);

  const transport = useMemo(
    () =>
      new AxChatTransport({
        ...(user !== undefined ? { user } : {}),
        getConversationId: () => conversationRef.current,
        setConversationId: handleSetConversationId,
        getAgentId: () => {
          const { pendingAgentId: p, selectedAgentId: s, agents: a } =
            agentRef.current;
          return p ?? s ?? a[0]?.id ?? null;
        },
      }),
    // The transport closes over refs — reconstructing on every selection
    // change would force the AI SDK's internal stream-controller to
    // recreate. Constructing once is correct because the resolvers are
    // refs, not values.
    [user, handleSetConversationId],
  );

  // Whenever the session-store's `activeSessionId` clears (the user
  // opened a fresh session via "+ new session", or AgentChip dropped
  // the previous session as part of a mid-chat agent switch), reset
  // the transport's conversationId so the next POST sends
  // `conversationId: null`. The server then mints a new conversation
  // row — without this, the transport would carry the previous id
  // forward and the new agent's first turn would land in the old
  // conversation.
  const activeSessionId = useSessionStore().activeSessionId;
  useEffect(() => {
    if (activeSessionId === null) {
      conversationRef.current = null;
      // Clear the subscriber-visible id so any AttachmentChip / ArtifactChip
      // that's still mounted falls back to its conversation-unknown state
      // rather than building a URL against the previous conversation.
      setActiveConversationId(null);
    }
  }, [activeSessionId]);

  return useRemoteThreadListRuntime({
    runtimeHook: () => useChatThreadRuntime(transport),
    adapter: axThreadListAdapter,
  });
};
