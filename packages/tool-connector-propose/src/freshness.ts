/**
 * The freshness predicate for `connector_propose` (AW-7, design §3.4).
 *
 * WHY THIS TOOL — and the honest caveat first. AW-7 asks for one producer where
 * the guard MATTERS: a call that spends money or sends something outward.
 * NOTHING IN THE CURRENT CATALOG DOES EITHER. The AW-3 rule table holds exactly
 * three calls — `request_capability`, `connector_propose` and `skill_propose` —
 * and none of them mails anyone or bills anyone. Rather than invent a tool to
 * justify the mechanism, this is the closest available, and here is why it is
 * the closest:
 *
 * A connector IS the outward-reach object. It carries the hosts the agent may
 * talk to and the slot the user's API key lands in. `connector_propose` is
 * host-executed, so an approval REPLAYS it verbatim hours later, and
 * `connectors:install-authored` writes the recorded draft into the owner's
 * namespace under the id the model chose. If a human set up a connection under
 * that same id in the meantime — approved a different draft, or configured one
 * by hand in Settings — replaying the older draft writes over a live,
 * human-approved connection with the agent's stale idea of it. That is a lost
 * update on the object that governs reach, and it is the failure mode this
 * guard exists to stop.
 *
 * WHAT THE PREDICATE IS. `connectors:resolve` reads ONLY the live,
 * human-approved registry — a pending authored draft is deliberately invisible
 * to it (zero reach until a human says yes). So the predicate is exactly "what
 * does this id resolve to for this owner right now": `absent`, or a digest of
 * the reach it carries. One bus call, no fan-out, and it answers the only
 * question that matters at approval time.
 *
 * THE TOKEN IS SELF-DESCRIBING, and it has to be: `tool-freshness:check:<tool>`
 * is handed the predicate and NOTHING ELSE, so the value carries the
 * `<connectorId>@<digest>` it needs to re-read itself. `value` is opaque to the
 * host and to every renderer; this file is the only thing that parses one.
 */
import { createHash } from 'node:crypto';
import { PluginError, type AgentContext, type HookBus } from '@ax/core';
import { CONNECTOR_PROPOSE_TOOL_NAME } from './descriptor.js';

const PLUGIN_NAME = '@ax/tool-connector-propose';

export const CONNECTOR_CAPTURE_HOOK =
  `tool-freshness:capture:${CONNECTOR_PROPOSE_TOOL_NAME}` as const;
export const CONNECTOR_CHECK_HOOK =
  `tool-freshness:check:${CONNECTOR_PROPOSE_TOOL_NAME}` as const;

/** The hook this producer reads the world through. Optional — see the manifest. */
export const CONNECTORS_RESOLVE_HOOK = 'connectors:resolve';

/** The predicate `kind` this producer owns. Opaque token, never parsed by the UI. */
export const CONNECTOR_REGISTRY_KIND = 'connector-registry';

/**
 * Structural mirror of `@ax/decisions`' `FreshnessPredicate` — re-declared
 * rather than imported (invariant 2). `label` is nullable on the far side
 * because a stale row drops its "checked against…" clause; this producer always
 * writes one.
 */
interface FreshnessPredicate {
  kind: string;
  value: string;
  label: string | null;
}

interface CaptureInput {
  call?: { name?: string; input?: unknown } | undefined;
}

interface CheckInput {
  predicate?: FreshnessPredicate | undefined;
}

/**
 * Structural mirror of the subset of `@ax/connectors`' `ResolveOutput` this
 * file digests (invariant 2 — no cross-plugin import). Deliberately narrow:
 * `usageNote` and the derived `credentialPlan` are excluded, because a reworded
 * blurb is not a changed world and the plan is a function of what IS here.
 */
interface ConnectorsResolveOutput {
  id: string;
  keyMode: string;
  capabilities: {
    allowedHosts?: string[];
    credentials?: { slot: string }[];
    packages?: { npm?: string[]; pypi?: string[] };
  };
}

/**
 * Re-validated independently at this trust boundary (I2/I5) — the same coarse
 * grammar `plugin.ts` applies to the model's `connectorId`. Applied HERE too,
 * on the way OUT of a stored predicate: the token came from our own durable
 * row, but re-checking at the boundary that consumes it is cheaper than proving
 * nothing ever writes a bad one.
 */
const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/**
 * What we record for an id nothing live occupies.
 *
 * "Absent" is the NORMAL state for a fresh proposal, and it is a first-class
 * value rather than an error: the whole point of the guard is that `absent`
 * turning into "something is there now" is the world moving.
 */
const ABSENT = 'absent';

/**
 * What the id resolves to for this owner, reduced to a token.
 *
 * Sorted before hashing so a reordered host list is not mistaken for a changed
 * one — a false positive costs a human a second look for nothing.
 *
 * Throws for anything other than a clean `not-found`. A caller that cannot read
 * the registry must not report "unchanged": on the capture side
 * `@ax/decisions` logs it and writes no predicate, and on the check side it
 * counts as changed. Both are honest; silently matching would not be.
 */
