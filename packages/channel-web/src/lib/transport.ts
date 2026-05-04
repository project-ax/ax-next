/**
 * AxChatTransport — speaks the AX-native chat-flow producer / SSE wire.
 *
 * Two-phase exchange replacing the OpenAI-SSE stub used during early
 * prototyping (Tasks 9-13 froze the wire shapes in src/wire/chat.ts):
 *
 *   1. POST /api/chat/messages with `{ conversationId | null, agentId,
 *      contentBlocks }`. The handler validates + ACL-gates, mints a
 *      server-side `reqId` (J9 — never client-supplied), and replies
 *      202 with `{ conversationId, reqId }`.
 *
 *   2. Open `EventSource('/api/chat/stream/' + reqId)` (we use a
 *      fetch-based SSE reader so we keep the same protected
 *      `processResponseStream` hook the AI SDK gives us). Each
 *      `data:` line is a JSON-encoded `SseFrame`:
 *
 *        - `{ reqId, text, kind: 'text' | 'thinking' }` — content delta.
 *          We stream `kind === 'text'` chunks as `text-delta` UIMessage-
 *          Chunks under id `text-N`. `kind === 'thinking'` chunks are
 *          emitted under a separate id `thinking-N` so the per-message
 *          toggle (Task 21) can hide them.
 *
 *        - `{ reqId, done: true }` — terminator. We close the open part(s)
 *          and emit a `finish` UIMessageChunk (`finishReason: 'stop'`).
 *
 * Wire-shape source of truth: `src/server/types.ts` (`SseFrame`) +
 * `src/wire/chat.ts` (`PostMessageRequest` / `PostMessageResponse`).
 *
 * Boundary review (I1-I5):
 *   - I1: field names — conversationId / agentId / reqId / contentBlocks /
 *     text / kind / done — are LLM-API vocab, not transport/storage vocab.
 *   - I2: this file imports only from `ai` (the AI SDK transport base) and
 *     `@ax/ipc-protocol` (ContentBlock type). No cross-plugin reach.
 *   - I3: full chain (POST → SSE → UIMessageChunks → render) lands in
 *     this PR.
 *   - I4: conversationId returned by POST is captured in `conversationRef`
 *     so the next user turn re-uses it (the conversation row is the source
 *     of truth — Task 10's GET /api/chat/conversations/:id reads from it).
 *   - I5: `text` in incoming SSE frames is UNTRUSTED model output; it
 *     flows through the AI SDK text-delta pipeline and is rendered by
 *     <MarkdownText /> via react-markdown's safe defaults (no rehypeRaw,
 *     no raw-HTML escape hatches enabled).
 */

import type { ContentBlock } from '@ax/ipc-protocol';
import { HttpChatTransport, type UIMessage, type UIMessageChunk } from 'ai';

const DEFAULT_USER = 'guest';

/** Shape of one SSE `data:` JSON payload. Matches `SseFrame` in src/server/types.ts. */
type SseFrame =
  | { reqId: string; text: string; kind: 'text' | 'thinking' }
  | { reqId: string; done: true };

interface AxChatTransportOptions {
  /**
   * Endpoint to POST user messages to. Defaults to `/api/chat/messages`
   * which the host plugin registers; tests can pin to a different mount.
   */
  api?: string;
  /**
   * Endpoint prefix for the SSE subscription. Suffixed with the minted
   * reqId. Defaults to `/api/chat/stream`; the chat-flow plugin mounts
   * `/api/chat/stream/:reqId` (with the trailing slash).
   */
  streamApi?: string;
  /**
   * Logical user id — purely for the legacy `user` body field, kept here
   * so the runtime hook contract doesn't break. The new wire doesn't
   * carry it (auth lives in the cookie); we accept + ignore it.
   */
  user?: string;
  /**
   * Optional resolver for the active conversationId. The transport will
   * read this BEFORE every send and write the server-returned id back via
   * `setConversationId`. If not provided, transport-internal state is the
   * source.
   */
  getConversationId?: () => string | null;
  setConversationId?: (id: string) => void;
  /**
   * Resolver for which agent the user is messaging. The wire requires it
   * (PostMessageRequest.agentId is non-empty). The runtime hook reads the
   * agent-store and provides this.
   */
  getAgentId?: () => string | null;
  /**
   * Custom fetch — primarily for tests so they can mock the POST without
   * a global override.
   */
  fetch?: typeof fetch;
}

/** Convert one AI-SDK UIMessage's parts list to an AX ContentBlock array. */
function toContentBlocks(msg: UIMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (!msg.parts) return blocks;
  let collectedText = '';
  for (const p of msg.parts) {
    if (p.type === 'text') {
      collectedText += p.text;
    }
  }
  if (collectedText.length > 0) {
    blocks.push({ type: 'text', text: collectedText });
  }
  // Image / file parts: serialize as a text fallback for MVP. The AX
  // ContentBlock has rich image/tool variants but the AI SDK FileUIPart
  // shape isn't 1:1 with them; Tasks 17-21 are scoped to text + thinking.
  for (const p of msg.parts) {
    if (p.type === 'file') {
      const fp = p as { url?: string; mediaType?: string; filename?: string };
      const ref = fp.url ?? '';
      const filename = fp.filename ?? '';
      blocks.push({
        type: 'text',
        text: `[attachment: ${filename || ref}]`,
      });
    }
  }
  return blocks;
}

