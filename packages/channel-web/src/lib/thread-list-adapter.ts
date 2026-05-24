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

// The server auto-generates a title during the first turn (jsonl read +
// title-LLM round-trip), so it isn't available the instant we ask. The old
// 3×1s window often expired before the title landed and then permanently
// cached "New Chat" until a full reload. Widen the window so the common case
// is surfaced. Early-returns on the first poll that sees a title.
const TITLE_POLL_ATTEMPTS = 10;
const TITLE_POLL_INTERVAL_MS = 1000;
// A single poll request that hangs (browser `fetch` has no default timeout)
// would otherwise stall the whole window indefinitely. Bound each attempt so
// a stuck request just costs one attempt and the loop moves on.
const TITLE_POLL_ATTEMPT_TIMEOUT_MS = 5000;

/**
 * Poll `GET /api/chat/conversations` for `remoteId`'s title until it's
 * non-null or the attempts run out. Returns the title, or `null` if it never
 * appeared in the window.
 *
 * Each attempt is bounded by `perAttemptTimeoutMs` (via `AbortController` plus
 * a race, so even a `fetch` that ignores the abort signal can't hang the
 * loop). `fetchImpl` / `intervalMs` / `perAttemptTimeoutMs` are test seams —
 * production callers use the module defaults.
 */
export async function pollConversationTitle(
  remoteId: string,
  opts: {
    attempts?: number;
    intervalMs?: number;
    perAttemptTimeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<string | null> {
  const attempts = opts.attempts ?? TITLE_POLL_ATTEMPTS;
  const intervalMs = opts.intervalMs ?? TITLE_POLL_INTERVAL_MS;
  const perAttemptTimeoutMs =
    opts.perAttemptTimeoutMs ?? TITLE_POLL_ATTEMPT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fetchP = fetchImpl('/api/chat/conversations', {
        credentials: 'include',
        signal: controller.signal,
      });
      // Mark the fetch handled so an abort-triggered late rejection (when the
      // timeout wins the race) doesn't surface as an unhandled rejection.
      fetchP.catch(() => undefined);
      const timeoutP = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve('timeout');
        }, perAttemptTimeoutMs);
      });
      const res = await Promise.race([fetchP, timeoutP]);
      if (res !== 'timeout' && res.ok) {
        const rows = (await res.json()) as ConversationRow[];
        const match = Array.isArray(rows)
          ? rows.find((c) => c.conversationId === remoteId)
          : undefined;
        if (match?.title) return match.title;
      }
    } catch {
      /* transient — retry */
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return null;
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
    // Poll the conversations list until the server-generated title lands,
    // falling back to "New Chat" so the row never hangs in a loading state.
    // (Residual: a title that arrives after the poll window still needs a
    // list() refresh to appear — tracked on the "TO DO" project board.)
    const title = (await pollConversationTitle(remoteId)) ?? 'New Chat';
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