async function registryToken(
  bus: HookBus,
  ctx: AgentContext,
  connectorId: string,
  userId: string,
): Promise<string> {
  let resolved: ConnectorsResolveOutput;
  try {
    resolved = await bus.call<
      { userId: string; connectorId: string },
      ConnectorsResolveOutput
    >(CONNECTORS_RESOLVE_HOOK, ctx, { userId, connectorId });
  } catch (err) {
    if (err instanceof PluginError && err.code === 'not-found') {
      return `${connectorId}@${ABSENT}`;
    }
    throw err;
  }

  const caps = resolved.capabilities ?? {};
  const shape = JSON.stringify({
    keyMode: resolved.keyMode,
    hosts: [...new Set(caps.allowedHosts ?? [])].sort(),
    // Slot NAMES only. A credential's VALUE never crosses this boundary and is
    // not something this file could read even if it wanted to — the predicate
    // is about reach, not about secrets.
    slots: [...new Set((caps.credentials ?? []).map((c) => c.slot))].sort(),
    npm: [...new Set(caps.packages?.npm ?? [])].sort(),
    pypi: [...new Set(caps.packages?.pypi ?? [])].sort(),
  });
  // 16 hex characters. A change DETECTOR, not a security primitive — nothing
  // authenticates on it and nothing is authorised by it — and a short token
  // keeps a durable row small.
  const digest = createHash('sha256').update(shape).digest('hex').slice(0, 16);
  return `${connectorId}@${digest}`;
}

/** `<connectorId>@<digest>` → `connectorId`, or null if the token is not ours. */
function connectorIdFromToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const at = value.lastIndexOf('@');
  if (at <= 0) return null;
  const connectorId = value.slice(0, at);
  return CONNECTOR_ID_RE.test(connectorId) ? connectorId : null;
}

function isAbsent(token: string): boolean {
  return token.endsWith(`@${ABSENT}`);
}

/**
 * The sentence a human reads on the re-opened row. HOST-AUTHORED, one per
 * transition, never derived from another by string surgery (design H1).
 *
 * `connectorId` passed `CONNECTOR_ID_RE` before it got here — lowercase
 * letters, digits, `_`, `-`. `@ax/decisions` fences this string again on the
 * way in, which is belt to this braces.
 */
function changedSentence(before: string, after: string, connectorId: string): string {
  if (isAbsent(before)) {
    return `A connection called "${connectorId}" already exists now — it was set up after this was drafted, and approving this would replace it.`;
  }
  if (isAbsent(after)) {
    return `The "${connectorId}" connection was removed after this was drafted.`;
  }
  return `The "${connectorId}" connection changed after this was drafted — it reaches somewhere different now.`;
}

/**
 * Register the pair.
 *
 * BOTH HALVES OR NEITHER. `@ax/decisions` audits the bus and logs a `check`
 * with no matching `capture` — that combination guards nothing and says
 * nothing. Registering them side by side in one function is the cheap
 * structural version of the same guarantee.
 *
 * `connectors:resolve` is OPTIONAL: without it there is no world to read, so
 * capture answers `null` and the decision is unguarded rather than guarded
 * against a value we invented. The manifest records that degradation.
 */
export function registerConnectorFreshness(bus: HookBus): void {
  bus.registerService<CaptureInput, { predicate: FreshnessPredicate | null }>(
    CONNECTOR_CAPTURE_HOOK,
    PLUGIN_NAME,
    async (ctx, input) => {
      if (!bus.hasService(CONNECTORS_RESOLVE_HOOK)) return { predicate: null };

      const raw = (input?.call?.input ?? {}) as { connectorId?: unknown };
      const connectorId = typeof raw.connectorId === 'string' ? raw.connectorId.trim() : '';
      // A draft whose id is missing or malformed is one the executor will
      // reject outright. Nothing to re-read, nothing worth guarding.
      if (!CONNECTOR_ID_RE.test(connectorId)) return { predicate: null };

      // The owner comes from the trusted tool ctx, NEVER from the model input —
      // the same posture the executor takes. A predicate read against a foreign
      // namespace would answer confidently about somebody else's world.
      return {
        predicate: {
          kind: CONNECTOR_REGISTRY_KIND,
          value: await registryToken(bus, ctx, connectorId, ctx.userId),
          // The only part a human reads. It completes the row's sentence:
          // "checked against: <label>".
          label: `the "${connectorId}" connection in your workspace`,
        },
      };
    },
  );

  bus.registerService<CheckInput, { value: string; changed?: string }>(
    CONNECTOR_CHECK_HOOK,
    PLUGIN_NAME,
    async (ctx, input) => {
      const before = input?.predicate?.value;
      const connectorId = connectorIdFromToken(before);
      if (connectorId === null || typeof before !== 'string') {
        // A token this producer did not write, or one we can no longer read.
        // THROW rather than answer: `@ax/decisions` turns a throwing check into
        // "changed", which re-opens the decision and runs nothing. Returning a
        // made-up value would either execute on a world we never looked at or
        // stale on one that never moved.
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          hookName: CONNECTOR_CHECK_HOOK,
          message: 'freshness predicate is not a connector_propose token',
        });
      }

      const after = await registryToken(bus, ctx, connectorId, ctx.userId);
      return after === before
        ? { value: after }
        : { value: after, changed: changedSentence(before, after, connectorId) };
    },
  );
}
