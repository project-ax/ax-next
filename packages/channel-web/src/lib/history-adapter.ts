/**
 * AX-backed ThreadHistoryAdapter (Task 20).
 *
 * Hydrates conversation turns from
 * `GET /api/chat/conversations/:id[?includeThinking=true]` (Task 11). The
 * `?includeThinking` query param lets the per-message UI toggle (Task 21)
 * pull thinking blocks on demand without a wholesale re-design.
 *
 * Wire shape source: `src/wire/chat.ts` `GetConversationResponse` —
 *   { conversation: {...}, turns: [{ role, contentBlocks, ... }] }
 *
 * The adapter maps each turn's `contentBlocks` (Anthropic-compatible
 * @ax/ipc-protocol shape) to assistant-ui's UIMessage `parts` array. Only
 * `text` blocks have a 1:1 mapping in MVP; `image` / `file` blocks
 * surface as plain text with the upstream id (Tasks 17-21 are scoped to
 * text + thinking; richer rendering lands in a follow-up).
 *
 * `withFormat` is the path `useExternalHistory` calls. The bare `load()`
 * exists only because the interface requires it.
 */
import type { ThreadHistoryAdapter } from '@assistant-ui/react';
import type { ContentBlock } from '@ax/ipc-protocol';

interface Turn {
  turnId: string;
  turnIndex: number;
  role: 'user' | 'assistant' | 'tool';
  contentBlocks: ContentBlock[];
  createdAt: string;
}

interface GetConversationResponse {
  conversation: { conversationId: string; title: string | null };
  turns: Turn[];
}

/** Convert AX content blocks to assistant-ui message parts. */
function blocksToParts(blocks: ContentBlock[]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'thinking') {
      // Thinking blocks come through only when ?includeThinking=true.
      // Tag with providerMetadata so the renderer can hide / collapse.
      parts.push({
        type: 'text',
        text: block.thinking ?? '',
        providerMetadata: { ax: { thinking: true } },
      });
      continue;
    }
    if (block.type === 'redacted_thinking') {
      // No human-readable content — surface as a placeholder when present.
      parts.push({
        type: 'text',
        text: '[redacted thinking]',
        providerMetadata: { ax: { thinking: true, redacted: true } },
      });
      continue;
    }
    if (block.type === 'image') {
      // Anthropic image source: data URL or external reference.
      const src = block.source;
      if (src?.type === 'base64') {
        parts.push({
          type: 'image',
          image: `data:${src.media_type};base64,${src.data}`,
        });
      } else if (src?.type === 'url') {
        parts.push({ type: 'image', image: src.url });
      } else {
        parts.push({ type: 'text', text: '[malformed image]' });
      }
      continue;
    }
    if (block.type === 'tool_use') {
      // Surface as text fallback in MVP. Rich tool-call rendering lands later.
      parts.push({
        type: 'text',
        text: `[tool: ${block.name}]`,
      });
      continue;
    }
    if (block.type === 'tool_result') {
      parts.push({ type: 'text', text: '[tool result]' });
      continue;
    }
    // Anything else falls through as a text placeholder so the message
    // renders rather than disappearing silently.
    parts.push({
      type: 'text',
      text: `[block: ${(block as { type: string }).type}]`,
    });
  }
  if (parts.length === 0) {
    parts.push({ type: 'text', text: '' });
  }
  return parts;
}

/**
 * Build an AX-backed history adapter.
 *
 * @param getConversationId — resolves to the conversationId for the
 *   currently-active thread. Returns `undefined` when no conversation
 *   has been minted yet (fresh thread); the adapter returns an empty
 *   list in that case so the runtime starts on the welcome screen.
 * @param options.includeThinking — when true, the adapter fetches with
 *   `?includeThinking=true`. Default false (J4). Tasks 21's per-message
 *   toggle re-creates the adapter with this flipped to refetch.
 */
export const createAxHistoryAdapter = (
  getConversationId: () => string | undefined,
  options: { includeThinking?: boolean } = {},
): ThreadHistoryAdapter => {
  const includeThinking = options.includeThinking === true;
  return {
    async load() {
      // Direct load (ThreadMessage format) — required by the interface
      // but useExternalHistory calls `withFormat` instead.
      return { messages: [] };
    },

    async append() {
      // No-op: the AX server persists turns during chat:run / chat:turn-end.
      // The append-on-client path would fork the source of truth (I4).
    },

    withFormat(formatAdapter) {
      return {
        async load() {
          const conversationId = getConversationId();
          if (!conversationId) return { messages: [] };

          const qs = includeThinking ? '?includeThinking=true' : '';
          const response = await fetch(
            `/api/chat/conversations/${encodeURIComponent(conversationId)}${qs}`,
            { credentials: 'include' },
          );
          if (!response.ok) {
            if (response.status === 404) return { messages: [] };
            throw new Error('Failed to fetch history');
          }

          const body = (await response.json()) as GetConversationResponse;
          const turns = Array.isArray(body.turns) ? body.turns : [];

          type StorageContent = Parameters<typeof formatAdapter.decode>[0]['content'];
          const items = turns.map((t) => {
            const parts = blocksToParts(t.contentBlocks);
            const id = `${conversationId}-${t.turnIndex}`;
            const parentId = t.turnIndex > 0
              ? `${conversationId}-${t.turnIndex - 1}`
              : null;
            return formatAdapter.decode({
              id,
              parent_id: parentId,
              format: formatAdapter.format,
              content: {
                role: t.role === 'tool' ? 'assistant' : t.role,
                parts,
                createdAt: new Date(t.createdAt),
              } as unknown as StorageContent,
            });
          });

          return { messages: items };
        },

        async append() {
          // No-op: AX server persists turns during chat:run.
        },
      };
    },
  };
};
