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

/**
 * Prefix assistant-ui's RemoteThreadList uses for the local placeholder id of
 * a fresh thread that has no server-side remoteId yet (template literal
 * `__LOCALID_${nanoid}` in @assistant-ui/core). There's no exported constant
 * for it, so we match the literal; a regression test guards the behavior so
 * we'd notice if an assistant-ui upgrade changes the prefix.
 */
const AUI_LOCAL_ID_PREFIX = '__LOCALID_';

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

/**
 * Tool result lookup keyed by `tool_use_id`. Built once across all turns so
 * an assistant turn's `tool_use` block can be paired with the tool turn that
 * carries the corresponding `tool_result`.
 */
type ToolResultMap = Map<
  string,
  { content: string; isError: boolean }
>;

const flattenToolResultContent = (
  content: unknown,
): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: 'text'; text: string } =>
        !!c && typeof c === 'object' && (c as { type?: string }).type === 'text',
      )
      .map((c) => c.text)
      .join('\n');
  }
  return '';
};

/** Convert AX content blocks to assistant-ui message parts. */
function blocksToParts(
  blocks: ContentBlock[],
  toolResults: ToolResultMap,
): Array<Record<string, unknown>> {
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
    if (block.type === 'attachment') {
      // Phase 3 (2026-05-18): translate stored `attachment` content blocks to
      // assistant-ui's `file` part shape. The `data` URL carries the
      // workspace-relative path (base64url-encoded) so AttachmentChip can
      // decode it and feed `GET /api/files`.
      const encodedPath = base64url(block.path);
      parts.push({
        type: 'file',
        data: `ax://attachment-path/${encodedPath}`,
        mediaType: block.mediaType,
        filename: block.displayName,
      });
      continue;
    }
    if (block.type === 'tool_use') {
      // Emit an AI SDK v5 dynamic-tool UIMessage part. assistant-ui's
      // react-ai-sdk bridge converts these into tool-call ThreadMessage
      // parts, which Thread.tsx renders via ToolGroup + ToolFallback.
      const matched = toolResults.get(block.id);
      const part: Record<string, unknown> = {
        type: 'dynamic-tool',
        toolName: block.name,
        toolCallId: block.id,
        input: block.input,
      };
      if (matched) {
        part.state = 'output-available';
        part.output = matched.content;
        if (matched.isError) {
          // The bridge prefers `output-error` when an explicit errorText is
          // present. Match that shape so the failed group renders red.
          part.state = 'output-error';
          part.errorText = matched.content || 'tool failed';
          delete part.output;
        }
      } else {
        // Result not in this transcript (turn streaming dropped it, or the
        // tool is still in flight). Mark as input-available so the row
        // shows up; the absence of output is rendered as a quiet "running".
        part.state = 'input-available';
      }
      parts.push(part);
      continue;
    }
    if (block.type === 'tool_result') {
      // Tool results live in tool-role turns; collectToolResults() pulls
      // them into the lookup map so the matching assistant turn's tool_use
      // can reference them. An orphan here means there's no preceding
      // tool_use — drop silently.
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
 * Public-facing wrapper used by render-side code and tests. The optional
 * second arg carries opts that downstream renderers may want (e.g.
 * conversationId for the chip's GET /api/files URL); this function itself
 * doesn't read them — the `useConversationId` hook (Task 14) provides
 * them to chips at render time.
 *
 * Internally delegates to `blocksToParts` with an empty tool-result map
 * since attachment translation never needs the cross-turn tool_use ↔
 * tool_result join.
 */
export function contentBlocksToAuiParts(
  blocks: ContentBlock[],
  _opts?: { conversationId?: string },
): Array<Record<string, unknown>> {
  return blocksToParts(blocks, new Map());
}

/**
 * Encode a workspace-relative path as base64url so it can ride safely as
 * the path segment of `ax://attachment-path/<...>` URLs (no raw slashes
 * or `+`/`=` chars).
 *
 * Goes through TextEncoder/TextDecoder rather than `btoa(input)` directly
 * because `btoa` throws on code points > 0xFF — Unicode filenames (CJK,
 * emoji) would otherwise blow up here.
 */
function base64url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Decode an `ax://attachment-path/<base64url>` URL back to the original
 * workspace-relative path. Used by `AttachmentChip` (Task 11) to build
 * its `GET /api/files` request. Returns `null` for non-ax URLs or any
 * decode failure.
 *
 * Symmetrically to `base64url`, decodes through TextDecoder so multi-byte
 * UTF-8 sequences (Unicode filenames) round-trip correctly.
 */
export function decodeAttachmentPath(url: string): string | null {
  const PREFIX = 'ax://attachment-path/';
  if (!url.startsWith(PREFIX)) return null;
  const encoded = url.slice(PREFIX.length);
  const padded = encoded
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  try {
    const binary = atob(padded + '==='.slice(0, (4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Build a tool_use_id → result lookup from every block we'll see. */
function collectToolResults(turns: Turn[]): ToolResultMap {
  const map: ToolResultMap = new Map();
  for (const turn of turns) {
    for (const block of turn.contentBlocks) {
      if (block.type === 'tool_result') {
        map.set(block.tool_use_id, {
          content: flattenToolResultContent(block.content),
          isError: block.is_error === true,
        });
      }
    }
  }
  return map;
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
      // No-op: the AX server persists turns during agent:invoke / chat:turn-end.
      // The append-on-client path would fork the source of truth (I4).
    },

    withFormat(formatAdapter) {
      return {
        async load() {
          const conversationId = getConversationId();
          // assistant-ui mints a local placeholder id (`__LOCALID_<nanoid>`)
          // for a fresh/unsaved thread before it has a server-side remoteId
          // (see @assistant-ui/core RemoteThreadListThreadListRuntimeCore).
          // Treat it like "no remote id yet" — fetching it would just 404 and
          // spam the console with a failed-resource error. The prefix is an
          // internal detail with no exported constant, so we match the literal.
          if (!conversationId || conversationId.startsWith(AUI_LOCAL_ID_PREFIX)) {
            return { messages: [] };
          }

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
          const toolResults = collectToolResults(turns);

          // Drop tool-role turns from the rendered list — their tool_result
          // content has been merged into the prior assistant turn's tool_use
          // parts via collectToolResults. Rendering a turn that's only
          // tool_result blocks would just be a blank assistant bubble.
          const renderable = turns.filter(
            (t) => t.role !== 'tool' || t.contentBlocks.some((b) => b.type !== 'tool_result'),
          );

          type StorageContent = Parameters<typeof formatAdapter.decode>[0]['content'];
          // parent_id has to chain through *renderable* messages — once
          // we drop tool-role turns, turnIndex - 1 may point to an id
          // that was never imported, and assistant-ui's MessageRepository
          // will throw "Parent message not found".
          let prevId: string | null = null;
          const items = renderable.map((t) => {
            const parts = blocksToParts(t.contentBlocks, toolResults);
            const id = `${conversationId}-${t.turnIndex}`;
            const parentId = prevId;
            prevId = id;
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
          // No-op: AX server persists turns during agent:invoke.
        },
      };
    },
  };
};
