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
import { applyTurnError, handleTurnError } from './turn-error';

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

  // Fault A — an orchestrator-terminated turn surfaces an `error` chunk;
  // useChat raises it to `onError` and we flip the status row to error+retry.
  //
  // Faults B/D (FAULTA-5) — a `done`-less close (host bounce / network drop)
  // surfaces the CONNECTION_LOST sentinel. `handleTurnError` SILENTLY retries
  // it ONCE (regenerate → fresh reqId + sandbox), then shows the error banner
  // if the retry also fails. `silentRetriedRef` tracks the single silent
  // attempt spent per turn; `onFinish` resets it when a turn finishes cleanly
  // so the next genuine drop gets its own silent retry.
  //
  // `chatRef` lets the retry handlers reach `regenerate()` (which re-runs the
  // last user turn against a fresh sandbox) without a construction-order
  // chicken-and-egg.
  const chatRef = useRef<ReturnType<typeof useChat> | null>(null);
  const silentRetriedRef = useRef(false);
  const chat = useChat({
    id,
    transport,
    onError: (error) => {
      handleTurnError({
        error,
        isFirstFailure: !silentRetriedRef.current,
        silentRetry: () => {
          silentRetriedRef.current = true;
          // Defer the regenerate() to a fresh task. The AI SDK calls onError
          // from INSIDE the failed request's catch, BEFORE its finally clears
          // `activeResponse` (and our onFinish reset runs). Calling
          // regenerate() synchronously here re-enters makeRequest and sets a
          // NEW activeResponse, which the original request's finally then
          // nukes — losing the retry's abort handle and skipping its
          // onFinish reset. A macrotask lets the failed request fully unwind
          // first, so the retry owns a clean lifecycle.
          setTimeout(() => {
            void chatRef.current?.regenerate();
          }, 0);
        },
        showError: (e) =>
          applyTurnError(e, () => {
            // Manual retry from the banner button: reset the silent-retry
            // budget so a fresh drop on the regenerated turn can silently
            // retry again before re-surfacing the banner. The banner click is
            // already outside the request lifecycle, so no defer is needed.
            silentRetriedRef.current = false;
            void chatRef.current?.regenerate();
          }),
      });
    },
    onFinish: ({ isError, isAbort, isDisconnect }) => {
      // Only a CLEAN finish resets the silent-retry budget. onFinish also
      // fires on error/abort/disconnect (with the flags set) — resetting
      // there would defeat the single-retry cap on a persistent outage.
      if (!isError && !isAbort && !isDisconnect) {
        silentRetriedRef.current = false;
      }
    },
  });
  chatRef.current = chat;
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

  // Keep the subscriber-visible id (AttachmentChip / ArtifactChip read it
  // via useConversationId) aligned with the sidebar's active session on
  // every change — not just when it clears. Without this, switching from
  // conversation A to B leaves chips still building `GET /api/files?
  // conversationId=<A>` URLs against B, which 404s.
  //
  // We mirror `activeSessionId` into the transport's `conversationRef` on
  // EVERY change, not just the null case. The earlier "only clear on null"
  // logic assumed the only way conversationRef gets a non-null value is the
  // transport writing the server's freshly-minted id in
  // `handleSetConversationId`. That holds for a brand-new chat — but NOT
  // when the user selects an existing conversation from the sidebar:
  // `setActiveSession(id)` set `activeSessionId` while `conversationRef`
  // stayed stale (typically null right after a page refresh), so the next
  // message POSTed `conversationId: null` and the server minted a *new*
  // conversation — losing the history the user expected to continue.
  // Mirroring unconditionally fixes that and is a no-op on the fresh-chat
  // path: `handleSetConversationId` already set the ref to this exact id
  // before `setActiveSession` triggered this effect.
  const activeSessionId = useSessionStore().activeSessionId;
  useEffect(() => {
    setActiveConversationId(activeSessionId);
    conversationRef.current = activeSessionId;
  }, [activeSessionId]);

  return useRemoteThreadListRuntime({
    runtimeHook: () => useChatThreadRuntime(transport),
    adapter: axThreadListAdapter,
  });
};
