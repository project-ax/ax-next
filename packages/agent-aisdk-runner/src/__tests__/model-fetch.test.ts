import { expect, it, vi } from 'vitest';
import { ResponseTooLargeError } from '@ax/core/response-cap';
import { capModelFetch, MAX_MODEL_EVENT_BYTES } from '../model-fetch.js';

const encoder = new TextEncoder();

async function read(chunks: Uint8Array[]) {
  const body = new ReadableStream<Uint8Array>({
    pull(c) { const chunk = chunks.shift(); if (chunk) c.enqueue(chunk); else c.close(); },
  }, { highWaterMark: 0 });
  const fetch = capModelFetch(async () => new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }));
  return (await fetch('https://provider.example')).arrayBuffer();
}

it('pins the per-event budget to 2 MiB', () => {
  expect(MAX_MODEL_EVENT_BYTES).toBe(2 * 1024 * 1024);
});

it.each(['\n', '\r\n', '\r'])('allows a long stream of bounded events using %j, including split delimiters', async eol => {
  const chunk = encoder.encode(`data: ${'x'.repeat(1024 * 1024)}${eol}${eol}`);
  const chunks = Array.from({ length: 5 }, () => [chunk.subarray(0, chunk.length - 2), chunk.subarray(chunk.length - 2, chunk.length - 1), chunk.subarray(chunk.length - 1)]).flat();
  expect((await read(chunks)).byteLength).toBe(chunk.length * 5);
});

it.each(['\n\n', '\r\n\r\n', '\r\r'])('accepts the exact frame boundary and refuses one more byte with %j', async delimiter => {
  const text = ':' + 'x'.repeat(2 * 1024 * 1024 - delimiter.length - 1) + delimiter;
  expect((await read([encoder.encode(text)])).byteLength).toBe(2 * 1024 * 1024);
  await expect(read([encoder.encode('x' + text)])).rejects.toBeInstanceOf(ResponseTooLargeError);
});

it('counts UTF-8 bytes, not decoded character count', async () => {
  await expect(read([encoder.encode('data: ' + '\u{1f642}'.repeat(600_000))])).rejects.toBeInstanceOf(ResponseTooLargeError);
});

it('a reader cancellation reaches the provider body', async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-type': 'text/event-stream' } });
  const fetch = capModelFetch(async () => response);
  await (await fetch('https://provider.example')).body!.cancel();
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
});

it('leaves a non-streaming JSON response intact', async () => {
  const response = new Response('{}', { headers: { 'content-type': 'application/json' } });
  const fetch = capModelFetch(async () => response);
  expect(await fetch('https://provider.example')).toBe(response);
});
