import { useMemo, useRef, useCallback } from 'react';
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
import { useAgentStore } from './agent-store';
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
          // TODO(channel-web): /api/files has no real backend yet — only the
          // mock implements it. In production (preset-k8s) attachments will
          // 404 here. Either disable the composer's attach button until a
          // host-side blob-store + /api/files route lands, or accept the
          // failure mode. Tracked alongside the channel-web wire-up PR.
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

  // Conversation id is transport-local only — no consumer in this hook
  // reads it after the server returns it. A ref (not useState) is enough
  // and avoids forcing a re-render that would tear down the chat.
  const conversationRef = useRef<string | null>(null);

  const handleSetConversationId = useCallback((id: string) => {
    conversationRef.current = id;
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

  // Agent-switch → new conversation is handled server-side: a different agentId in
  // the next POST creates a new conversation row. The transport's localConversationId
  // stays stale until the server returns a new one; we don't read it across agents
  // on the same turn so the gap is benign.

  return useRemoteThreadListRuntime({
    runtimeHook: () => useChatThreadRuntime(transport, user ?? 'guest'),
    adapter: axThreadListAdapter,
  });
};
