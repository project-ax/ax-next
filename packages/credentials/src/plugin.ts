import { PluginError, type Plugin } from '@ax/core';
import type { Transaction } from 'kysely';
import { encryptWithKey, decryptWithKey, parseKeyFromEnv } from './crypto.js';

const PLUGIN_NAME = '@ax/credentials';
const REF_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
const KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const SCOPE_VALUES = ['global', 'user', 'agent'] as const;
export type CredentialScope = (typeof SCOPE_VALUES)[number];

export function validateScope(scope: unknown): CredentialScope {
  if (typeof scope !== 'string' || !(SCOPE_VALUES as readonly string[]).includes(scope)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `scope must be one of ${SCOPE_VALUES.join('|')}`,
    });
  }
  return scope as CredentialScope;
}

export function validateOwnerIdForScope(
  scope: CredentialScope,
  ownerId: unknown,
): string | null {
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
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `ownerId is required when scope='${scope}'`,
    });
  }
  // Reuse the existing USER_ID_RE — same character set is fine for agent ids.
  if (!USER_ID_RE.test(ownerId)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `ownerId must match ${USER_ID_RE.source}`,
    });
  }
  return ownerId;
}

export interface CredentialsGetInput {
  ref: string;
  userId: string;
}

export type CredentialsGetOutput = string;

export interface CredentialsSetInput {
  scope: CredentialScope;
  ownerId: string | null;
  ref: string;
  kind: string;
  payload: Uint8Array;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
  /** Optional transaction handle from db:transact's run callback. */
  tx?: Transaction<unknown>;
}

export type CredentialsSetOutput = void;

export interface CredentialsDeleteInput {
  scope: CredentialScope;
  ownerId: string | null;
  ref: string;
}

export type CredentialsDeleteOutput = void;

export interface CredentialsResolveInput {
  payload: Uint8Array;
  userId: string;
  ref: string;
}

export interface CredentialsResolveOutput {
  value: string;
  refreshed?: {
    payload: Uint8Array;
    expiresAt?: number;
    metadata?: Record<string, unknown>;
  };
}

export interface CredentialsListInput {
  scope?: CredentialScope;
  ownerId?: string | null;
}

export interface CredentialMeta {
  scope: CredentialScope;
  ownerId: string | null;
  ref: string;
  kind: string;
  createdAt: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CredentialsListOutput {
  credentials: CredentialMeta[];
}

export interface CredentialsListKindsOutput {
  kinds: Array<{ kind: string; flow: 'paste' | 'oauth' }>;
}

// Raw envelope primitive — `(plaintext: string) → ciphertext: Uint8Array` and
// the inverse. NOT the same shape as the credential-set envelope (which
// JSON-wraps `kind` + `payloadB64` + metadata). Other plugins want a
// general-purpose AEAD primitive that reuses the single AX_CREDENTIALS_KEY,
// not a credential-row workflow. See registration site for boundary-review note.
export interface CredentialsEnvelopeEncryptInput {
  plaintext: string;
}
export interface CredentialsEnvelopeEncryptOutput {
  ciphertext: Uint8Array;
}

export interface CredentialsEnvelopeDecryptInput {
  ciphertext: Uint8Array;
}
export interface CredentialsEnvelopeDecryptOutput {
  plaintext: string;
}

function validateRef(ref: unknown): string {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `credential ref must match ${REF_RE.source}`,
    });
  }
  return ref;
}

function validateUserId(userId: unknown): string {
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `userId must match ${USER_ID_RE.source}`,
    });
  }
  return userId;
}

function validateKind(kind: unknown): string {
  if (typeof kind !== 'string' || !KIND_RE.test(kind)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `kind must match ${KIND_RE.source}`,
    });
  }
  return kind;
}

/**
 * Optional config for `createCredentialsPlugin`. Today this only carries
 * the `envFallback` map — see the field-level comment below for the
 * trade-off and recommended usage.
 */