/**
 * Body shape we POST. The server's `PostMessageRequest` zod schema is
 * the authority — we duck-type against it here to avoid importing the
 * server module from the React bundle (Invariant I2).
 */
interface PostBody {
  conversationId: string | null;
  agentId: string;
  contentBlocks: ContentBlock[];
}

interface PostResponse {
  conversationId: string;
  reqId: string;
}

export class AxChatTransport extends HttpChatTransport<UIMessage> {
  private readonly streamApi: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getConversationIdFn: (() => string | null) | undefined;
  private readonly setConversationIdFn: ((id: string) => void) | undefined;
  private readonly getAgentIdFn: (() => string | null) | undefined;

  /**
   * Local fallback for the conversation id when the caller hasn't wired
   * a `getConversationId` resolver. Persists across `sendMessages` calls
   * so a follow-up turn re-uses the conversation the server minted on
   * the first turn.
   */
  private localConversationId: string | null = null;

  constructor(opts: AxChatTransportOptions = {}) {
    super({
      api: opts.api ?? '/api/chat/messages',
      // We override sendMessages below, so prepareSendMessagesRequest is
      // unused on the happy path. Provide a no-op body so HttpChatTransport
      // can still construct itself if a subclass call slips through.
      prepareSendMessagesRequest: async () => ({ body: {} }),
    });
    this.streamApi = opts.streamApi ?? '/api/chat/stream';
    // Bind to globalThis so the stored reference doesn't lose its Window
    // receiver. Calling `this.fetchImpl(...)` with `this === transport`
    // would otherwise throw `TypeError: Illegal invocation` in the browser.
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.getConversationIdFn = opts.getConversationId;
    this.setConversationIdFn = opts.setConversationId;
    this.getAgentIdFn = opts.getAgentId;
    // user opt is accepted for backward-compat with runtime.tsx callers
    // but unused on the AX wire (auth lives in cookies, not the body).
    void opts.user;
    void DEFAULT_USER;
  }

  /**
   * Override the AI SDK's `sendMessages` to drive the two-phase flow:
   *  1. POST /api/chat/messages with the latest user turn → mint reqId.
   *  2. fetch the SSE stream at /api/chat/stream/:reqId and feed it
   *     through `processResponseStream`.
   */
  override async sendMessages(
    options: Parameters<HttpChatTransport<UIMessage>['sendMessages']>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const { messages, abortSignal } = options;

    // Pull the latest user message — that's the one we POST. Earlier
    // turns are already persisted in the conversation row (Task 9 appends
    // user turns BEFORE agent:invoke; Task 15's runner replays history at
    // boot). We don't re-send them.
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user') {
      // Defensive — without a fresh user message there's nothing to send.
      // Return an empty stream that emits a finish so the runtime doesn't
      // hang waiting for a response.
      return makeEmptyFinishStream();
    }

    const conversationId =
      this.getConversationIdFn?.() ?? this.localConversationId;
    const agentId = this.getAgentIdFn?.() ?? '';
    if (!agentId) {
      throw new Error('AxChatTransport: agentId is required');
    }
    const contentBlocks = toContentBlocks(last);
    if (contentBlocks.length === 0) {
      // No text to send — likely an upload-only message that we don't yet
      // serialize through the wire. Surface as a no-op finish.
      return makeEmptyFinishStream();
    }

    const postBody: PostBody = { conversationId, agentId, contentBlocks };

