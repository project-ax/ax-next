/**
 * Test helper — write a credential row straight to the store-blob seam,
 * bypassing `credentials:set`.
 *
 * Slice 5 made `credentials:set` refuse `account:` refs at user scope, so a
 * person-level connector credential can no longer be written through the
 * facade. Rows like that still exist in deployed vaults until the one-time
 * boot purge removes them, and tests need to plant them to prove the lookup
 * ignores them and the purge removes them. The blob is built exactly the way
 * the facade's `wrapEnvelope` builds it, with the same `AX_CREDENTIALS_KEY`.
 */
import { makeAgentContext, type HookBus } from '@ax/core';
import { encryptWithKey, parseKeyFromEnv } from '../crypto.js';

export function legacyRowBlob(value: string, kind = 'api-key'): Uint8Array {
  const raw = process.env.AX_CREDENTIALS_KEY;
  if (raw === undefined || raw === '') throw new Error('AX_CREDENTIALS_KEY must be set');
  return encryptWithKey(
    parseKeyFromEnv(raw),
    JSON.stringify({
      kind,
      payloadB64: Buffer.from(value, 'utf8').toString('base64'),
      createdAt: Date.now(),
    }),
  );
}

export async function putLegacyRow(
  bus: HookBus,
  scope: 'user' | 'agent' | 'global',
  ownerId: string | null,
  ref: string,
  value: string,
  kind = 'api-key',
): Promise<void> {
  const ctx = makeAgentContext({ sessionId: 'seed', agentId: 'seed', userId: 'admin' });
  await bus.call('credentials:store-blob:put', ctx, {
    scope,
    ownerId,
    ref,
    blob: legacyRowBlob(value, kind),
  });
}
