import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext, PluginError } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';
import type {
  CredentialsEnvelopeEncryptInput,
  CredentialsEnvelopeEncryptOutput,
  CredentialsEnvelopeDecryptInput,
  CredentialsEnvelopeDecryptOutput,
} from '../plugin.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('credentials:envelope-encrypt / credentials:envelope-decrypt', () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.AX_CREDENTIALS_KEY;
    process.env.AX_CREDENTIALS_KEY = KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = savedKey;
  });

  async function makeBus() {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: ':memory:' }),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
      ],
      config: {},
    });
    return bus;
  }

  function ctx() {
    return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
  }

  async function encrypt(bus: HookBus, plaintext: string): Promise<Uint8Array> {
    const out = await bus.call<
      CredentialsEnvelopeEncryptInput,
      CredentialsEnvelopeEncryptOutput
    >('credentials:envelope-encrypt', ctx(), { plaintext });
    return out.ciphertext;
  }

  async function decrypt(bus: HookBus, ciphertext: Uint8Array): Promise<string> {
    const out = await bus.call<
      CredentialsEnvelopeDecryptInput,
      CredentialsEnvelopeDecryptOutput
    >('credentials:envelope-decrypt', ctx(), { ciphertext });
    return out.plaintext;
  }

  it('round-trips a string through encrypt → decrypt', async () => {
    const bus = await makeBus();
    const ct = await encrypt(bus, 'hello world');
    expect(ct).toBeInstanceOf(Uint8Array);
    const pt = await decrypt(bus, ct);
    expect(pt).toBe('hello world');
  });

  it('round-trips an empty string', async () => {
    const bus = await makeBus();
    const ct = await encrypt(bus, '');
    const pt = await decrypt(bus, ct);
    expect(pt).toBe('');
  });

  it('round-trips multi-byte UTF-8 correctly', async () => {
    const bus = await makeBus();
    const original = 'héllo 🙂';
    const ct = await encrypt(bus, original);
    const pt = await decrypt(bus, ct);
    expect(pt).toBe(original);
  });

  it('rejects tampered ciphertext with decrypt-failed', async () => {
    const bus = await makeBus();
    const ct = await encrypt(bus, 'sensitive value');
    // Flip one bit somewhere in the middle (after IV, before tag).
    const tampered = new Uint8Array(ct);
    const mid = Math.floor(tampered.length / 2);
    tampered[mid] = tampered[mid]! ^ 0x01;
    await expect(decrypt(bus, tampered)).rejects.toMatchObject({
      code: 'decrypt-failed',
    });
  });

  it('rejects truncated ciphertext with invalid-ciphertext', async () => {
    const bus = await makeBus();
    const tooShort = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(decrypt(bus, tooShort)).rejects.toMatchObject({
      code: 'invalid-ciphertext',
    });
  });

  it('encrypt rejects non-string plaintext with invalid-payload', async () => {
    const bus = await makeBus();
    await expect(
      bus.call('credentials:envelope-encrypt', ctx(), {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        plaintext: 123 as any,
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('decrypt rejects non-Uint8Array ciphertext with invalid-payload', async () => {
    const bus = await makeBus();
    await expect(
      bus.call('credentials:envelope-decrypt', ctx(), {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ciphertext: 'hello' as any,
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('two encrypts of the same plaintext produce different ciphertexts (random IV)', async () => {
    const bus = await makeBus();
    const ct1 = await encrypt(bus, 'same input');
    const ct2 = await encrypt(bus, 'same input');
    // Different bytes overall (random IV in prefix).
    expect(Buffer.from(ct1).equals(Buffer.from(ct2))).toBe(false);
    // But both decrypt to the original.
    expect(await decrypt(bus, ct1)).toBe('same input');
    expect(await decrypt(bus, ct2)).toBe('same input');
  });

  // Silence unused-import warning if PluginError isn't directly referenced;
  // it's imported for type-narrowing convenience.
  void PluginError;
});
