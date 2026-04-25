import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Store } from '../store';
import { authMiddleware } from '../auth';
import { chatMiddleware } from '../chat';

async function startServer(store: Store): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const auth = authMiddleware(store);
  const chat = chatMiddleware(store);
  const server = createServer(async (req, res) => {
    if (await auth(req, res)) return;
    if (await chat(req, res)) return;
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE = 'mock-session=u2';

async function readSse(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

describe('mock chat completions SSE', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mock-sse-')); store = new Store(dir); store.seed(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('streams an OpenAI-shaped SSE response with status + finish + [DONE]', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/chat/completions`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'default', stream: true, user: 'u2/thread-1',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      const body = await readSse(res.body!);
      expect(body).toContain('event: status');
      expect(body).toMatch(/data: \{"choices":\[\{"delta":\{"content":"/);
      expect(body).toContain('"finish_reason":"stop"');
      expect(body).toContain('data: [DONE]');
    } finally { await close(); }
  }, 20_000);

  it('persists user + assistant turns and auto-titles the session', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/chat/completions`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'default', stream: true, user: 'u2/thread-2',
          messages: [{ role: 'user', content: 'what is your favorite color?' }],
        }),
      });
      await readSse(res.body!);
      const sessions = store.collection<{ id: string; title: string; user_id: string; agent_id: string }>('sessions').list();
      const sess = sessions.find((s) => s.id === 'u2:thread-2');
      expect(sess).toBeDefined();
      expect(sess!.title).toMatch(/what is your favorite color/i);
      const msgs = store.collection<{ id: string; session_id: string; role: 'user' | 'assistant' }>('messages').list().filter((m) => m.session_id === 'u2:thread-2');
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.role).toBe('user');
      expect(msgs[1]!.role).toBe('assistant');
    } finally { await close(); }
  }, 20_000);

  it('rejects cross-user thread (cookie u2 trying user=u1/...)', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/api/chat/completions`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'default', stream: true, user: 'u1/thread-x',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(403);
    } finally { await close(); }
  });

  it('truncates persisted history when client sends a shorter messages array', async () => {
    // Pre-seed a session with 3 prior messages
    store.collection<{ id: string; user_id: string; agent_id: string; title: string; created_at: number; updated_at: number }>('sessions').upsert({ id: 'u2:thread-3', user_id: 'u2', agent_id: 'tide', title: 't', created_at: 1, updated_at: 1 });
    const messages = store.collection<{ id: string; session_id: string; role: 'user'|'assistant'; content: string; created_at: number }>('messages');
    messages.upsert({ id: 'u2:thread-3:0', session_id: 'u2:thread-3', role: 'user', content: 'first', created_at: 1 });
    messages.upsert({ id: 'u2:thread-3:1', session_id: 'u2:thread-3', role: 'assistant', content: 'reply1', created_at: 2 });
    messages.upsert({ id: 'u2:thread-3:2', session_id: 'u2:thread-3', role: 'user', content: 'second', created_at: 3 });

    const { url, close } = await startServer(store);
    try {
      // Client sends only 1 message (a re-edit of the first user turn) — server should truncate
      const res = await fetch(`${url}/api/chat/completions`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'default', stream: true, user: 'u2/thread-3',
          messages: [{ role: 'user', content: 'first edited' }],
        }),
      });
      await readSse(res.body!);
      const after = messages.list().filter((m) => m.session_id === 'u2:thread-3');
      // After truncation: user turn (edited) + assistant turn = 2 messages
      expect(after).toHaveLength(2);
      expect(after[0]!.content).toBe('first edited');
      expect(after[0]!.role).toBe('user');
      expect(after[1]!.role).toBe('assistant');
    } finally { await close(); }
  }, 20_000);

  it('cleans up cleanly when client disconnects mid-stream', async () => {
    // Pre-seed a session so we can assert no partial assistant turn was persisted.
    store
      .collection<{
        id: string;
        user_id: string;
        agent_id: string;
        title: string;
        created_at: number;
        updated_at: number;
      }>('sessions')
      .upsert({
        id: 'u2:thread-cancel',
        user_id: 'u2',
        agent_id: 'tide',
        title: 't',
        created_at: 1,
        updated_at: 1,
      });

    const { server, url, close } = await startServer(store);
    try {
      const ac = new AbortController();
      const reqPromise = fetch(`${url}/api/chat/completions`, {
        method: 'POST',
        signal: ac.signal,
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          stream: true,
          user: 'u2/thread-cancel',
          messages: [{ role: 'user', content: 'hello world this is a long message' }],
        }),
      }).catch(() => undefined);

      // Wait long enough for at least one chunk (~12ms ticks) then abort.
      await new Promise((r) => setTimeout(r, 30));
      ac.abort();

      // The fetch promise itself either resolves or rejects on abort.
      await reqPromise;

      // Verify the server handler doesn't hang: closing the server should
      // complete in a reasonable time (server.close waits for in-flight
      // handlers to finish). If the handler leaks a Promise that never
      // resolves, this would hang past the test timeout.
      const closeStart = Date.now();
      await close();
      const closeMs = Date.now() - closeStart;
      // Generous: the loop should exit within a few 12ms ticks.
      expect(closeMs).toBeLessThan(2_000);

      // No partial assistant turn should be persisted.
      const messages = store
        .collection<{
          id: string;
          session_id: string;
          role: 'user' | 'assistant';
          content: string;
        }>('messages')
        .list()
        .filter((m) => m.session_id === 'u2:thread-cancel');
      const assistant = messages.filter((m) => m.role === 'assistant');
      expect(assistant).toHaveLength(0);
    } finally {
      // close() above already shuts down; double-close is a no-op but guard.
      try {
        server.close();
      } catch {
        /* already closed */
      }
    }
  }, 10_000);

  it('rejects invalid messages array without wiping persisted history', async () => {
    // Pre-seed a session with prior history
    store.collection<{ id: string; user_id: string; agent_id: string; title: string; created_at: number; updated_at: number }>('sessions').upsert({ id: 'u2:thread-bad', user_id: 'u2', agent_id: 'tide', title: 't', created_at: 1, updated_at: 1 });
    const messages = store.collection<{ id: string; session_id: string; role: 'user'|'assistant'; content: string; created_at: number }>('messages');
    messages.upsert({ id: 'u2:thread-bad:0', session_id: 'u2:thread-bad', role: 'user', content: 'first', created_at: 1 });
    messages.upsert({ id: 'u2:thread-bad:1', session_id: 'u2:thread-bad', role: 'assistant', content: 'reply1', created_at: 2 });

    const { url, close } = await startServer(store);
    try {
      // Send empty messages — server should reject WITHOUT mutating state
      const res = await fetch(`${url}/api/chat/completions`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'default', stream: true, user: 'u2/thread-bad',
          messages: [],
        }),
      });
      expect(res.status).toBe(400);

      // Drain body if any (may be empty for 400)
      if (res.body) {
        const reader = res.body.getReader();
        while (!(await reader.read()).done) { /* drain */ }
      }

      // Persisted history must be intact
      const after = messages.list().filter((m) => m.session_id === 'u2:thread-bad');
      expect(after).toHaveLength(2);
      expect(after[0]!.content).toBe('first');
    } finally { await close(); }
  });
});
