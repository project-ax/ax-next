import { useMemo, useRef, useState, useCallback } from 'react';
import {
  type AssistantRuntime,
  useRemoteThreadListRuntime,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import { useChat } from '@ai-sdk/react';
import { generateId } from 'ai';
import { axThreadListAdapter } from './thread-list-adapter';
import { createAxHistoryAdapter } from './history-adapter';
import { AxChatTransport } from './transport';
import { agentStoreActions, useAgentStore } from './agent-store';
import { useThinkingStore } from './thinking-store';

/**
 * Thread-specific runtime using AI SDK.
 * Passes the AX history adapter directly to useAISDKRuntime
 * so thread history loads when switching threads.
 */
const useChatThreadRuntime = (transport: AxChatTransport, user = 'guest'): AssistantRuntime => {
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

  const chat = useChat({ id, transport });
  return useAISDKRuntime(chat, {
    adapters: {
      history,
      attachments: {
        accept: 'image/*,.pdf,.txt,.csv,.md,.json,.xlsx',
        async add({ file }) {
          return {
            id: generateId(),
            type: file.type.startsWith('image/') ? 'image' : 'file',
            name: file.name,
            file,
            contentType: file.type,
            content: [],
            status: { type: 'requires-action' as const, reason: 'composer-send' as const },
          };
        },
        async send(attachment) {
          const EXT_MIME: Record<string, string> = {
            pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
            json: 'application/json', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
            html: 'text/html', xml: 'application/xml',
          };
          const ext = attachment.name.split('.').pop()?.toLowerCase() ?? '';
          const mimeType = attachment.contentType || attachment.file.type || EXT_MIME[ext] || 'application/octet-stream';
          const resp = await fetch(`/api/files?agent=default&user=${encodeURIComponent(user)}&filename=${encodeURIComponent(attachment.name)}`, {
            method: 'POST',
            headers: { 'Content-Type': mimeType },
            body: attachment.file,
          });
          if (!resp.ok) {
            throw new Error(`upload failed: ${resp.status} ${resp.statusText}`);
          }
          const body = (await resp.json().catch(() => ({}))) as { fileId?: string };
          const { fileId } = body;
          if (!fileId) {
            throw new Error('upload returned no fileId');
          }
          return {
            id: attachment.id,
            type: attachment.type,
            name: attachment.name,
            contentType: mimeType,
            status: { type: 'complete' as const },
            content: mimeType.startsWith('image/')
              ? [{ type: 'image' as const, image: fileId }]
              : [{ type: 'file' as const, data: fileId, mimeType, filename: attachment.name }],
          };
        },
        async remove() {},
      },
    },
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

  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;

  const handleSetConversationId = useCallback((id: string) => {
    conversationRef.current = id;
    setConversationId(id);
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

  // Clear local conversation memory when the user explicitly switches
  // agents — a different agent means a different conversation. The
  // chat-flow POST will treat conversationId === null as "create new".
  // (We don't watch this with useEffect because the agent-store change
  // already triggers a re-render; the next user message reads through
  // getAgentId and the transport's post-conversation memory is the
  // localConversationId fallback inside AxChatTransport.)
  void agentStoreActions; // referenced from store mutations elsewhere
  void conversationId;

  return useRemoteThreadListRuntime({
    runtimeHook: () => useChatThreadRuntime(transport, user ?? 'guest'),
    adapter: axThreadListAdapter,
  });
};
