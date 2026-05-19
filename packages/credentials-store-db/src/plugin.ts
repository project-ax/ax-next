import { PluginError, type HookBus, type Plugin } from '@ax/core';
import type { Transaction } from 'kysely';

/**
 * @ax/credentials-store-db — default storage backend for @ax/credentials.
 *
 * Registers the `credentials:store-blob:*` sub-service surface that the
 * credentials facade calls instead of `storage:get` / `storage:set`. The
 * seam exists so future vault / KMS backends (`@ax/credentials-store-vault`,
 * `@ax/credentials-store-aws-sm`, ...) can replace the default by
 * registering the same hooks against a different backend — no change at
 * the facade.
 *
 * This default impl persists ciphertext blobs through the existing
 * `storage:get` / `storage:set` KV surface, prefixing every key with
 * `credential:v2:`. The prefix is owned by THIS plugin (not by the facade);
 * a vault-backed sibling wouldn't use storage at all.
 *
 * Key shape (v2): `credential:v2:${scope}:${ownerId??"_"}:${ref}` — scope
 * is one of 'global'|'user'|'agent'. v1 keys (`credential:${userId}:${ref}`)
 * are read as a fallback for `scope='user'` only; v1 had no concept of
 * global or agent scopes.
 *
 * What this plugin is NOT:
 *   - It does not encrypt. AES-256-GCM is owned by `@ax/credentials`.
 *     Blobs in / blobs out, no plaintext on the seam.
 *   - It does not own deletion. The facade's tombstone-via-put trick
 *     still rides on `:put` until the design's `credentials:store-blob:delete`
 *     contract earns its weight.
 */

const PLUGIN_NAME = '@ax/credentials-store-db';
const KEY_PREFIX_V2 = 'credential:v2:';
const KEY_PREFIX_V1 = 'credential:';
// `:` is the separator for deterministic destination refs
// (provider:anthropic, skill:<id>:<slot>, mcp:<id>:env:<name>, etc.).
// The full ref including separators is one opaque string from the
// store's POV — refs are never parsed back out. See refs.ts.
const REF_RE = /^[a-z0-9][a-z0-9_.:-]{0,191}$/;
const OWNER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
const SCOPE_VALUES = ['global', 'user', 'agent'] as const;
type Scope = (typeof SCOPE_VALUES)[number];

export interface StoreBlobPutInput {
  scope: Scope;
  ownerId: string | null;
  ref: string;
  blob: Uint8Array;
  /**
   * Optional transaction handle from db:transact's run callback. Threaded
   * down to storage:set. I1 relaxation — see @ax/storage-postgres's
   * `db:transact` registration site for the rationale.
   */
  tx?: Transaction<unknown>;
}

export interface StoreBlobGetInput {
  scope: Scope;
  ownerId: string | null;
  ref: string;
}

export interface StoreBlobGetOutput {
  blob: Uint8Array | undefined;
}

export interface StoreBlobListInput {
  // undefined means "all scopes" (admin list); otherwise filter to one.
  scope?: Scope;
  ownerId?: string | null;
}

export interface StoreBlobListEntry {
  scope: Scope;
  ownerId: string | null;
  ref: string;
  blob: Uint8Array;
}

export interface StoreBlobListOutput {
  entries: StoreBlobListEntry[];
}

export function v2StorageKey(scope: Scope, ownerId: string | null, ref: string): string {
  return `${KEY_PREFIX_V2}${scope}:${ownerId ?? '_'}:${ref}`;
}

export function v1StorageKey(userId: string, ref: string): string {
  return `${KEY_PREFIX_V1}${userId}:${ref}`;
}

function validateScope(scope: unknown): Scope {
  if (typeof scope !== 'string' || !(SCOPE_VALUES as readonly string[]).includes(scope)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `scope must be one of ${SCOPE_VALUES.join('|')}`,
    });
  }
  return scope as Scope;
}

function validateOwnerId(scope: Scope, ownerId: unknown): string | null {
  if (scope === 'global') {
    if (ownerId !== null) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        message: "ownerId must be null when scope='global'",
      });
    }
    return null;
  }
  if (typeof ownerId !== 'string' || !OWNER_ID_RE.test(ownerId)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `ownerId must match ${OWNER_ID_RE.source}`,
    });
  }
  return ownerId;
}

function validateRef(ref: unknown): string {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `ref must match ${REF_RE.source}`,
    });
  }
  return ref;
}

const RESET_CLEANUP_KEY = `${PLUGIN_NAME}/bootstrap-reset-cleanup`;

