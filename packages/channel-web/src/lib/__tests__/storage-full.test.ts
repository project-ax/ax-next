import { describe, it, expect } from 'vitest';
import { HttpError } from '../http';
import { STORAGE_FULL_RULES, STORAGE_FULL_SEND } from '../storage-copy';
import { MAX_SERVER_SENTENCE_CHARS, StorageFullError, readStorageFull } from '../storage-full';

function res(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status });
}

describe('readStorageFull', () => {
  it("returns a StorageFullError wearing the server's own sentence", async () => {
    const err = await readStorageFull(
      '/api/chat/messages',
      res(413, { error: 'storage-full', message: 'Your storage is full, so that file could not go.' }),
    );
    expect(err).toBeInstanceOf(StorageFullError);
    // It is an HttpError too, so every existing `instanceof HttpError` branch still holds.
    expect(err).toBeInstanceOf(HttpError);
    expect(err!.status).toBe(413);
    expect(err!.sentence).toBe('Your storage is full, so that file could not go.');
    // A generic renderer that prints `.message` prints the same kind sentence.
    expect(err!.message).toBe(err!.sentence);
  });

  it.each([
    ['no message', { error: 'storage-full' }],
    ['an empty message', { error: 'storage-full', message: '' }],
    ['a blank message', { error: 'storage-full', message: '   ' }],
    ['a message that is not text', { error: 'storage-full', message: { nope: 1 } }],
  ])('falls back to our own sentence when the server sent %s', async (_name, body) => {
    const err = await readStorageFull('/api/chat/messages', res(413, body));
    expect(err).toBeInstanceOf(StorageFullError);
    expect(err!.sentence).toBe(STORAGE_FULL_SEND);
  });

  /*
    TASK-719. The fallback used to be one sentence, about a MESSAGE that did not
    send. Rules and agent identity reuse this reader, and "we couldn't send that
    message" under a Save button that saved nothing would be a lie of its own,
    so each surface names the sentence it falls back to.
  */
  it('falls back to the sentence the SURFACE named, not the message one', async () => {
    const err = await readStorageFull(
      '/api/workspace/agents/a1/memory/rules',
      res(413, { error: 'storage-full' }),
      STORAGE_FULL_RULES,
    );
    expect(err).toBeInstanceOf(StorageFullError);
    expect(err!.sentence).toBe(STORAGE_FULL_RULES);
    expect(err!.sentence).not.toBe(STORAGE_FULL_SEND);
  });

  it("still prefers the server's sentence over a named fallback", async () => {
    const err = await readStorageFull(
      '/p',
      res(413, { error: 'storage-full', message: 'The server said this.' }),
      STORAGE_FULL_RULES,
    );
    expect(err!.sentence).toBe('The server said this.');
  });

  it('clamps a very long server sentence rather than filling the screen with it', async () => {
    const err = await readStorageFull(
      '/api/chat/messages',
      res(413, { error: 'storage-full', message: 'x'.repeat(5000) }),
    );
    expect(err!.sentence.length).toBeLessThanOrEqual(MAX_SERVER_SENTENCE_CHARS);
  });

  it('leaves every other refusal alone, including the other 413', async () => {
    expect(
      await readStorageFull('/p', res(413, { error: 'attachment-total-too-large' })),
    ).toBeNull();
    expect(await readStorageFull('/p', res(400, { error: 'storage-full' }))).toBeNull();
    expect(await readStorageFull('/p', res(500, { error: 'storage-full' }))).toBeNull();
  });

  it('is not fooled by a body that is not JSON', async () => {
    expect(await readStorageFull('/p', res(413, '<html>too large</html>'))).toBeNull();
    expect(await readStorageFull('/p', res(413, 'null'))).toBeNull();
    expect(await readStorageFull('/p', res(413, '[]'))).toBeNull();
  });
});
