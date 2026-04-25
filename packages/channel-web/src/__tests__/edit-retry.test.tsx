/**
 * Edit + retry truncation (Task 19) — round-trip test.
 *
 * The assistant-ui `ActionBarPrimitive.Edit` and `ActionBarPrimitive.Reload`
 * primitives wired in `Thread.tsx` (Task 18) drop messages after the edited /
 * retried turn, then re-call the chat runtime with a *shorter* `messages[]`
 * array. The mock backend (Task 6) honors that by truncating persisted
 * history before appending the new turn.
 *
 * This test pins the wiring end-to-end without React: it spins up a real
 * `node:http` server hosting the mock backend and drives `AxChatTransport`
 * directly via `sendMessages`. The transport is the production code path the
 * runtime takes when an edit/retry fires, so confirming truncation here gives
 * us confidence the user-visible behavior round-trips correctly.
 *
 * Why no React: `useLocalRuntime`'s edit/retry behavior is internal and async,
 * and exercising it through `@testing-library/react` adds flake without
 * exercising any code we own. The transport is the seam.
 *
 * Note: `chat-sse.test.ts` covers the same truncation logic from the
 * server side using raw `fetch`. This test exercises the *client* serializer
 * (`AxChatTransport.prepareSendMessagesRequest`) on the wire — if a future
 * change to the transport shape ever stops triggering truncation, this test
 * will catch it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Store } from '../../mock/store';
import { createMockHandler } from '../../mock/server';
import { AxChatTransport } from '../lib/transport';
import type { UIMessage, UIMessageChunk } from 'ai';

interface PersistedMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

interface PersistedSession {
  id: string;
  user_id: string;
  agent_id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

/** Drain a UIMessageChunk stream so the transport finishes before we inspect state. */
async function drain(stream: ReadableStream<UIMessageChunk>): Promise<void> {
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) return;
  }
}

/**
 * Build a minimal UIMessage. Real ones from assistant-ui carry more fields,
 * but `prepareSendMessagesRequest` only reads `role` + `parts[].text`.
 */
function userMsg(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

function assistantMsg(id: string, text: string): UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] };
}

describe('edit/retry truncation (round-trip via AxChatTransport)', () => {
  let dir: string;
  let server: Server;
  let url: string;
  // Use the cookie name that the mock auth middleware reads (`mock-session`).
  const ALICE_COOKIE = 'mock-session=u2';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edit-retry-'));
    // Drive Store directly (same dir the mock handler will use) to pre-seed
    // history before requests fly. The handler shares the on-disk store.
    const store = new Store(dir);
    store.seed();
    // Pre-seed a session with 3 prior turns: user, assistant, user.
    store.collection<PersistedSession>('sessions').upsert({
      id: 'u2:thread-er',
      user_id: 'u2',
      agent_id: 'tide',
      title: 't',
      created_at: 1,
      updated_at: 1,
    });
    const messages = store.collection<PersistedMessage>('messages');
    messages.upsert({ id: 'u2:thread-er:0', session_id: 'u2:thread-er', role: 'user', content: 'first', created_at: 1 });
    messages.upsert({ id: 'u2:thread-er:1', session_id: 'u2:thread-er', role: 'assistant', content: 'reply1', created_at: 2 });
    messages.upsert({ id: 'u2:thread-er:2', session_id: 'u2:thread-er', role: 'user', content: 'second', created_at: 3 });

    const handler = createMockHandler(dir);
    server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    url = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('an edit (shorter messages array) truncates persisted history before appending the new assistant turn', async () => {
    // The transport sends to a relative URL by default; point it at the test
    // server. Pass cookie via custom fetch so the mock auth middleware sees
    // a logged-in Alice (u2).
    const transport = new AxChatTransport({
      api: `${url}/api/chat/completions`,
      user: 'u2',
    });
    // Inject the cookie via a custom fetch.
    (transport as unknown as { fetch?: typeof fetch }).fetch = (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers);
      headers.set('cookie', ALICE_COOKIE);
      return fetch(input, { ...init, headers });
    };

    // Simulate the edit: client re-sends only the *first* (now edited) user turn.
    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 'thread-er',
      messageId: undefined,
      messages: [userMsg('m0', 'first edited')],
      abortSignal: undefined,
    });
    await drain(stream);

    // Verify on disk: history truncated to length 1, then assistant appended → 2 total.
    const store = new Store(dir);
    const after = store
      .collection<PersistedMessage>('messages')
      .list()
      .filter((m) => m.session_id === 'u2:thread-er');
    expect(after).toHaveLength(2);
    expect(after[0]?.content).toBe('first edited');
    expect(after[0]?.role).toBe('user');
    expect(after[1]?.role).toBe('assistant');
  }, 20_000);

  it('a follow-up (longer array than persisted) appends without dropping history', async () => {
    // Pre-seed has 3 (u/a/u). Send 3 prior + 1 new user = 4 messages.
    // Server should: keep all 3 priors, append new user, then assistant → 5 total.
    const transport = new AxChatTransport({
      api: `${url}/api/chat/completions`,
      user: 'u2',
    });
    (transport as unknown as { fetch?: typeof fetch }).fetch = (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers);
      headers.set('cookie', ALICE_COOKIE);
      return fetch(input, { ...init, headers });
    };

    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 'thread-er',
      messageId: undefined,
      messages: [
        userMsg('m0', 'first'),
        assistantMsg('m1', 'reply1'),
        userMsg('m2', 'second'),
        userMsg('m3', 'third'),
      ],
      abortSignal: undefined,
    });
    await drain(stream);

    const store = new Store(dir);
    const after = store
      .collection<PersistedMessage>('messages')
      .list()
      .filter((m) => m.session_id === 'u2:thread-er');
    expect(after).toHaveLength(5);
    expect(after[3]?.content).toBe('third');
    expect(after[3]?.role).toBe('user');
    expect(after[4]?.role).toBe('assistant');
  }, 20_000);
});
