/**
 * The freshness predicate for `request_capability` (AW-7, design §3.4).
 *
 * WHY THIS TOOL. It is one of exactly three calls the AW-3 rule table HOLDS,
 * and it is the obvious half of AW-7's pair: the thing worth re-reading is one
 * catalog entry and the connectors it names. That makes it the producer that
 * PROVES THE GUARD FIRES — the predicate moves for a reason a human can
 * narrate (an admin edited the catalog, pulled the skill out of it, or
 * re-pointed one of its connectors) and the decision visibly re-opens instead
 * of executing.
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
 * WHAT THE DIGEST COVERS (TASK-262). The catalog entry — its description and
 * the connector ids it references — AND, where `connectors:resolve` is on the
 * bus, what each of those ids actually resolves to for this owner: hosts, key
 * slot NAMES, npm/pypi packages, MCP servers and dev services. The ids are
 * stable; what they REACH is not, so digesting the entry alone let a connector
 * move under a stable id without the guard noticing. That was TASK-262, and
 * this is its fix.
 *
 * WHAT IT STILL DOES NOT GUARD, and why that is fine. This is not the reach
 * gate and was never meant to be. The gate is the executor's own permission
 * card (`request-capability.ts`), which a human clicks and which is built from
 * a LIVE `connectors:resolve` fan-out at replay time — so reach that moved is
 * re-gated there whatever this predicate concluded. What this guard buys is
 * CONSENT CLARITY: the 1pm human is not quietly asked about a different
 * question than the 7am human was. A miss here costs a re-asked question, not
 * unauthorized reach.
 *
 * A connector-less preset (no `connectors:resolve`) keeps the catalog-only
 * digest. The gate is on the reach FOLD, never on the predicate: without the
 * hook there is still a catalog entry worth guarding, and blanking the
 * predicate would delete a working guard rather than narrow it.
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

/**
 * Connector id grammar — the SAME coarse grammar the executor applies before it
 * hands a skill-declared id to `connectors:resolve`
 * (`request-capability.ts`'s `CONNECTOR_ID_RE`). Re-validated here so the
 * predicate never folds reach the approval card could not have shown, and never
 * hands a malformed id to the registry.
 */
const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** The hook the reach fold reads. OPTIONAL — declared in the manifest as such. */
const CONNECTORS_RESOLVE_HOOK = 'connectors:resolve';

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
 * Structural mirror of the subset of `@ax/connectors`' `ResolveOutput` this file
 * digests (invariant 2 — no cross-plugin import).
 *
 * Everything here GRANTS REACH, and that is the whole membership rule: if
 * `connectors:resolve` returns it and it widens what the agent can touch, it is
 * digested. `usageNote` and the derived `credentialPlan` are excluded — a
 * reworded blurb is not a changed world, and the plan is a function of what is
 * already here. (The sibling producer in `@ax/tool-connector-propose` omits
 * `mcpServers` and `services` even though resolve returns them; that is a blind
 * spot, not a precedent, and TASK-262 deliberately does not inherit it.)
 *
 * Every field is optional because this is a WIRE shape from another plugin: a
 * resolve that predates a field, or a test stub that omits one, must degrade to
 * "nothing declared" rather than throw inside a guard.
 *
 * ONE UPSTREAM DEPENDENCY WORTH NAMING (the TASK-251 trap). `connectors:resolve`
 * is registered with a `returns:` schema, and `HookBus.call` returns
 * `safeParse(...).data` — zod STRIPS undeclared keys. So a field this file
 * digests only reaches it while `@ax/connectors`' `CapabilitiesSchema` still
 * declares it. Narrowing that schema would silently shrink this digest with no
 * tsc error here, because the read lands on an optional field of a local mirror.
 * Today every field below is declared there, and `mcpServers` / `services` are
 * always present on a real resolve (`services` via `.default([])`).
 */
interface ConnectorSlot {
  slot?: string;
}
interface ConnectorMcpServer {
  name?: string;
  transport?: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  allowedHosts?: string[];
  credentials?: ConnectorSlot[];
}
interface ConnectorService {
  name?: string;
  image?: string;
  ports?: number[];
  env?: Record<string, string>;
  writablePaths?: string[];
}
interface ConnectorsResolveOutput {
  id?: string;
  keyMode?: string;
  capabilities?: {
    allowedHosts?: string[];
    credentials?: ConnectorSlot[];
    mcpServers?: ConnectorMcpServer[];
    packages?: { npm?: string[]; pypi?: string[] };
    services?: ConnectorService[];
  };
}

/**
 * Set-like normalisation: dedupe + sort, so a merely REORDERED list is not
 * mistaken for a changed one. A false positive costs a human a second look for
 * nothing, and every list normalised this way is a set in the domain.
 */
function asSet(values: readonly (string | undefined)[] | undefined): string[] {
  return [...new Set((values ?? []).filter((v): v is string => typeof v === 'string'))].sort();
}

/** Stable, locale-independent ordering — `localeCompare` is not deterministic across ICU builds. */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `env` reduced to sorted key/value pairs. Values are IN, because an env value
 * is how an MCP server or a dev service gets re-pointed somewhere else — that
 * is a reach change even when every host string stays put. Only the sha256 of
 * this shape is ever persisted or logged; the string itself never leaves this
 * function's caller.
 */
function envPairs(env: Record<string, string> | undefined): [string, string][] {
  return Object.entries(env ?? {}).sort(([a], [b]) => byString(a, b));
}

/**
 * One connector's resolved reach, reduced to a stable shape.
 *
 * Note the one array whose ORDER is preserved: `args`. `['--allow', 'x']` and
 * `['x', '--allow']` are different commands, so sorting them would collapse two
 * genuinely different worlds into one digest.
 */
