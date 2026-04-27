import { createAssistantStream } from 'assistant-stream';
import type { RemoteThreadListAdapter } from '@assistant-ui/react';

/**
 * Server shape for /api/chat/conversations list rows. Mirrors
 * `src/wire/chat.ts` `ListConversationsResponse`. Re-declared here as
 * a plain interface to avoid pulling zod into the React bundle.
 */
interface ConversationRow {
  conversationId: string;
  userId: string;
  agentId: string;
  title: string | null;
  activeSessionId: string | null;
  activeReqId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * AX-backed RemoteThreadListAdapter (Task 19).
 *
 * Fetches conversations from `GET /api/chat/conversations` (Task 10).
 * Each conversation maps 1:1 to an assistant-ui thread; we use the
 * conversationId as the `remoteId` so subsequent reads through the
 * history adapter can address the same row.
 */
export const axThreadListAdapter: RemoteThreadListAdapter = {
  async list() {
    const response = await fetch('/api/chat/conversations', {
      credentials: 'include',
    });
    if (!response.ok) {
      console.error('[axThreadListAdapter] list failed:', response.status);
      return { threads: [] };
    }

    const rows = (await response.json()) as ConversationRow[];
    if (!Array.isArray(rows)) return { threads: [] };

    return {
      threads: rows.map((c) => ({
        status: 'regular' as const,
        remoteId: c.conversationId,
        title: c.title ?? undefined,
        externalId: undefined,
      })),
    };
  },

  async fetch(threadId: string) {
    return {
      status: 'regular' as const,
      remoteId: threadId,
      title: undefined,
      externalId: undefined,
    };
  },

  async initialize(threadId: string) {
    // Don't pre-create the conversation — the chat-flow POST handler
    // (Task 9) creates it on the first user message via
    // conversations:create. The remoteId stays a synthetic local id
    // until the server returns the real conversationId on first send.
    return { remoteId: threadId, externalId: undefined };
  },

  async generateTitle(remoteId: string) {
    // The server auto-generates the title during the first turn; we
    // poll the conversations list briefly to surface it. After 3 tries
    // we fall back to "New Chat" so the row never hangs in a loading
    // state.
    let title = 'New Chat';
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await fetch('/api/chat/conversations', {
          credentials: 'include',
        });
        if (res.ok) {
          const rows = (await res.json()) as ConversationRow[];
          const match = Array.isArray(rows)
            ? rows.find((c) => c.conversationId === remoteId)
            : undefined;
          if (match?.title) {
            title = match.title;
            break;
          }
        }
      } catch {
        /* retry */
      }
    }
    return createAssistantStream((controller) => {
      controller.appendText(title);
      controller.close();
    });
  },

  // Stubs for future rename/archive — DELETE is wired through the
  // SessionRow component (clicking the trash icon issues DELETE
  // /api/chat/conversations/:id directly) so we keep this a no-op
  // until the runtime starts driving deletes through the adapter.
  async rename() {},
  async archive() {},
  async unarchive() {},
  async delete() {},
};
