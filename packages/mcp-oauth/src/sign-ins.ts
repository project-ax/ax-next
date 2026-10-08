import type { AgentContext, HookBus, Logger } from '@ax/core';
import { sanitizeAccount } from './identity.js';

// ---------------------------------------------------------------------------
// Slice 4 — "Signed in as". Which account each of an agent's connectors is
// signed in as, for `mcp-oauth:status-batch`'s `signIns`.
//
// The callback stores the identity as ENVELOPE METADATA on the agent-scope
// `account:<connectorId>` row (`{account, signedInBy, signedInAt}`), and
// `credentials:list` hands metadata back without decrypting a payload — so
// this never resolves, refreshes or even reads a token.
//
// Everything read here is display-only and treated as untrusted: the account
// is re-sanitized on the way out (a row written by an older build, or by
// anything else that can call `credentials:set`, gets the same treatment as a
// fresh one), and no value is ever logged.
// ---------------------------------------------------------------------------

/** One connector's sign-in identity. `null` = not recorded (or not usable). */
export interface SignInIdentity {
  account: string | null;
  signedInBy: string | null;
  signedInAt: string | null;
}

/** Structural mirror of @ax/credentials' `credentials:list` (no import — invariant 2). */
interface CredentialsListInput {
  scope: 'agent';
  ownerId: string;
}
interface CredentialsListOutputLike {
  credentials?: unknown;
}

/** The vault kind the callback stores a sign-in under. A per-agent KEY is not a sign-in. */
const SIGN_IN_KIND = 'mcp-oauth';
const ACCOUNT_PREFIX = 'account:';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export interface ReadAgentSignInsOptions {
  bus: HookBus;
  ctx: AgentContext;
  logger: Logger;
  agentId: string;
  connectorIds: readonly string[];
}

/**
 * The sign-in identity for each requested connector that has an agent-scope
 * sign-in row on `agentId`, keyed by connector id. A row with no metadata (a
 * sign-in from before slice 4) is keyed with every field `null`: the row
 * exists, there is just nothing recorded about it.
 *
 * Only a ref that is EXACTLY `account:<connectorId>` counts — a key slot is
 * `account:<connectorId>:<slot>` — and only on a row of the sign-in kind.
 *
 * Fail-soft: no `credentials:list`, a throw or a malformed reply → `{}`. A
 * throw is logged once, by error NAME only (a message could carry a value).
 */
export async function readAgentSignIns(
  opts: ReadAgentSignInsOptions,
): Promise<Record<string, SignInIdentity>> {
  const { bus, ctx, logger, agentId, connectorIds } = opts;
  if (connectorIds.length === 0 || !bus.hasService('credentials:list')) return {};
  let reply: unknown;
  try {
    reply = await bus.call<CredentialsListInput, CredentialsListOutputLike>(
      'credentials:list',
      ctx,
      { scope: 'agent', ownerId: agentId },
    );
  } catch (err) {
    logger.warn('mcp_oauth_sign_in_identity_read_failed', {
      agentId,
      name: err instanceof Error ? err.name : 'unknown',
    });
    return {};
  }
  const rows = isPlainObject(reply) && Array.isArray(reply.credentials) ? reply.credentials : [];
  const wanted = new Set(connectorIds);
  const out = new Map<string, SignInIdentity>();
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    // The list was asked for this agent's rows only; check anyway, so a
    // vault that over-answers can never show one agent another's account.
    if (row.scope !== 'agent' || row.ownerId !== agentId) continue;
    if (row.kind !== SIGN_IN_KIND) continue;
    if (typeof row.ref !== 'string' || !row.ref.startsWith(ACCOUNT_PREFIX)) continue;
    const connectorId = row.ref.slice(ACCOUNT_PREFIX.length);
    // A key slot is `account:<id>:<slot>`: never a sign-in, whatever was asked.
    if (connectorId.includes(':') || !wanted.has(connectorId)) continue;
    const meta = isPlainObject(row.metadata) ? row.metadata : {};
    out.set(connectorId, {
      account: sanitizeAccount(meta.account),
      signedInBy: stringOrNull(meta.signedInBy),
      signedInAt: stringOrNull(meta.signedInAt),
    });
  }
  // fromEntries defines own properties, so an id like `__proto__` stays a key.
  return Object.fromEntries(out);
}
