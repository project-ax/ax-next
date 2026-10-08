import { PluginError, makeAgentContext, type AgentContext, type Plugin } from '@ax/core';
import { wipePreRedesignCredentials } from './wipe-pre-redesign.js';
import { purgeUserAccountCredentials } from './purge-user-account.js';
import type { Transaction } from 'kysely';
import { encryptWithKey, decryptWithKey, parseKeyFromEnv } from './crypto.js';
import { z, type ZodType } from 'zod';

const PLUGIN_NAME = '@ax/credentials';
// `:` is the separator for deterministic destination refs
// (provider:anthropic, skill:<id>:<slot>, account:<service>:<slot>, etc.).
// The full ref including separators is one opaque string from the
// store's POV — refs are never parsed back out. See refs.ts.
const REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,191}$/;
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
  /**
   * TASK-817 — the caller presented the value this ref last resolved to and
   * the service it was meant for refused it (e.g. HTTP 401). The kind's
   * resolver is told so (`CredentialsResolveInput.rejected`) and may mint a
   * new value instead of handing back the refused one; a kind with no
   * resolver (api-key) has nothing to renew and answers as usual. Only a
   * literal `true` counts.
   */
  rejected?: boolean;
}

export type CredentialsGetOutput = string;

/** Runtime contract for `credentials:get` — a resolved secret is a string. */
export const CredentialsGetOutputSchema = z.string();

export interface CredentialsHasInput {
  ref: string;
  userId: string;
}

export interface CredentialsHasOutput {
  present: boolean;
}

/**
 * Runtime `returns` contract for `credentials:has` (ARCH-6) — a presence
 * boolean and nothing else. Deliberately carries no value, kind, scope, or
 * timestamp: the whole point of the hook is that it answers "is something
 * there?" without handing back anything about what.
 */
export const CredentialsHasOutputSchema = z.object({
  present: z.boolean(),
}) as unknown as ZodType<CredentialsHasOutput>;

export interface CredentialsSetInput {
  scope: CredentialScope;
  ownerId: string | null;
  ref: string;
  kind: string;
  payload: Uint8Array;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
  /**
   * Optional transaction handle from db:transact's run callback. Threaded
   * through to credentials:store-blob:put → storage:set so the credential
   * write rolls back atomically on caller throw.
   *
   * I1 relaxation: this leaks Kysely's `Transaction` shape into the public
   * `@ax/credentials` type surface (visible in published `.d.ts`). Accepted
   * for Phase 2's wizard atomicity (I9). See registration site of
   * `db:transact` in @ax/storage-postgres for the rationale.
   */
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
  /**
   * TASK-756 — the scope + owner of the row this payload was read from (the
   * same pair a refresh is re-stored under). Lets a resolver tell a token
   * one person owns from one an agent's members share — e.g. so a "sign in
   * again" marker is kept per agent for a shared token. Vault vocabulary
   * only (`user` / `agent` / `global`); no backend detail.
   */
  scope: CredentialScope;
  ownerId: string | null;
  /**
   * TASK-817 — present (and `true`) only when the `credentials:get` caller
   * said the value it last got was refused by the service it was presented
   * to. A resolver that can renew (an OAuth refresh) should, rather than
   * answer the stored value again.
   */
  rejected?: true;
}

export interface CredentialsResolveOutput {
  value: string;
  refreshed?: {
    payload: Uint8Array;
    expiresAt?: number;
    metadata?: Record<string, unknown>;
  };
}

/**
 * Runtime contract for `credentials:resolve:setting`. Hand-mirrors the
 * `CredentialsResolveOutput` interface. A compile-time `z.infer extends
 * interface` guard isn't viable here (zod's `.optional()` infers `| undefined`,
 * which `exactOptionalPropertyTypes` rejects against the interface's exact
 * optionals; and `z.instanceof(Uint8Array)` infers a narrower `Uint8Array`
 * generic) — so `return-schemas.test.ts` guards drift at runtime instead: a
 * fully-populated interface-typed value must round-trip through the schema
 * without losing fields.
 */