export interface CredentialsPluginConfig {
  /**
   * Optional process-env fallback for credential refs that have no entry
   * in any of the v2 storage scopes (user / agent / global). Used as the
   * BOTTOM of the resolution chain — if any v2 row exists for the ref
   * (in any scope, including a tombstone-fallthrough that resolves to a
   * lower scope), this map is skipped entirely. Shape: `{ ref → ENV_VAR_NAME }`.
   *
   * SECURITY: env values are universal — the same value is returned for
   * every user. Only safe for single-tenant kind/dev where there's one
   * admin user. Multi-tenant deployments should leave this empty and use
   * `POST /admin/credentials` (scope='global') instead, which goes
   * through the same encryption-at-rest envelope as everything else and
   * shows up in the admin UI's list. The plugin warns at boot when
   * fallback is configured to make the trade-off impossible to miss.
   *
   * Future: a follow-up may remove this entirely once kind/dev migrates
   * to the admin-UI flow. Today (2026-05-07) the k8s preset still wires
   * `AX_CREDENTIALS_KEY` + `ANTHROPIC_API_KEY` →
   * `envFallback['anthropic-api-key']` for ergonomics, so a fresh kind
   * cluster talks to Anthropic without a separate seed step.
   */
  envFallback?: Readonly<Record<string, string>>;
}