    // Phase 1: POST. The body cap (1 MiB) is enforced by http-server; if
    // the user pasted something gigantic it'll come back as 413. We let
    // the AI SDK surface the error to the chat hook's onError callback.
    const postInit: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // CSRF: the host's CSRF subscriber accepts the literal value
        // `ax-admin` for X-Requested-With OR a same-Origin request. The
        // exact value is the contract (see @ax/http-server csrf.ts);
        // browsers can't set custom headers on cross-origin simple
        // requests without a CORS preflight, so any non-attacker caller
        // can supply it.
        'x-requested-with': 'ax-admin',
      },
      body: JSON.stringify(postBody),
      credentials: 'include',
    };
    if (abortSignal) postInit.signal = abortSignal;
    const postResp = await this.fetchImpl(this.api, postInit);
    if (!postResp.ok) {
      throw new Error(
        `chat-flow POST failed: ${postResp.status} ${postResp.statusText}`,
      );
    }
    const postOut = (await postResp.json()) as PostResponse;
    if (!postOut.reqId || !postOut.conversationId) {
      throw new Error('chat-flow POST returned malformed response');
    }
    // Capture the conversationId so subsequent turns re-use it (and the
    // history adapter can hydrate from it on next mount).
    this.localConversationId = postOut.conversationId;
    this.setConversationIdFn?.(postOut.conversationId);

    // Phase 2: SSE. We use fetch (not EventSource) so we can pass through
    // credentials, AbortSignal, and the AI SDK's existing
    // `processResponseStream` plumbing.
    const sseInit: RequestInit = {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
      credentials: 'include',
    };
    if (abortSignal) sseInit.signal = abortSignal;
    const sseResp = await this.fetchImpl(
      `${this.streamApi}/${encodeURIComponent(postOut.reqId)}`,
      sseInit,
    );
    if (!sseResp.ok || !sseResp.body) {
      throw new Error(
        `chat-flow SSE open failed: ${sseResp.status} ${sseResp.statusText}`,
      );
    }
    return this.processResponseStream(sseResp.body);
  }

  /**
   * Parse the AX SSE stream. Each `data:` line is a JSON `SseFrame`.
   * Lines split across decoder chunks are stitched via a `carry` buffer.
   *
   * Emission policy:
   *   - text-kind chunk → text-delta under id `text-N` (a new id is
   *     started after each thinking interlude so the renderer can split).
   *   - thinking-kind chunk → text-delta under id `thinking-N`. Whether
   *     the renderer SHOWS thinking parts is a UI decision (Task 21's
   *     toggle); the transport always emits, the UI hides by default.
   *   - done frame → close any open part, emit `finish`.
   *   - stream close (no done frame) → same finish posture.
   */
  protected processResponseStream(
    stream: ReadableStream<Uint8Array>,
  ): ReadableStream<UIMessageChunk> {
    let textCounter = 0;
    let thinkingCounter = 0;
    let openText: string | null = null; // active text-N id
    let openThinking: string | null = null; // active thinking-N id
    let finished = false;
    let carry = '';

    const closeOpen = (controller: TransformStreamDefaultController<UIMessageChunk>): void => {
      if (openText !== null) {
        controller.enqueue({ type: 'text-end', id: openText });
        openText = null;
      }
      if (openThinking !== null) {
        controller.enqueue({ type: 'text-end', id: openThinking });
        openThinking = null;
      }
    };

    const ensureOpenForKind = (
      kind: 'text' | 'thinking',
      controller: TransformStreamDefaultController<UIMessageChunk>,
    ): string => {
      if (kind === 'text') {
        // Switching from thinking → text closes the thinking part.
        if (openThinking !== null) {
          controller.enqueue({ type: 'text-end', id: openThinking });
          openThinking = null;
        }
        if (openText === null) {
          openText = `text-${textCounter}`;
          textCounter++;
          controller.enqueue({ type: 'text-start', id: openText });
        }
        return openText;
      }
      // thinking
      if (openText !== null) {
        controller.enqueue({ type: 'text-end', id: openText });
        openText = null;
      }
      if (openThinking === null) {
        openThinking = `thinking-${thinkingCounter}`;
        thinkingCounter++;
        controller.enqueue({
          type: 'text-start',
          id: openThinking,
          providerMetadata: { ax: { thinking: true } },
        });
      }
      return openThinking;
    };

    return stream
      .pipeThrough(new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>)
      .pipeThrough(
        new TransformStream<string, UIMessageChunk>({
          transform(rawChunk, controller) {
            if (finished) return;
            const data = carry + rawChunk;
            const lines = data.split('\n');
            // Last element may be incomplete — carry it to the next chunk.
            carry = lines.pop() ?? '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) continue;
              if (!trimmed.startsWith('data: ')) continue;

              let frame: SseFrame;
              try {
                frame = JSON.parse(trimmed.slice(6)) as SseFrame;
              } catch {
                // Malformed JSON — skip. Server is the source of truth;
                // a bad frame is a bug there, not here.
                continue;
              }

              if ('done' in frame && frame.done === true) {
                closeOpen(controller);
                controller.enqueue({ type: 'finish', finishReason: 'stop' });
                finished = true;
                return;
              }
              // text/thinking chunk
              if ('text' in frame && typeof frame.text === 'string') {
                const id = ensureOpenForKind(frame.kind, controller);
                controller.enqueue({
                  type: 'text-delta',
                  id,
                  delta: frame.text,
                  ...(frame.kind === 'thinking'
                    ? { providerMetadata: { ax: { thinking: true } } }
                    : {}),
                });
              }
            }
          },
          flush(controller) {
            if (finished) return;
            // Stream closed without an explicit done frame — close any
            // open parts and synthesize a finish so the runtime returns
            // to ready state instead of hanging.
            closeOpen(controller);
            controller.enqueue({ type: 'finish', finishReason: 'stop' });
            finished = true;
          },
        }),
      );
  }
}

/**
 * Build a no-op stream that emits `finish` and closes immediately.
 * Used when sendMessages is called without a usable user-message
 * payload (e.g., empty composer flush). Returning a real ReadableStream
 * keeps the AI SDK's chat hook on the happy path.
 */
function makeEmptyFinishStream(): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: 'finish', finishReason: 'stop' });
      controller.close();
    },
  });
}