export const CredentialsResolveOutputSchema = z.object({
  value: z.string(),
  refreshed: z
    .object({
      payload: z.instanceof(Uint8Array),
      expiresAt: z.number().optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .optional(),
});

/**
 * Service hook a provider registers to authorize the GLOBAL-scope step of
 * `credentials:get` for `account:` refs (TASK-697).
 *
 * Why it exists: a connector's credential ref is `account:<connectorId>` (or
 * `account:<connectorId>:<SLOT>`), and the connector id is chosen by whichever
 * USER authors the connector. Without a gate, the fixed user -> agent -> global
 * chain would hand a company-wide (global-scope) key to any user who authors a
 * connector with the same id as a company-keyed one. So for `account:` refs the
 * global step is taken only when a provider answers `{ allowed: true }` for
 * this `(userId, ref)`. No provider, any other answer, or a throw = skip the
 * global step (fail closed). The agent step is gated by the twin hook below
 * (TASK-711); the user scope is not gated, and refs in
 * any other namespace (`provider:`, `skill:`, `routine:`, or a retired `mcp:`
 * row left in the store) never call it.
 *
 * Deliberately NOT declared in the manifest at all: the provider
 * (@ax/connectors) already depends on this plugin, so a declared edge back
 * would be a plugin call-graph cycle. It is checked at runtime with
 * `bus.hasService`, like `credentials:resolve:<kind>` (see the note above
 * `calls` in the manifest).
 */
export const CREDENTIALS_AUTHORIZE_GLOBAL_ACCOUNT_HOOK = 'credentials:authorize-global:account';

/** Refs in this namespace are user-chosen (connector ids) and gate their AGENT and GLOBAL steps. */
const GUARDED_ACCOUNT_REF_PREFIX = 'account:';

export interface CredentialsAuthorizeGlobalInput {
  /** The user asking to read `ref` (the `userId` passed to `credentials:get`). */
  userId: string;
  /** The full credential ref, e.g. `account:zendesk` or `account:zendesk:ZENDESK_API_TOKEN`. */
  ref: string;
}

export interface CredentialsAuthorizeGlobalOutput {
  /** Only a strict `true` opens the global step; anything else is a denial. */
  allowed: boolean;
}

/**
 * TASK-711 — the AGENT-scope twin of the hook above.
 *
 * An agent-scope `account:<id>` row is a credential stored ON an agent (a team
 * agent's shared OAuth sign-in, written by @ax/mcp-oauth's callback). The ref
 * is still a connector id, and connector ids are unique per OWNER, not
 * globally: a member of a team agent can author their own connector with the
 * same id as the team's shared one, point it at a server they control, and a
 * bare agent fall-through would hand the team's token to that server.
 *
 * So for `account:` refs the AGENT step is taken only when a provider answers
 * `{ allowed: true }` for this `(userId, agentId, ref)`. Same fail-closed rules
 * as the global hook: no provider, any other answer, or a throw = skip the
 * agent step. Same deliberate absence from the manifest, for the same reason
 * (the provider, @ax/connectors, already depends on this plugin).
 */
export const CREDENTIALS_AUTHORIZE_AGENT_ACCOUNT_HOOK = 'credentials:authorize-agent:account';

export interface CredentialsAuthorizeAgentInput {
  /** The user asking to read `ref` (the `userId` passed to `credentials:get`). */
  userId: string;
  /** The agent whose row would be read (the agent-scope row's ownerId). */
  agentId: string;
  /** The full credential ref, e.g. `account:linear`. */
  ref: string;
  // No `purpose` field, on purpose: the vault always asks the READ question,
  // which (TASK-788) also requires the connector to be attached to the agent.
  // Only @ax/mcp-oauth's write-scope decision passes `purpose: 'store'`.
}

export interface CredentialsAuthorizeAgentOutput {
  /** Only a strict `true` opens the agent step; anything else is a denial. */
  allowed: boolean;
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

/**
 * Runtime `returns` contract for `credentials:list` (ARCH-6). Extends the
 * existing `credentials:get` / `credentials:resolve:setting` schema rollout to
 * the remaining metadata read on this security-boundary plugin. The schema
 * NEVER carries plaintext or ciphertext — only metadata (`scope`, `ref`,
 * `kind`, timestamps). `createdAt`/`expiresAt` are ISO-8601 strings (the
 * handler stringifies the stored epoch ms before returning). `metadata` is an
 * opaque per-credential record. Cast to `ZodType<CredentialsListOutput>`: the
 * inferred optional shape can't be proven assignable under
 * `exactOptionalPropertyTypes`; `return-schemas.test.ts` is the drift guard.
 */
const CredentialMetaSchema = z.object({
  scope: z.enum(SCOPE_VALUES),
  ownerId: z.string().nullable(),
  ref: z.string(),
  kind: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const CredentialsListOutputSchema = z.object({
  credentials: z.array(CredentialMetaSchema),
}) as unknown as ZodType<CredentialsListOutput>;

export interface CredentialsListKindsOutput {
  kinds: Array<{ kind: string; flow: 'paste' | 'oauth' }>;
}

/** Runtime `returns` contract for `credentials:list-kinds` (ARCH-6). */
export const CredentialsListKindsOutputSchema = z.object({
  kinds: z.array(
    z.object({
      kind: z.string(),
      flow: z.union([z.literal('paste'), z.literal('oauth')]),
    }),
  ),
}) as unknown as ZodType<CredentialsListKindsOutput>;

export type CredentialsPurgeByOwnerInput =
  | { scope: 'user'; ownerId: string }
  | { scope: 'agent'; ownerId: string };

export interface CredentialsPurgeByOwnerOutput {
  deleted: number;
}

/**
 * `credentials:purge-account` — tombstone connector credentials (`account:` refs).
 *
 * With `connectorId`: `account:<id>` and `account:<id>:<anything>` only — the
 * trailing `:` keeps `gmail` from matching `gmail2`. Without it: every
 * `account:` row. Agent scope only (SIGNINS-7): `scopes` must be `['agent']`,
 * and anything else — 'user' or 'global' — is refused (invalid-payload).
 * Connector credentials live on agents or globally; a company key is a
 * connector's OWN key, purged by ref via `credentials:delete`. Other ref
 * namespaces are never touched. Used when a connector is deleted.
 *
 * The one-time boot purge of person-level connector credentials
 * (purge-user-account.ts) needs user scope; it calls this plugin's internal
 * function directly, so no hook caller can reach a user-scope purge.
 *
 * Boundary review: alternate impl = a KMS/vault backend deleting by tag; no
 * backend vocabulary in the payload.
 */
export interface CredentialsPurgeAccountInput {
  /** Omit to purge EVERY `account:` row in `scopes`. */
  connectorId?: string;
  /** Non-empty, and only 'agent' (SIGNINS-7) — 'user' and 'global' are rejected. */
  scopes: Array<'agent'>;
}

export interface CredentialsPurgeAccountOutput {
  /** Live rows tombstoned. */
  purged: number;
}

// What `unwrapEnvelope` throws for a blob it cannot read (crypto.ts +
// unwrapEnvelope): the row is dead weight, so purge-account tombstones it.
const UNREADABLE_BLOB_CODES: ReadonlySet<string> = new Set([
  'decrypt-failed',
  'invalid-ciphertext',
  'invalid-envelope',
]);

// Mirrors @ax/connectors' connector-id grammar (its store.ts validateConnectorId:
// lowercase slug, 1-128 chars; no cross-plugin import — the hook bus is the API). A ':' can never appear, so `account:<id>:` is exact.
const PURGE_CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

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
   * (For an `account:` ref the global scope only counts when the
   * `credentials:authorize-global:account` provider authorizes it; an
   * unauthorized global row is skipped, so the walk lands here as if it were
   * absent. The map itself is operator-configured and is not gated.)
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
        'credentials:has',
        'credentials:set',
        'credentials:delete',
        'credentials:list',
        'credentials:list-kinds',
        'credentials:purge-by-owner',
        'credentials:purge-account',
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
      //
      // The `credentials:authorize-global:account` provider (TASK-697) and its
      // agent-scope twin `credentials:authorize-agent:account` (TASK-711) are
      // called the same way and are deliberately NOT declared here, neither in
      // `calls` nor in `optionalCalls`. The provider is @ax/connectors, which
      // itself soft-depends on credentials:delete; a declared edge in this
      // direction would close a plugin call-graph cycle
      // (connectors -> credentials -> connectors) and bootstrap would refuse to
      // start any preset that loads both. The gap is still handled: with no
      // provider loaded, `account:` refs never resolve from GLOBAL scope (fail
      // closed) - workspace-keyed connector keys stop resolving, and neither do
      // `account:` rows stored on an agent (a team agent's shared sign-in).
      // `account:` refs never resolve from USER scope at all (agent-owned
      // sign-ins, slice 5), so with no provider they don't resolve.
      // account-global-guard's "boots alongside a provider that depends on
      // credentials:*" case pins that the graph stays acyclic.
      calls: [
        'credentials:store-blob:get',
        'credentials:store-blob:put',
        'credentials:store-blob:list',
        'credentials:store-blob:purge-by-owner',
      ],
      // storage:get / storage:set / storage:delete-prefix are called only when
      // a producer is present (gated by bus.hasService) by the wipe-once
      // pre-redesign-credentials routine on first boot; storage:get /
      // storage:set also hold the purge-once marker of the person-level
      // connector-credential purge (purge-user-account.ts). They are
      // OPTIONAL, not required: test harnesses that only stub
      // credentials:store-blob:* must still pass verifyCalls(), and a
      // deployment with no `storage:*` backend simply skips the one-time wipe
      // and purge. Declared here (rather than buried in a
      // comment) so the optional dependency is visible at the manifest level.
      optionalCalls: [
        {
          hook: 'storage:get',
          degradation:
            'one-time pre-redesign credential wipe and person-level connector-credential purge are skipped; new installs have nothing to wipe or purge, and the lookup already ignores person-level connector credentials',
        },
        {
          hook: 'storage:set',
          degradation:
            'wipe-once completion marker is not persisted, so the wipe scan re-runs (and finds nothing) on each boot until a storage backend is present; the person-level connector-credential purge is skipped (it needs somewhere to record that it ran)',
        },
        {
          hook: 'storage:delete-prefix',
          degradation:
            'stale pre-redesign credential rows are not purged from the legacy storage prefix; harmless on installs that never had them',
        },
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
          // Agent-owned sign-ins: a connector credential belongs to an agent
          // or to the whole workspace, never to one person — an agent must
          // never act as whoever is chatting with it. findRow never reads an
          // `account:` row at user scope, so refuse to write one. (delete
          // stays open so an old row can still be removed.)
          if (scope === 'user' && ref.startsWith(GUARDED_ACCOUNT_REF_PREFIX)) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              message:
                "connector credentials ('account:' refs) can't be stored per person; store them on the agent or globally",
            });
          }
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
      /** TASK-817 — the in-flight reads that were asked to renew a refused value. */
      const renewing = new WeakSet<Promise<string>>();

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
        rejected: boolean,
      ): Promise<string> {
        const subService = `credentials:resolve:${env.kind}`;
        if (bus.hasService(subService)) {
          const out = await bus.call<CredentialsResolveInput, CredentialsResolveOutput>(
            subService,
            ctx,
            {
              payload: env.payload,
              userId,
              ref,
              scope,
              ownerId,
              ...(rejected ? { rejected: true as const } : {}),
            },
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

      // May `userId` read the GLOBAL-scope row for this `account:` ref?
      // Fail closed on every path that isn't a strict `{ allowed: true }`:
      // no provider loaded, a provider that says no (or says something
      // malformed), and a provider that throws all mean "skip the global step".
      // Never logs a secret — nothing secret is in scope here (only the ref).
      async function mayReadGlobal(
        ctx: AgentContext,
        userId: string,
        ref: string,
      ): Promise<boolean> {
        if (!bus.hasService(CREDENTIALS_AUTHORIZE_GLOBAL_ACCOUNT_HOOK)) return false;
        let allowed: boolean;
        try {
          const out = await bus.call<
            CredentialsAuthorizeGlobalInput,
            CredentialsAuthorizeGlobalOutput
          >(CREDENTIALS_AUTHORIZE_GLOBAL_ACCOUNT_HOOK, ctx, { userId, ref });
          allowed = out.allowed === true;
        } catch (err) {
          ctx.logger.warn('credentials_global_guard_failed', {
            ref,
            error: err instanceof Error ? err.message : String(err),
          });
          return false;
        }
        if (!allowed) ctx.logger.info('credentials_global_read_denied', { ref });
        return allowed;
      }

      // TASK-711 — may `userId` read AGENT `agentId`'s row for this `account:`
      // ref? Same fail-closed shape as mayReadGlobal: only a strict
      // `{ allowed: true }` from a registered provider opens the step.
      async function mayReadAgent(
        ctx: AgentContext,
        userId: string,
        agentId: string,
        ref: string,
      ): Promise<boolean> {
        if (!bus.hasService(CREDENTIALS_AUTHORIZE_AGENT_ACCOUNT_HOOK)) return false;
        let allowed: boolean;
        try {
          const out = await bus.call<
            CredentialsAuthorizeAgentInput,
            CredentialsAuthorizeAgentOutput
          >(CREDENTIALS_AUTHORIZE_AGENT_ACCOUNT_HOOK, ctx, { userId, agentId, ref });
          allowed = out.allowed === true;
        } catch (err) {
          ctx.logger.warn('credentials_agent_guard_failed', {
            ref,
            error: err instanceof Error ? err.message : String(err),
          });
          return false;
        }
        if (!allowed) ctx.logger.info('credentials_agent_read_denied', { ref });
        return allowed;
      }

      // The row-finding walk, shared by `credentials:get` (via doResolve) and
      // `credentials:has` so the two can never disagree about what "found"
      // means. Returns the first live row on the chain, or undefined when no
      // v2 scope has one (the caller then consults the env fallback).
      //
      // Walks the resolution-precedence chain: user -> agent -> global. The
      // chain is intentionally fixed (not configurable) — that's the point of
      // the abstraction. Tombstones in any scope short-circuit "no credential
      // here, try next scope" (NOT "give up entirely") because deleting at one
      // scope shouldn't mask a value at another. Tombstone semantics for
      // non-fallthrough are tested at the per-scope set/delete level.
      //
      // `account:` refs (connector credentials) walk a shorter, gated chain:
      //   - NO user step (agent-owned sign-ins, slice 5). A connector
      //     credential belongs to the agent or to the workspace, never to the
      //     person chatting — an agent must never act as that person. A
      //     user-scope `account:` row left over from before is ignored here,
      //     refused by credentials:set, and removed once at boot
      //     (purge-user-account.ts).
      //   - the AGENT and GLOBAL steps are taken only when a provider says
      //     this user may read the row there — `credentials:authorize-agent:
      //     account` (mayReadAgent, TASK-711) and `credentials:authorize-
      //     global:account` (mayReadGlobal, TASK-697). The ref is a connector
      //     id, chosen by whoever authors the connector and unique only per
      //     owner — so a bare fall-through would hand a team agent's shared
      //     sign-in, or a company-wide key, to anyone who names their own
      //     connector after it.
      // `provider:` / `skill:` / `routine:` refs are minted by the platform,
      // not chosen by a user, so they walk the full chain unchanged.
      //
      // The walk makes no network call and never invokes a
      // `credentials:resolve:<kind>` service — store-blob:get is one cheap row
      // read. That is what lets doResolve run it outside the inflight mutex
      // (keying the mutex on the row that actually got hit, not on the
      // (userId, ref) input, so a cross-user refresh shares one resolver call)
      // and what lets `credentials:has` use it without ever refreshing a token.
      async function findRow(
        ctx: AgentContext,
        userId: string,
        ref: string,
      ): Promise<
        | { scope: CredentialScope; ownerId: string | null; env: ReturnType<typeof unwrapEnvelope> }
        | undefined
      > {
        const guardAccount = ref.startsWith(GUARDED_ACCOUNT_REF_PREFIX);
        const attempts: Array<{ scope: CredentialScope; ownerId: string | null }> = [];
        if (!guardAccount) attempts.push({ scope: 'user', ownerId: userId });
        if (ctx.agentId !== undefined && ctx.agentId !== '') {
          attempts.push({ scope: 'agent', ownerId: ctx.agentId });
        }
        attempts.push({ scope: 'global', ownerId: null });

        for (const a of attempts) {
          // Gate BEFORE the read, so a denied user never even loads the row.
          if (a.scope === 'global' && guardAccount && !(await mayReadGlobal(ctx, userId, ref))) {
            continue;
          }
          if (
            a.scope === 'agent' &&
            guardAccount &&
            a.ownerId !== null &&
            !(await mayReadAgent(ctx, userId, a.ownerId, ref))
          ) {
            continue;
          }
          const got = await bus.call<
            { scope: CredentialScope; ownerId: string | null; ref: string },
            { blob: Uint8Array | undefined }
          >('credentials:store-blob:get', ctx, { scope: a.scope, ownerId: a.ownerId, ref });
          if (got.blob === undefined) continue;
          const env = unwrapEnvelope(got.blob);
          if (env.isTombstone) continue; // tombstone in this scope; try next
          return { scope: a.scope, ownerId: a.ownerId, env };
        }
        return undefined;
      }

      // The bottom of the chain: the operator-configured env fallback. It is
      // only consulted when findRow found no row anywhere. Tombstones in user
      // scope are skipped per attempt and make the walk proceed to agent/global,
      // but if every scope is empty-or-tombstoned, env fallback is correct.
      // Tombstones in ALL scopes meaning "deny everywhere" still permit env
      // fallback — operators who want stricter behaviour should leave env
      // empty. See CredentialsPluginConfig.envFallback for the trade-off.
      // Returns undefined when the ref is unmapped or its env var is unset/empty.
      function envFallbackValue(ref: string): string | undefined {
        const envName = envFallback[ref];
        if (envName === undefined) return undefined;
        const v = process.env[envName];
        return typeof v === 'string' && v.length > 0 ? v : undefined;
      }

      async function doResolve(
        ctx: AgentContext,
        userId: string,
        ref: string,
        rejected: boolean,
      ): Promise<string> {
        // user -> agent -> global -> envFallback -> not-found (agent -> global
        // -> envFallback for `account:` refs). The walk (and its `account:`
        // rules) is findRow; it runs OUTSIDE the inflight mutex.
        let found = await findRow(ctx, userId, ref);
        if (found !== undefined) {
          // Found the row. Mutex on the RESOLVED tuple so concurrent
          // callers landing here share one resolver Promise.
          let key = mutexKey(found.scope, found.ownerId, ref);
          let existing = inflight.get(key);
          if (rejected) {
            // TASK-817 — a caller whose value was just refused must not be
            // handed the answer of an ordinary read already in flight (that
            // is the refused value). Nor may it run BESIDE that read: two
            // refreshes of one refresh token at once can make a rotating
            // authorization server reject the second as reuse. So: wait for
            // it to settle, then renew. Another rejected read in flight is
            // exactly what this caller wants, so share that one.
            let waited = false;
            while (existing !== undefined && !renewing.has(existing)) {
              const settled = existing;
              waited = true;
              await settled.then(
                () => undefined,
                () => undefined,
              );
              existing = inflight.get(key);
              // Its owner has not cleared the slot yet: it is done all the same.
              if (existing === settled) existing = undefined;
            }
            if (waited && existing === undefined) {
              // The read we waited for may have re-stored the row (a refresh
              // that rotated the refresh token). Renewing from the pre-wait
              // snapshot would present the old one, which a rotating
              // authorization server refuses as reuse: a false "sign-in
              // expired". Renew from the row as it is now.
              found = await findRow(ctx, userId, ref);
              if (found === undefined) return doResolve(ctx, userId, ref, false);
              key = mutexKey(found.scope, found.ownerId, ref);
              existing = inflight.get(key);
              if (existing !== undefined && !renewing.has(existing)) {
                // Yet another ordinary read started meanwhile: wait for it too.
                return doResolve(ctx, userId, ref, true);
              }
            }
          }
          if (existing !== undefined) return existing;
          const p = resolveFromRow(ctx, found.scope, found.ownerId, ref, userId, found.env, rejected);
          if (rejected) renewing.add(p);
          inflight.set(key, p);
          try {
            return await p;
          } finally {
            // Only our own slot: a rejected read may have taken it over.
            if (inflight.get(key) === p) inflight.delete(key);
          }
        }
        // None of the v2 scopes had it. Fall through to env fallback —
        // single-tenant / kind-dev posture.
        const fromEnv = envFallbackValue(ref);
        if (fromEnv !== undefined) return fromEnv;
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
          return doResolve(ctx, userId, ref, input.rejected === true);
        },
        { returns: CredentialsGetOutputSchema },
      );

      // Non-resolving presence check: "would credentials:get find a credential
      // for this (ctx, userId, ref)?" — answered from the SAME walk (findRow +
      // envFallbackValue), so the user -> agent -> global order, tombstone
      // skipping, the `account:` rules (no user step; TASK-697 / TASK-711
      // gates) and the env fallback can never drift from `credentials:get`.
      // What it does NOT do, by design:
      //   - call `credentials:resolve:<kind>` (so an mcp-oauth token is never
      //     refreshed and no network is touched — asking "is this connected?"
      //     must be free of side effects),
      //   - take the inflight mutex (there is no resolver call to dedupe),
      //   - call `credentials:set` (nothing is re-stored),
      //   - return or log any value, payload, kind, or scope.
      // Presence is about a row, not its usability: a row whose kind has no
      // resolver loaded is `present: true` here while `credentials:get` fails
      // closed on it. An undecryptable or malformed row throws, same as get.
      //
      // Boundary review:
      //   - Alternate impl: a vault/KMS-backed store (`@ax/credentials-kms`)
      //     answering the same presence question from its own metadata, without
      //     a decrypt round-trip.
      //   - Leaking field names: none — `{ ref, userId }` in, `{ present }` out;
      //     no scope, owner, kind, path, or backend vocabulary.
      //   - Subscriber risk: none — the output is a single boolean.
      //   - Wire surface: host-side service hook only; not an IPC action, so no
      //     sandbox can reach it.
      bus.registerService<CredentialsHasInput, CredentialsHasOutput>(
        'credentials:has',
        PLUGIN_NAME,
        async (ctx, input) => {
          const ref = validateRef(input.ref);
          const userId = validateUserId(input.userId);
          if ((await findRow(ctx, userId, ref)) !== undefined) return { present: true };
          return { present: envFallbackValue(ref) !== undefined };
        },
        { returns: CredentialsHasOutputSchema },
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
        { returns: CredentialsListOutputSchema },
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
        { returns: CredentialsListKindsOutputSchema },
      );

      bus.registerService<CredentialsResolveInput, CredentialsResolveOutput>(
        'credentials:resolve:setting',
        PLUGIN_NAME,
        async (_ctx, input) => {
          return { value: new TextDecoder().decode(input.payload) };
        },
        // Cast required: a concrete ZodObject isn't assignable to the abstract
        // `ZodType<O>` param. The drift guard near the schema definition is what
        // actually enforces schema↔interface agreement.
        { returns: CredentialsResolveOutputSchema as ZodType<CredentialsResolveOutput> },
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

      bus.registerService<CredentialsPurgeByOwnerInput, CredentialsPurgeByOwnerOutput>(
        'credentials:purge-by-owner',
        PLUGIN_NAME,
        async (ctx, input) => {
          return bus.call<CredentialsPurgeByOwnerInput, CredentialsPurgeByOwnerOutput>(
            'credentials:store-blob:purge-by-owner',
            ctx,
            input,
          );
        },
      );

      const invalidPurge = (message: string) =>
        new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, message });

      /**
       * The purge itself, for `scopes` of 'user' and/or 'agent'. INTERNAL: the
       * hook below accepts only 'agent'; 'user' is reachable only from this
       * plugin's own boot purge (purge-user-account.ts).
       */
      async function purgeAccountRows(
        ctx: AgentContext,
        input: { connectorId?: string; scopes: Array<'user' | 'agent'> },
      ): Promise<CredentialsPurgeAccountOutput> {
        if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
          throw invalidPurge('scopes must be a non-empty array');
        }
        const scopes = [...new Set(input.scopes.map((s) => validateScope(s)))];
        if (scopes.includes('global')) {
          throw invalidPurge("scopes may only contain 'user' | 'agent'");
        }
        let prefix: string | undefined;
        if (input.connectorId !== undefined) {
          if (typeof input.connectorId !== 'string' || !PURGE_CONNECTOR_ID_RE.test(input.connectorId)) {
            throw invalidPurge('connectorId is not a valid connector id');
          }
          prefix = `${GUARDED_ACCOUNT_REF_PREFIX}${input.connectorId}`;
        }
        const matches = (ref: string): boolean =>
          prefix === undefined
            ? ref.startsWith(GUARDED_ACCOUNT_REF_PREFIX)
            : ref === prefix || ref.startsWith(`${prefix}:`);
        let purged = 0;
        for (const scope of scopes) {
          const out = await bus.call<
            { scope: CredentialScope },
            { entries: Array<{ scope: CredentialScope; ownerId: string | null; ref: string; blob: Uint8Array }> }
          >('credentials:store-blob:list', ctx, { scope });
          for (const e of out.entries) {
            if (!matches(e.ref)) continue;
            let live = true;
            try {
              live = !unwrapEnvelope(e.blob).isTombstone;
            } catch (err) {
              // Undecryptable or malformed envelope (key-rotation aftermath,
              // a truncated blob): still ours to purge. Anything else — a
              // store returning a broken entry, a key error — is a real
              // fault, so fail loudly rather than tombstone blind.
              if (!(err instanceof PluginError) || !UNREADABLE_BLOB_CODES.has(err.code)) throw err;
            }
            if (!live) continue;
            await bus.call('credentials:store-blob:put', ctx, {
              scope: e.scope,
              ownerId: e.ownerId,
              ref: e.ref,
              blob: encryptWithKey(key, ''),
            });
            purged++;
          }
        }
        return { purged };
      }

      // SIGNINS-7 — the hook purges agent scope only. Checked before any
      // read, so a 'user' or 'global' request touches nothing.
      bus.registerService<CredentialsPurgeAccountInput, CredentialsPurgeAccountOutput>(
        'credentials:purge-account',
        PLUGIN_NAME,
        async (ctx, input) => {
          const scopes: unknown = (input as { scopes?: unknown } | null)?.scopes;
          if (!Array.isArray(scopes) || scopes.length === 0) {
            throw invalidPurge('scopes must be a non-empty array');
          }
          if (!scopes.every((s) => s === 'agent')) {
            throw invalidPurge("scopes may only contain 'agent'");
          }
          return purgeAccountRows(ctx, {
            ...(input.connectorId !== undefined ? { connectorId: input.connectorId } : {}),
            scopes: ['agent'],
          });
        },
      );

      // One-shot wipe of pre-redesign credential rows. Runs on every boot but
      // is a no-op after the first time (guarded by a storage marker key).
      // Must run AFTER all bus.registerService calls so that storage:* calls
      // inside wipePreRedesignCredentials resolve correctly.
      //
      // Gated on storage:get being available — test harnesses that only stub
      // credentials:store-blob:* don't wire storage:* and have nothing to wipe.
      if (bus.hasService('storage:get')) {
        const wipeCtx = makeAgentContext({
          sessionId: 'credentials-wipe',
          agentId: PLUGIN_NAME,
          userId: 'system',
        });
        await wipePreRedesignCredentials(bus, wipeCtx);
      }

      // One-shot purge of person-level connector credentials (agent-owned
      // sign-ins, slice 5): every user-scope `account:` row. Marker-guarded
      // like the wipe above; it skips when storage:get/set are absent, and a
      // failure only warns (no marker, retried next boot) — it never fails
      // the boot. Calls purge-account's own function, not the bus.
      await purgeUserAccountCredentials(
        bus,
        makeAgentContext({
          sessionId: 'credentials-user-account-purge',
          agentId: PLUGIN_NAME,
          userId: 'system',
        }),
        (purgeCtx) => purgeAccountRows(purgeCtx, { scopes: ['user'] }),
      );
    },
  };
}