function reachShape(resolved: ConnectorsResolveOutput): unknown {
  const caps = resolved.capabilities ?? {};
  return {
    keyMode: typeof resolved.keyMode === 'string' ? resolved.keyMode : '',
    hosts: asSet(caps.allowedHosts),
    // Slot NAMES only. A credential's VALUE never crosses this boundary and is
    // not something this file could read even if it wanted to — the predicate
    // is about reach, not about secrets.
    slots: asSet((caps.credentials ?? []).map((c) => c.slot)),
    npm: asSet(caps.packages?.npm),
    pypi: asSet(caps.packages?.pypi),
    mcp: (caps.mcpServers ?? [])
      .map((s) => ({
        name: s.name ?? '',
        transport: s.transport ?? '',
        command: s.command ?? '',
        args: [...(s.args ?? [])],
        url: s.url ?? '',
        env: envPairs(s.env),
        hosts: asSet(s.allowedHosts),
        slots: asSet((s.credentials ?? []).map((c) => c.slot)),
      }))
      .sort((a, b) => byString(a.name, b.name)),
    services: (caps.services ?? [])
      .map((s) => ({
        name: s.name ?? '',
        // The image is digest-pinned upstream, so it stands in for the whole
        // container's contents.
        image: s.image ?? '',
        ports: [...(s.ports ?? [])].sort((a, b) => a - b),
        env: envPairs(s.env),
        writablePaths: asSet(s.writablePaths),
      }))
      .sort((a, b) => byString(a.name, b.name)),
  };
}

/**
 * What each of the entry's connector ids resolves to for this owner.
 *
 * PARALLEL, deliberately. Capture runs inside `tool.pre-call`'s 10 s IPC
 * ceiling on a 3 s budget (`@ax/decisions`' `CAPTURE_BUDGET_MS`), and the two
 * sides of this guard fail in OPPOSITE directions when that budget blows:
 * capture fails OPEN (the row is written with no predicate and claims no
 * guard), check fails CLOSED (a spurious "changed"). A serial fan-out over N
 * connectors is how a two-connector skill turns into an unguarded row, so the
 * fold costs one round trip regardless of N and the declared `timeoutMs` stays
 * where it is.
 *
 * THROWS where the executor SWALLOWS, and that difference is the point. The
 * executor must still show a card, so it drops a connector it could not resolve
 * (`request-capability.ts`'s per-connector catch). A freshness producer that did
 * the same would report "unchanged" for a world it failed to read — a transient
 * blip would silently authorise a replay. Only a clean `not-found` is an answer;
 * everything else propagates, and `@ax/decisions` fails open on capture / closed
 * on check with an honest log either way.
 */
async function resolvedReach(
  bus: HookBus,
  ctx: AgentContext,
  connectorIds: readonly string[],
): Promise<unknown[]> {
  // Same filter the executor applies, so the predicate is not guarded against
  // reach the card would never have resolved. Input order is already sorted +
  // deduped by the caller, and `Promise.all` preserves it, so the fold is
  // deterministic.
  const ids = connectorIds.filter((id) => CONNECTOR_ID_RE.test(id));
  return Promise.all(
    ids.map(async (connectorId) => {
      try {
        const resolved = await bus.call<
          { userId: string; connectorId: string },
          ConnectorsResolveOutput
        >(CONNECTORS_RESOLVE_HOOK, ctx, { userId: ctx.userId, connectorId });
        return { id: connectorId, reach: reachShape(resolved) };
      } catch (err) {
        if (err instanceof PluginError && err.code === 'not-found') {
          // A catalog entry may name a connector nobody has installed yet.
          // First-class state, not a failure — and it ARRIVING is the world
          // moving in the direction a human most needs to hear about.
          return { id: connectorId, reach: ABSENT };
        }
        throw err;
      }
    }),
  );
}

/**
 * The catalog entry — plus what its connectors resolve to — reduced to a token.
 *
 * Every set-like list is sorted before hashing so a reordered one is not
 * mistaken for a changed one: the guard's job is to catch a world that MOVED,
 * and a false positive costs a human a second look for nothing.
 *
 * Throws for anything other than a clean "not in the catalog" (or a clean
 * "connector not installed", which the fold records as `absent`). A caller that
 * cannot read the world must not quietly report "unchanged": on the capture side
 * `@ax/decisions` logs it and writes no predicate (the row then claims no
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

  const description = typeof detail.description === 'string' ? detail.description : '';
  const connectors = asSet(detail.connectors);

  // THE GATE IS ON THE FOLD, NOT ON THE PREDICATE. Without
  // `connectors:resolve` there is no reach to read — but there is still a
  // catalog entry, and guarding it is exactly what this producer did before
  // TASK-262. So a connector-less preset keeps the pre-TASK-262 shape BYTE FOR
  // BYTE (no reach key at all, not an empty one): the guard there is unchanged
  // and no in-flight row is staled. The sibling producer in
  // `@ax/tool-connector-propose` returns `{ predicate: null }` in this
  // situation because the registry is the ONLY world it reads; copying that
  // here would delete a working guard instead of narrowing it.
  //
  // The hook set does not change after boot, so capture and check always agree
  // on which branch they are in — the shapes can never cross mid-decision.
  //
  // The owner comes from the trusted ctx, NEVER from the model input — the same
  // posture the executor takes, and the reason capture (`ctx.userId`) and check
  // (`replayContext`'s `decision.ownerUserId`) read the same user's registry.
  const shape = JSON.stringify(
    bus.hasService(CONNECTORS_RESOLVE_HOOK)
      ? { description, connectors, reach: await resolvedReach(bus, ctx, connectors) }
      : { description, connectors },
  );
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