export function createCredentialsStoreDbPlugin(): Plugin {
  let busRef: HookBus | undefined;
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'credentials:store-blob:put',
        'credentials:store-blob:get',
        'credentials:store-blob:list',
      ],
      calls: [
        'storage:get',
        'storage:set',
        'storage:list-prefix',
        'storage:delete-prefix',
      ],
      subscribes: ['bootstrap:reset-cleanup'],
    },
    async init({ bus }) {
      busRef = bus;
      bus.registerService<StoreBlobPutInput, void>(
        'credentials:store-blob:put',
        PLUGIN_NAME,
        async (ctx, input) => {
          const scope = validateScope(input.scope);
          const ownerId = validateOwnerId(scope, input.ownerId);
          const ref = validateRef(input.ref);
          if (!(input.blob instanceof Uint8Array)) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'credential blob must be a Uint8Array',
            });
          }
          await bus.call('storage:set', ctx, {
            key: v2StorageKey(scope, ownerId, ref),
            value: input.blob,
            tx: input.tx,
          });
        },
      );

      bus.registerService<StoreBlobGetInput, StoreBlobGetOutput>(
        'credentials:store-blob:get',
        PLUGIN_NAME,
        async (ctx, input) => {
          const scope = validateScope(input.scope);
          const ownerId = validateOwnerId(scope, input.ownerId);
          const ref = validateRef(input.ref);
          const v2 = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
            'storage:get',
            ctx,
            { key: v2StorageKey(scope, ownerId, ref) },
          );
          if (v2.value !== undefined) return { blob: v2.value };
          // Fallback to v1 ONLY for scope='user' (v1 keys were per-userId only).
          if (scope === 'user' && ownerId !== null) {
            const v1 = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
              'storage:get',
              ctx,
              { key: v1StorageKey(ownerId, ref) },
            );
            return { blob: v1.value };
          }
          return { blob: undefined };
        },
      );

      // Bootstrap-reset cleanup: when an operator runs `ax admin
      // reset-bootstrap --force`, drop every credential row (both v1 and
      // v2 prefixes) so the wizard's model step can re-seed the
      // Anthropic API key against the new admin user without orphaning
      // rows under deleted user_ids. Storage backends own deletion via
      // the storage:delete-prefix hook (storage-postgres + storage-sqlite
      // both register it).
      bus.subscribe(
        'bootstrap:reset-cleanup',
        RESET_CLEANUP_KEY,
        async (subCtx) => {
          await bus.call<{ prefix: string }, { deleted: number }>(
            'storage:delete-prefix',
            subCtx,
            { prefix: KEY_PREFIX_V2 },
          );
          // KEY_PREFIX_V1 ('credential:') is a strict superset of V2
          // ('credential:v2:') — wipe-by-prefix on V1 also clobbers
          // anything still on V2, so the V2 call above is technically
          // redundant. Kept for symmetry: if a future v3 prefix lands,
          // v2 will deserve its own explicit wipe.
          await bus.call<{ prefix: string }, { deleted: number }>(
            'storage:delete-prefix',
            subCtx,
            { prefix: KEY_PREFIX_V1 },
          );
          return undefined;
        },
      );

      bus.registerService<StoreBlobListInput, StoreBlobListOutput>(
        'credentials:store-blob:list',
        PLUGIN_NAME,
        async (ctx, input) => {
          // Build prefix based on filters.
          let prefix = KEY_PREFIX_V2;
          if (input.scope !== undefined) {
            const scope = validateScope(input.scope);
            prefix += `${scope}:`;
            if (input.ownerId !== undefined) {
              const ownerId = validateOwnerId(scope, input.ownerId);
              prefix += `${ownerId ?? '_'}:`;
            }
          }
          const out = await bus.call<
            { prefix: string },
            { entries: Array<{ key: string; value: Uint8Array }> }
          >('storage:list-prefix', ctx, { prefix });
          const entries: StoreBlobListEntry[] = [];
          for (const e of out.entries) {
            const rest = e.key.slice(KEY_PREFIX_V2.length); // "scope:owner:ref"
            const firstColon = rest.indexOf(':');
            const secondColon = rest.indexOf(':', firstColon + 1);
            if (firstColon < 0 || secondColon < 0) continue;
            const scope = rest.slice(0, firstColon) as Scope;
            const ownerRaw = rest.slice(firstColon + 1, secondColon);
            const ref = rest.slice(secondColon + 1);
            entries.push({
              scope,
              ownerId: ownerRaw === '_' ? null : ownerRaw,
              ref,
              blob: e.value,
            });
          }
          return { entries };
        },
      );
    },
    async shutdown() {
      busRef?.unsubscribe('bootstrap:reset-cleanup', RESET_CLEANUP_KEY);
      busRef = undefined;
    },
  };
}
