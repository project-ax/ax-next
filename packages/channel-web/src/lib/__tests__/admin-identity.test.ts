/**
 * `putAgentIdentity` and the one refusal a person can act on (TASK-719).
 *
 * The route answers 413 `{ error: 'storage-full', message }` when the storage
 * limit turns the identity save away. This used to become
 * `Error("save agent identity: 400: <the veto's own message>")`, and AgentForm
 * printed that whole string in its destructive Alert: a status, a colon, and a
 * sentence worded for the agent that writes files.
 *
 * Drives the REAL `putAgentIdentity` against a stubbed global `fetch`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { putAgentIdentity } from '../admin';
import { HttpError } from '../http';
import { StorageFullError } from '../storage-full';
import { STORAGE_FULL_IDENTITY } from '../storage-copy';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockReset());

function reply(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
}

const put = () => putAgentIdentity('agt-1', { identity: 'I am Ada.', soul: 'Kind.', operating: '' });

describe('putAgentIdentity', () => {
  it('resolves on a 200', async () => {
    reply(200, { ok: true });
    await expect(put()).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/admin/agents/agt-1/identity');
    expect(init.method).toBe('PUT');
  });

  it("throws a StorageFullError whose message IS the server's sentence on a 413 storage-full", async () => {
    reply(413, {
      error: 'storage-full',
      message: "The agent was saved, but its identity wasn't, because storage is full.",
    });
    const err = await put().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageFullError);
    // What AgentForm prints is `err.message`. No status, no colon, no code.
    expect((err as Error).message).toBe(
      "The agent was saved, but its identity wasn't, because storage is full.",
    );
    expect((err as StorageFullError).status).toBe(413);
  });

  it('says the IDENTITY sentence when the server sent none', async () => {
    reply(413, { error: 'storage-full' });
    const err = await put().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageFullError);
    expect((err as Error).message).toBe(STORAGE_FULL_IDENTITY);
  });

  it("keeps a validator's 400 exactly as it was: status and reason", async () => {
    reply(400, { error: '.ax/SOUL.md: prompt-injection signature' });
    const err = await put().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(StorageFullError);
    expect(err).not.toBeInstanceOf(HttpError);
    expect((err as Error).message).toBe(
      'save agent identity: 400: .ax/SOUL.md: prompt-injection signature',
    );
  });

  it('keeps the detail of a 413 that is not this refusal (the body is read once for each look)', async () => {
    reply(413, { error: 'body-too-large' });
    const err = await put().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(StorageFullError);
    expect((err as Error).message).toBe('save agent identity: 413: body-too-large');
  });
});
