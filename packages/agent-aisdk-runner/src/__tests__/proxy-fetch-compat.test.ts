import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createAnthropic } from '@ai-sdk/anthropic';
import { ToolLoopAgent, stepCountIs } from 'ai';
import { fetch as undiciFetch } from 'undici';

// ---------------------------------------------------------------------------
// The one runtime coupling nothing else in this package proves.
//
// `createProxyFetch` returns a fetch built on **undici v6** (our direct dep, so
// the ProxyAgent and the fetch come from one copy — the 2026-06-29 incident's
// shape). That fetch is then handed to `@ai-sdk/anthropic`, which lives under
// `ai@7` and pulls its OWN undici (v7) transitively. So an undici-v6 `Response`
// has to be consumed by a stream parser from a different undici major.
//
// Everywhere else that boundary is mocked: `provider.test.ts` uses an echo
// fetch, and `parity.e2e.test.ts` mocks `resolveModel` outright. If v6's
// `Response.body` did not satisfy what the AI SDK's SSE reader expects, EVERY
// model call would fail at runtime and the entire suite would still be green —
// the failure would first appear in a cluster walk.
//
// So this test runs a real HTTP server that speaks Anthropic's SSE wire format,
// points the model at it through a real undici-v6 fetch, and drains an actual
// `ToolLoopAgent` stream. No network beyond loopback, no credentials.
// ---------------------------------------------------------------------------

const PLACEHOLDER = 'ax-cred:0123456789abcdef0123456789abcdef';

/** A minimal Anthropic `messages` SSE response: one text block, then stop. */
const SSE_EVENTS: Array<[string, unknown]> = [
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    },
  ],
  [
    'content_block_start',
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hello from the wire' },
    },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
];

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    server.close();
    await once(server, 'close').catch(() => undefined);
    server = undefined;
  }
});

async function startAnthropicStub(): Promise<{
  baseURL: string;
  seenHeaders: () => Record<string, string | string[] | undefined>;
}> {
  let headers: Record<string, string | string[] | undefined> = {};
  server = createServer((req, res) => {
    headers = req.headers;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    for (const [event, data] of SSE_EVENTS) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    seenHeaders: () => headers,
  };
}

describe('undici-v6 fetch → @ai-sdk/anthropic (cross-major Response compat)', () => {
  it('drains a real Anthropic SSE stream through a ToolLoopAgent', async () => {
    const stub = await startAnthropicStub();

    // The shape `createProxyFetch` produces: undici's own fetch, with a
    // dispatcher from the SAME undici copy. Here we point it straight at the
    // stub instead of through a CONNECT proxy — the proxy hop is covered by
    // provider.test.ts; what is under test here is the RESPONSE crossing the
    // major boundary into the AI SDK's parser.
    const v6Fetch = ((input: unknown, init?: unknown) =>
      undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        init as Parameters<typeof undiciFetch>[1],
      )) as unknown as typeof fetch;

    // The provider is built directly here rather than through `resolveModel`,
    // and that is deliberate: `resolveModel` PINS the base URL to
    // api.anthropic.com so no env var can redirect model traffic, and adding a
    // test-only override would weaken exactly the property worth having.
    // `resolveModel`'s own behaviour (placeholder validation, provider gating,
    // the pinned base URL, no gateway) is covered in provider.test.ts; what is
    // under test HERE is the response crossing the undici major boundary, and
    // that is identical either way.
    const model = createAnthropic({
      apiKey: PLACEHOLDER,
      baseURL: stub.baseURL,
      fetch: v6Fetch,
    })('claude-sonnet-4-6');

    const agent = new ToolLoopAgent({
      model,
      instructions: 'you are a test',
      stopWhen: stepCountIs(2),
      tools: {},
    });

    const result = await agent.stream({
      messages: [{ role: 'user', content: 'hi' }],
    });

    const text: string[] = [];
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') text.push(part.text);
      if (part.type === 'error') {
        throw new Error(`stream errored: ${String(part.error)}`);
      }
    }

    // If a v6 Response body could not be consumed by ai@7's SSE reader, this is
    // where it would surface — as an empty stream or a thrown parser error.
    expect(text.join('')).toBe('hello from the wire');

    // The placeholder went on the wire, not a real key: the credential-proxy
    // substitutes it mid-flight, and this process never holds the real value.
    expect(stub.seenHeaders()['x-api-key']).toBe(PLACEHOLDER);
  });
});
