/**
 * The freshness predicate for `request_capability` (AW-7, design §3.4).
 *
 * WHY THIS TOOL. It is one of exactly three calls the AW-3 rule table HOLDS,
 * and it is the cheap-and-obvious half of AW-7's pair: the thing worth
 * re-reading is a single catalog entry, one bus call, no fan-out. That makes it
 * the producer that PROVES THE GUARD FIRES — the predicate moves for an obvious
 * reason (an admin edited the catalog, or pulled the skill out of it) and the
 * decision visibly re-opens instead of executing.
 *
 * WHAT IT GUARDS AGAINST. `request_capability` is replayed host-side on
 * approval, byte for byte. A human is asked at 7am whether the agent may
 * connect the `linear` capability; by 1pm the catalog's `linear` entry may
 * reference a different set of connectors — a different set of hosts and keys —
 * than the one they were asked about. Replaying then puts a permission card in
 * front of them for reach they never agreed to consider. Nothing is granted
 * without that second card, so this is not the last line of defence; it is the
 * line that stops the question being silently swapped between the asking and
 * the answering.
 *
 * WHAT IT DOES NOT GUARD. The digest covers the CATALOG ENTRY — its description
 * and the connector ids it references. It does not follow those ids into
 * `connectors:resolve` and digest each connector's own hosts, slots and
 * packages. A connector's reach changing under a stable id therefore does not
 * trip this guard. That is a deliberate cost of keeping this producer to one
 * bus call, it is recorded in the PR, and it is a follow-up rather than a
 * silent gap.
 *
 * THE TOKEN IS SELF-DESCRIBING, and it has to be: `tool-freshness:check:<tool>`
 * is handed the predicate and NOTHING ELSE — no call, no input — so the value
 * carries the `<skillId>@<digest>` it needs to re-read itself. `value` is opaque
 * to the host and to every renderer; the tool that wrote it is the only thing
 * that parses it, which is exactly what `FreshnessPredicate` promises.
 */
import { createHash } from 'node:crypto';
import { PluginError, type AgentContext, type HookBus } from '@ax/core';

const PLUGIN_NAME = '@ax/skill-broker';

/**
 * Structural mirror of `@ax/decisions`' `FreshnessPredicate` — re-declared
 * rather than imported, because plugins talk through the hook bus and never
 * through each other's modules (invariant 2).
 *
 * `label` is nullable on the far side (a stale row drops its "checked
 * against…" clause). This producer always writes one; the null case is the
 * guard's own doing, not a shape this file has to produce.
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
 * Re-validated independently at this trust boundary (I2/I5) — the same grammar
 * `request-capability.ts` applies to the model's `skillId` before it trusts it.
 * Applied HERE too, on the way OUT of a stored predicate: the token came from
 * our own durable row, but re-checking a value at the boundary that consumes it
 * is cheaper than proving nothing ever writes a bad one.
 */
const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** The predicate `kind` this producer owns. Opaque token, never parsed by the UI. */
export const CATALOG_SKILL_KIND = 'catalog-skill';

export const CAPABILITY_CAPTURE_HOOK = 'tool-freshness:capture:request_capability';
export const CAPABILITY_CHECK_HOOK = 'tool-freshness:check:request_capability';

/**
 * What we record for a skill the catalog does not have.
 *
 * "Absent" is a first-class state, not an error: a skill that was in the
 * catalog at hold-time and is gone by approval-time is precisely the world
 * having moved, and the guard has to be able to SAY so rather than fail.
 */
const ABSENT = 'absent';

/** Mirrors the subset of `@ax/skills`' `SkillDetail` this file reads (invariant 2). */
interface CatalogSkillDetail {
  id: string;
  description: string;
  connectors?: string[];
}

/**
 * The catalog entry, reduced to a token.
 *
 * Sorted before hashing so a reordered `connectors` list is not mistaken for a
 * changed one — the guard's job is to catch a world that MOVED, and a false
 * positive costs a human a second look for nothing.
 *
 * Throws for anything other than a clean "not in the catalog". A caller that
 * cannot read the catalog must not quietly report "unchanged": on the capture
 * side `@ax/decisions` logs it and writes no predicate (the row then claims no
 * guard), and on the check side it counts as changed. Both are honest; silently
 * matching would not be.
 */
