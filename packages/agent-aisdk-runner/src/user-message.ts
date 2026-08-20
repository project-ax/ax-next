// ---------------------------------------------------------------------------
// User-message translation: Anthropic content blocks -> AI SDK content parts.
//
// The shell's attachment pass (`translateContentBlocks` in
// @ax/agent-runner-core) emits ANTHROPIC-shaped blocks — `{type:'image',
// source:{type:'base64', media_type, data}}` and the `document` equivalent —
// because it was written for the runner that speaks Anthropic natively. The AI
// SDK's user content parts are shaped differently (`{type:'image', image,
// mediaType}` / `{type:'file', data, mediaType}`), so this runner adapts at its
// own edge.
//
// Why adapt here rather than make the shell emit a neutral shape: the shell's
// blocks are consumed today by exactly one other caller (the claude-sdk loop,
// which hands them straight to the Anthropic SDK), and re-shaping core would
// mean touching that working path for no behaviour gain. If a third runner
// arrives, that is the moment to hoist a neutral intermediate into core — and
// this module is where the mapping is already written down.
//
// Everything here handles UNTRUSTED input: `data` is attachment bytes and
// `text` is user- or host-authored. Nothing is interpolated into a shell, a
// path, or a URL — it is assembled into a message object and handed to the
// provider.
// ---------------------------------------------------------------------------

import type { ModelMessage, UserContent } from 'ai';

/** The Anthropic-shaped block union `translateContentBlocks` produces. */
interface AnthropicishBlock {
  type?: unknown;
  text?: unknown;
  source?: { type?: unknown; media_type?: unknown; data?: unknown } | undefined;
}

function base64Source(
  block: AnthropicishBlock,
): { data: string; mediaType: string } | undefined {
  const src = block.source;
  if (src === undefined || src === null || typeof src !== 'object') return undefined;
  if (typeof src.data !== 'string' || typeof src.media_type !== 'string') {
    return undefined;
  }
  return { data: src.data, mediaType: src.media_type };
}

/**
 * Translate one turn's user content into an AI SDK `ModelMessage`.
 *
 * `content` is whatever `LoopContext.nextMessage()` handed back: a plain string
 * for a typed-only turn, or an array of Anthropic-shaped blocks when the turn
 * carried attachments.
 *
 * A block we cannot map degrades to a text note rather than being dropped. The
 * shell's own translation already degrades an unreadable attachment to a text
 * mention for the same reason: the model seeing "there was a file and I could
 * not read it" is recoverable; the model silently never learning the file
 * existed is not.
 */
export function toUserModelMessage(content: unknown): ModelMessage {
  if (typeof content === 'string') {
    return { role: 'user', content };
  }
  if (!Array.isArray(content)) {
    // Defensive: the shell types this `unknown`. Stringify rather than throw —
    // a malformed inbox payload should not kill the turn.
    return { role: 'user', content: String(content) };
  }

  const parts: UserContent = [];
  for (const raw of content as AnthropicishBlock[]) {
    if (raw === null || typeof raw !== 'object') continue;

    if (raw.type === 'text' && typeof raw.text === 'string') {
      parts.push({ type: 'text', text: raw.text });
      continue;
    }

    if (raw.type === 'image') {
      const src = base64Source(raw);
      if (src !== undefined) {
        // The AI SDK accepts a bare base64 string for `image`; the provider
        // re-encodes it into whatever its own wire format needs.
        parts.push({ type: 'image', image: src.data, mediaType: src.mediaType });
        continue;
      }
      parts.push({ type: 'text', text: '[attachment: an image could not be read]' });
      continue;
    }

    if (raw.type === 'document') {
      const src = base64Source(raw);
      if (src !== undefined) {
        parts.push({ type: 'file', data: src.data, mediaType: src.mediaType });
        continue;
      }
      parts.push({ type: 'text', text: '[attachment: a document could not be read]' });
      continue;
    }

    // Unknown block kind. Keep the provenance, drop the payload.
    parts.push({
      type: 'text',
      text: `[attachment: unsupported content block '${String(raw.type)}']`,
    });
  }

  // A turn that translated to nothing at all still has to be a legal message —
  // an empty content array is rejected by some providers.
  if (parts.length === 0) {
    return { role: 'user', content: '' };
  }
  return { role: 'user', content: parts };
}