export function createCredentialsPlugin(config: CredentialsPluginConfig = {}): Plugin {
  const envFallback = config.envFallback ?? {};
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'credentials:get',
        'credentials:set',
        'credentials:delete',
        'credentials:list',
        'credentials:list-kinds',
        'credentials:resolve:setting',
        'credentials:envelope-encrypt',
        'credentials:envelope-decrypt',
      ],
      // Storage goes through the `credentials:store-blob:*` seam (Phase 1b).
      // The default backend is `@ax/credentials-store-db`; vault / KMS
      // backends slot in here without touching the facade.
      //
      // Per-kind dispatch (`credentials:resolve:<kind>`) is checked at runtime
      // via bus.hasService — we don't enumerate every kind in the manifest
      // because new kinds slot in by registering a sibling plugin.
      calls: [
        'credentials:store-blob:get',
        'credentials:store-blob:put',
        'credentials:store-blob:list',
      ],
      subscribes: [],
    },
    async init({ bus }) {
      const raw = process.env.AX_CREDENTIALS_KEY;
      if (raw === undefined || raw === '') {
        throw new PluginError({
          code: 'missing-env',
          plugin: PLUGIN_NAME,
          message:
            'AX_CREDENTIALS_KEY is required (32 bytes, 64 hex chars or 44 base64 chars)',
        });
      }
      const key = parseKeyFromEnv(raw);

      // Wrap a per-kind payload + metadata in an envelope, then encrypt.
      // The envelope lets credentials:get dispatch to the right resolve
      // sub-service without an extra storage column for `kind` (Phase 3
      // open question §1: stay schema-light for MVP).
      //
      // `createdAt` is stamped by the facade (callers don't supply it).
      // It rides inside the encrypted blob — same trust boundary as the
      // payload itself, so we don't need a separate storage column.
      function wrapEnvelope(
        kind: string,
        payload: Uint8Array,
        expiresAt: number | undefined,
        metadata: Record<string, unknown> | undefined,
        createdAt: number,
      ): Uint8Array {
        const env: {
          kind: string;
          payloadB64: string;
          createdAt: number;
          expiresAt?: number;
          metadata?: Record<string, unknown>;
        } = {
          kind,
          payloadB64: Buffer.from(payload).toString('base64'),
          createdAt,
        };
        if (expiresAt !== undefined) env.expiresAt = expiresAt;
        if (metadata !== undefined) env.metadata = metadata;
        return encryptWithKey(key, JSON.stringify(env));
      }

      function unwrapEnvelope(blob: Uint8Array): {
        kind: string;
        payload: Uint8Array;
        createdAt?: number;
        expiresAt?: number;
        metadata?: Record<string, unknown>;
        isTombstone: boolean;
      } {
        // decryptWithKey throws PluginError without echoing plaintext.
        const plaintext = decryptWithKey(key, blob);
        // Empty plaintext = tombstone (see credentials:delete). Caller
        // reports not-found; this branch never references plaintext.
        if (plaintext === '') {
          return {
            kind: '',
            payload: new Uint8Array(),
            isTombstone: true,
          };
        }
        let env: unknown;
        try {
          env = JSON.parse(plaintext);
        } catch {
          throw new PluginError({
            code: 'invalid-envelope',
            plugin: PLUGIN_NAME,
            message: 'credential envelope JSON parse failed',
          });
        }
        if (
          typeof env !== 'object' ||
          env === null ||
          typeof (env as { kind: unknown }).kind !== 'string' ||
          typeof (env as { payloadB64: unknown }).payloadB64 !== 'string'
        ) {
          throw new PluginError({
            code: 'invalid-envelope',
            plugin: PLUGIN_NAME,
            message: 'credential envelope missing kind or payloadB64',
          });
        }
        const e = env as {
          kind: string;
          payloadB64: string;
          createdAt?: number;
          expiresAt?: number;
          metadata?: Record<string, unknown>;
        };
        const out: {
          kind: string;
          payload: Uint8Array;
          createdAt?: number;
          expiresAt?: number;
          metadata?: Record<string, unknown>;
          isTombstone: boolean;
        } = {
          kind: e.kind,
          payload: new Uint8Array(Buffer.from(e.payloadB64, 'base64')),
          isTombstone: false,
        };
        if (e.createdAt !== undefined) out.createdAt = e.createdAt;
        if (e.expiresAt !== undefined) out.expiresAt = e.expiresAt;
        if (e.metadata !== undefined) out.metadata = e.metadata;
        return out;
      }

      bus.registerService<CredentialsSetInput, CredentialsSetOutput>(
        'credentials:set',
        PLUGIN_NAME,
        async (ctx, input) => {
          const scope = validateScope(input.scope);
          const ownerId = validateOwnerIdForScope(scope, input.ownerId);
          const ref = validateRef(input.ref);
          const kind = validateKind(input.kind);
          if (!(input.payload instanceof Uint8Array)) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: `credential payload must be a Uint8Array`,
            });
          }
          const blob = wrapEnvelope(
            kind,
            input.payload,
            input.expiresAt,
            input.metadata,
            Date.now(),
          );
          await bus.call('credentials:store-blob:put', ctx, {
            scope,
            ownerId,
            ref,
            blob,
            tx: input.tx,
          });
        },
      );

      // Per-resolved-row mutex. The key is the RESOLVED (scope, ownerId, ref)
      // tuple — NOT (userId, ref). Two concurrent credentials:get calls
      // landing on the same row (e.g. two distinct users hitting the same
      // global OAuth blob) share one Promise so the refresh fires at most
      // once. Different rows run in parallel; this is the same shape as
      // the original (userId, ref) mutex but corrected for the cross-user
      // case the precedence chain introduced. (I7.)
      const inflight = new Map<string, Promise<string>>();

      function mutexKey(scope: CredentialScope, ownerId: string | null, ref: string): string {
        return `${scope}:${ownerId ?? ''}:${ref}`;
      }

      async function resolveFromRow(
        ctx: Parameters<Parameters<typeof bus.registerService>[2]>[0],
        scope: CredentialScope,
        ownerId: string | null,
        ref: string,
        userId: string,
        env: ReturnType<typeof unwrapEnvelope>,
      ): Promise<string> {
        const subService = `credentials:resolve:${env.kind}`;
        if (bus.hasService(subService)) {
          const out = await bus.call<CredentialsResolveInput, CredentialsResolveOutput>(
            subService,
            ctx,
            { payload: env.payload, userId, ref },
          );
          if (out.refreshed !== undefined) {
            // Re-store under the SAME scope+ownerId we resolved from.
            // Sub-service may bump expiresAt or metadata as part of the
            // refresh — propagate both.
            const refreshArgs: CredentialsSetInput = {
              scope,
              ownerId,
              ref,
              kind: env.kind,
              payload: out.refreshed.payload,
            };
            if (out.refreshed.expiresAt !== undefined) {
              refreshArgs.expiresAt = out.refreshed.expiresAt;
            }
            const md = out.refreshed.metadata ?? env.metadata;
            if (md !== undefined) refreshArgs.metadata = md;
            await bus.call('credentials:set', ctx, refreshArgs);
          }
          return out.value;
        }
        // No sub-service registered. Only `api-key` defaults to the
        // payload-is-the-value UTF-8 path. Any other kind without its
        // resolver loaded is a misconfiguration — fail closed rather
        // than handing back the (encrypted) blob bytes as a string,
        // which would leak unparsed envelope content into the caller.
        if (env.kind === 'api-key') {
          return new TextDecoder().decode(env.payload);
        }
        throw new PluginError({
          code: 'unsupported-credential-kind',
          plugin: PLUGIN_NAME,
          message: `no resolver registered for credential kind '${env.kind}' (ref='${ref}')`,
        });
      }

      async function doResolve(
        ctx: Parameters<Parameters<typeof bus.registerService>[2]>[0],
        userId: string,
        ref: string,
      ): Promise<string> {
        // Walk the resolution-precedence chain: user → agent → global →
        // envFallback → not-found. The chain is intentionally fixed (not
        // configurable) — that's the point of the abstraction. Tombstones
        // in any scope short-circuit "no credential here, try next scope"
        // (NOT "give up entirely") because deleting at one scope shouldn't
        // mask a value at another. Tombstone semantics for non-fallthrough
        // are tested at the per-scope set/delete level.
        //
        // The walk runs OUTSIDE the inflight mutex — store-blob:get is
        // cheap (one row read, no network refresh), and pulling it out of
        // the mutex lets us key the mutex on the row that actually got
        // hit, not on the (userId, ref) input. That's what makes a
        // cross-user refresh share one resolver call.
        const attempts: Array<{ scope: CredentialScope; ownerId: string | null }> = [];
        attempts.push({ scope: 'user', ownerId: userId });
        if (ctx.agentId !== undefined && ctx.agentId !== '') {
          attempts.push({ scope: 'agent', ownerId: ctx.agentId });
        }
        attempts.push({ scope: 'global', ownerId: null });

        for (const a of attempts) {
          const got = await bus.call<
            { scope: CredentialScope; ownerId: string | null; ref: string },
            { blob: Uint8Array | undefined }
          >('credentials:store-blob:get', ctx, { scope: a.scope, ownerId: a.ownerId, ref });
          if (got.blob === undefined) continue;
          const env = unwrapEnvelope(got.blob);
          if (env.isTombstone) continue; // tombstone in this scope; try next

          // Found the row. Mutex on the RESOLVED tuple so concurrent
          // callers landing here share one resolver Promise.
          const key = mutexKey(a.scope, a.ownerId, ref);
          const existing = inflight.get(key);
          if (existing !== undefined) return existing;
          const p = resolveFromRow(ctx, a.scope, a.ownerId, ref, userId, env);
          inflight.set(key, p);
          try {
            return await p;
          } finally {
            inflight.delete(key);
          }
        }
        // None of the v2 scopes had it. Fall through to env fallback —
        // single-tenant / kind-dev posture. See CredentialsPluginConfig.envFallback
        // for the trade-off. We only land here when no row matched
        // anywhere; tombstones in user scope are skipped per attempt loop
        // and would make us proceed to agent/global, but if every scope
        // is empty-or-tombstoned, env fallback is correct. Tombstones in
        // ALL scopes meaning "deny everywhere" still permit env fallback
        // — operators who want stricter behaviour should leave env empty.
        const envName = envFallback[ref];
        if (envName !== undefined) {
          const v = process.env[envName];
          if (typeof v === 'string' && v.length > 0) return v;
        }
        throw new PluginError({
          code: 'credential-not-found',
          plugin: PLUGIN_NAME,
          message: `no credential for ref='${ref}'`,
        });
      }

      bus.registerService<CredentialsGetInput, CredentialsGetOutput>(
        'credentials:get',
        PLUGIN_NAME,
        async (ctx, input) => {
          const ref = validateRef(input.ref);
          const userId = validateUserId(input.userId);
          return doResolve(ctx, userId, ref);
        },
      );

      bus.registerService<CredentialsDeleteInput, CredentialsDeleteOutput>(
        'credentials:delete',
        PLUGIN_NAME,
        async (ctx, input) => {
          const scope = validateScope(input.scope);
          const ownerId = validateOwnerIdForScope(scope, input.ownerId);
          const ref = validateRef(input.ref);
          // The store-blob layer is bytes-only and has no `:delete` hook in
          // Phase 1b, so we use the same encrypted-empty-string tombstone we
          // had when this plugin called storage:set directly. credentials:get
          // checks for empty plaintext above and reports not-found.
          const tombstone = encryptWithKey(key, '');
          await bus.call('credentials:store-blob:put', ctx, {
            scope,
            ownerId,
            ref,
            blob: tombstone,
          });
        },
      );

      bus.registerService<CredentialsListInput, CredentialsListOutput>(
        'credentials:list',
        PLUGIN_NAME,
        async (ctx, input) => {
          // Reject `ownerId` without `scope` — the previous silent-ignore
          // could mask caller bugs (e.g., admin UI passing user id but
          // forgetting to set scope='user' would return GLOBAL rows). Fail
          // closed instead.
          if (input.scope === undefined && input.ownerId !== undefined) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message: 'ownerId filter requires scope to be specified',
            });
          }
          const filter: { scope?: CredentialScope; ownerId?: string | null } = {};
          if (input.scope !== undefined) filter.scope = validateScope(input.scope);
          if (input.ownerId !== undefined && filter.scope !== undefined) {
            filter.ownerId = validateOwnerIdForScope(filter.scope, input.ownerId);
          }
          const out = await bus.call<
            typeof filter,
            {
              entries: Array<{
                scope: CredentialScope;
                ownerId: string | null;
                ref: string;
                blob: Uint8Array;
              }>;
            }
          >('credentials:store-blob:list', ctx, filter);
          const meta: CredentialMeta[] = [];
          for (const e of out.entries) {
            try {
              const env = unwrapEnvelope(e.blob);
              if (env.isTombstone) continue;
              const m: CredentialMeta = {
                scope: e.scope,
                ownerId: e.ownerId,
                ref: e.ref,
                kind: env.kind,
                createdAt:
                  env.createdAt !== undefined && env.createdAt > 0
                    ? new Date(env.createdAt).toISOString()
                    : new Date(0).toISOString(),
              };
              if (env.expiresAt !== undefined) {
                m.expiresAt = new Date(env.expiresAt).toISOString();
              }
              if (env.metadata !== undefined) m.metadata = env.metadata;
              meta.push(m);
            } catch {
              // Skip undecryptable blobs (different AX_CREDENTIALS_KEY) silently.
              // Listing must not 500 on a key-rotation aftermath.
            }
          }
          return { credentials: meta };
        },
      );

      bus.registerService<Record<string, never>, CredentialsListKindsOutput>(
        'credentials:list-kinds',
        PLUGIN_NAME,
        async () => {
          // `api-key` is always available — it's the paste-flow path the facade
          // handles directly without a sub-service. OAuth-style kinds are
          // discovered by walking the bus for `credentials:login:*` services;
          // each oauth plugin (e.g. @ax/credentials-anthropic-oauth) registers
          // one such hook to drive its login flow.
          const kinds: Array<{ kind: string; flow: 'paste' | 'oauth' }> = [
            { kind: 'api-key', flow: 'paste' },
          ];
          const svcs = bus.listServices();
          const prefix = 'credentials:login:';
          for (const svc of svcs) {
            if (svc.startsWith(prefix)) {
              kinds.push({ kind: svc.slice(prefix.length), flow: 'oauth' });
            }
          }
          return { kinds };
        },
      );

      bus.registerService<CredentialsResolveInput, CredentialsResolveOutput>(
        'credentials:resolve:setting',
        PLUGIN_NAME,
        async (_ctx, input) => {
          return { value: new TextDecoder().decode(input.payload) };
        },
      );

      // General-purpose AEAD primitive for cross-plugin reuse of the single
      // AX_CREDENTIALS_KEY (Invariant I4: one source of truth for at-rest
      // envelopes; I5: only @ax/credentials reads the key).
      //
      // Boundary review: alternate impl is an HSM/KMS-backed plugin
      // (`@ax/credentials-kms`) with the same `(plaintext: string) →
      // ciphertext: Uint8Array` shape but the key never leaves the HSM.
      // No backend vocabulary leaks in either direction — `plaintext` /
      // `ciphertext` are crypto primitives, not aes/gcm/iv/kms_arn.
      bus.registerService<
        CredentialsEnvelopeEncryptInput,
        CredentialsEnvelopeEncryptOutput
      >('credentials:envelope-encrypt', PLUGIN_NAME, async (_ctx, input) => {
        if (typeof input.plaintext !== 'string') {
          throw new PluginError({
            code: 'invalid-payload',
            plugin: PLUGIN_NAME,
            message: 'plaintext must be a string',
          });
        }
        return { ciphertext: encryptWithKey(key, input.plaintext) };
      });

      bus.registerService<
        CredentialsEnvelopeDecryptInput,
        CredentialsEnvelopeDecryptOutput
      >('credentials:envelope-decrypt', PLUGIN_NAME, async (_ctx, input) => {
        if (!(input.ciphertext instanceof Uint8Array)) {
          throw new PluginError({
            code: 'invalid-payload',
            plugin: PLUGIN_NAME,
            message: 'ciphertext must be a Uint8Array',
          });
        }
        // decryptWithKey throws PluginError({code:'decrypt-failed'|'invalid-ciphertext'})
        // — propagate as-is.
        return { plaintext: decryptWithKey(key, input.ciphertext) };
      });
    },
  };
}