async function catalogToken(
  bus: HookBus,
  ctx: AgentContext,
  skillId: string,
): Promise<string> {
  let detail: CatalogSkillDetail;
  try {
    detail = await bus.call<{ skillId: string; scope: 'global' }, CatalogSkillDetail>(
      'skills:get',
      ctx,
      { skillId, scope: 'global' },
    );
  } catch (err) {
    if (err instanceof PluginError && err.code === 'skill-not-found') {
      return `${skillId}@${ABSENT}`;
    }
    throw err;
  }

  const shape = JSON.stringify({
    description: typeof detail.description === 'string' ? detail.description : '',
    connectors: [...new Set(detail.connectors ?? [])].sort(),
  });
  // 16 hex characters. This is a change DETECTOR, not a security primitive —
  // nothing authenticates on it and nothing is authorised by it — and a short
  // token keeps a durable row small.
  const digest = createHash('sha256').update(shape).digest('hex').slice(0, 16);
  return `${skillId}@${digest}`;
}

/** `<skillId>@<digest>` → `skillId`, or null if the token is not one of ours. */
function skillIdFromToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const at = value.lastIndexOf('@');
  if (at <= 0) return null;
  const skillId = value.slice(0, at);
  return SKILL_ID_RE.test(skillId) ? skillId : null;
}

function isAbsent(token: string): boolean {
  return token.endsWith(`@${ABSENT}`);
}

/**
 * The sentence a human reads on the re-opened row. HOST-AUTHORED, one per
 * transition, and never derived from another one by string surgery (design H1).
 *
 * `skillId` is the only variable, and it passed `SKILL_ID_RE` before it got
 * here — lowercase letters, digits, `.`, `_`, `-`. `@ax/decisions` fences this
 * string again on the way in, which is belt to this braces.
 */
function changedSentence(before: string, after: string, skillId: string): string {
  if (isAbsent(after)) {
    return `"${skillId}" is no longer in the capability catalog, so there is nothing left to connect.`;
  }
  if (isAbsent(before)) {
    return `"${skillId}" has been added to the capability catalog since this was drafted.`;
  }
  return `The "${skillId}" capability now asks for something different than it did when this was drafted.`;
}

/**
 * Register the pair.
 *
 * BOTH HALVES OR NEITHER. `@ax/decisions` audits the bus at boot and logs a
 * `check` with no matching `capture` — that combination guards nothing and says
 * nothing, which is the worst outcome available. Registering them side by side
 * in one function is the cheap structural version of the same guarantee.
 */
export function registerCapabilityFreshness(bus: HookBus): void {
  bus.registerService<CaptureInput, { predicate: FreshnessPredicate | null }>(
    CAPABILITY_CAPTURE_HOOK,
    PLUGIN_NAME,
    async (ctx, input) => {
      const raw = (input?.call?.input ?? {}) as { skillId?: unknown };
      const skillId = typeof raw.skillId === 'string' ? raw.skillId.trim() : '';
      // A call whose `skillId` is missing or malformed is one the executor will
      // reject outright. There is nothing to re-read and nothing worth
      // guarding, so the decision is unguarded rather than guarded against a
      // value we refused to trust.
      if (!SKILL_ID_RE.test(skillId)) return { predicate: null };

      return {
        predicate: {
          kind: CATALOG_SKILL_KIND,
          value: await catalogToken(bus, ctx, skillId),
          // The only part a human reads. It completes the row's sentence:
          // "checked against: <label>".
          label: `the "${skillId}" entry in the capability catalog`,
        },
      };
    },
    // Inside `tool.pre-call`'s 10 s IPC ceiling, which this shares with a
    // policy call, an attendance read and a row write. The bus's own default
    // is 120 s, and a caller cannot cap a service it did not register — so
    // the bound has to be declared here. @ax/decisions ALSO budgets the call
    // on its side, for producers nobody in this repo wrote.
    { timeoutMs: 3_000 },
  );

  bus.registerService<CheckInput, { value: string; changed?: string }>(
    CAPABILITY_CHECK_HOOK,
    PLUGIN_NAME,
    async (ctx, input) => {
      const before = input?.predicate?.value;
      const skillId = skillIdFromToken(before);
      if (skillId === null || typeof before !== 'string') {
        // We were handed a token this producer did not write, or one we can no
        // longer read. THROW rather than answer: `@ax/decisions` turns a
        // throwing check into "changed", which re-opens the decision and runs
        // nothing. Returning a made-up value would be the one wrong move here —
        // it would either execute on a world we never looked at, or stale on
        // one that never moved.
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          hookName: CAPABILITY_CHECK_HOOK,
          message: 'freshness predicate is not a request_capability token',
        });
      }

      const after = await catalogToken(bus, ctx, skillId);
      return after === before
        ? { value: after }
        : { value: after, changed: changedSentence(before, after, skillId) };
    },
    // The approval request's only deadline is a human watching a button, so
    // this gets more room than capture — but still a bound, because a check
    // that never returns leaves the decision unresolvable rather than stale.
    { timeoutMs: 10_000 },
  );
}
