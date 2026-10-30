import { PluginError, type AgentContext, type HookBus } from '@ax/core';

// ---------------------------------------------------------------------------
// TASK-989 — channel-web's one door to an agent's identity, soul and
// Instructions.
//
// They are rows owned by `@ax/agents`, read with `agents:identity:get` and
// written with `agents:identity:set`, which scans every section it saves
// (`identity:scan`, fail closed) and compare-and-sets on a `revision`. The
// admin identity editor and the settings page's Instructions both go through
// here, so the two cannot grow different ideas of how a save works.
//
// A save is a server-side read-then-write: read the current `revision`, hand
// it back as `expectedRevision`, and on a `conflict` (someone else — often the
// agent editing its own soul — saved in between) read again and retry, up to
// IDENTITY_WRITE_ATTEMPTS times. The retry only gets the write past the
// compare-and-set; it does not merge. A patch overwrites every section it
// names: the admin PUT always sends both `identity` and `soul`, so a Save from
// a stale form replaces a concurrent agent edit to either (as the old
// three-file write did), while the Instructions route sends only
// `instructions` and leaves the other sections alone. Last writer wins, per
// section sent. The `revision` never reaches the browser.
//
// The payload shapes are declared here, not imported (Invariant 2 — the hook
// bus is the contract). The replies crossed the bus and are checked before
// use: a reply missing a field is an error, never a blank — an empty editor
// over text we could not read is one Save away from overwriting it.
//
// Never logged here: identity, soul or Instructions text.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/channel-web';

/** Attempts a save makes before answering `conflict`. */
export const IDENTITY_WRITE_ATTEMPTS = 3;

type IdentitySection = 'identity' | 'soul' | 'instructions';
type IdentityRefusalCode = 'too-long' | 'content' | 'scan-unavailable';
const REFUSAL_CODES: readonly string[] = ['too-long', 'content', 'scan-unavailable'];

interface IdentityGetInput {
  agentId: string;
}
interface IdentitySetInput {
  agentId: string;
  patch: Partial<Record<IdentitySection, string>>;
  expectedRevision: number;
}

/** What channel-web reads of an agent's identity record. */
export interface AgentIdentityView {
  identity: string;
  soul: string;
  instructions: string;
  /** The write's compare-and-set token. Host-side only; never sent to a browser. */
  revision: number;
}

export type IdentityWriteResult =
  /** Also an `unchanged` outcome: what is stored is what was asked for. */
  | { kind: 'saved'; record: AgentIdentityView }
  /** Nothing was saved; `reason` is the store's own short sentence. */
  | { kind: 'refused'; code: IdentityRefusalCode; reason: string }
  /** Lost the compare-and-set IDENTITY_WRITE_ATTEMPTS times; nothing was saved. */
  | { kind: 'conflict' }
  /** No identity store on this deployment; nothing was saved. */
  | { kind: 'unavailable' };

function invalidReturn(hookName: string, message: string): PluginError {
  return new PluginError({ code: 'invalid-return', plugin: PLUGIN_NAME, hookName, message });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toView(hookName: string, raw: unknown): AgentIdentityView {
  if (
    !isObject(raw) ||
    typeof raw.identity !== 'string' ||
    typeof raw.soul !== 'string' ||
    typeof raw.instructions !== 'string' ||
    typeof raw.revision !== 'number' ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 0
  ) {
    throw invalidReturn(hookName, `${hookName} returned an unreadable identity record`);
  }
  return {
    identity: raw.identity,
    soul: raw.soul,
    instructions: raw.instructions,
    revision: raw.revision,
  };
}

/**
 * The agent's identity, soul, Instructions and revision, read as `ctx` (whose
 * `agentId` must be `agentId` — the hook authorizes on the ctx).
 *
 * `'unavailable'` when no identity store is registered. Throws whatever the
 * hook throws, and an `invalid-return` for a reply it cannot read.
 */
export async function readAgentIdentity(
  bus: HookBus,
  ctx: AgentContext,
  agentId: string,
): Promise<AgentIdentityView | 'unavailable'> {
  if (!bus.hasService('agents:identity:get')) return 'unavailable';
  const raw = await bus.call<IdentityGetInput, unknown>('agents:identity:get', ctx, { agentId });
  return toView('agents:identity:get', raw);
}

type SetOutcome = IdentityWriteResult | { kind: 'retry' };

function toSetOutcome(raw: unknown): SetOutcome {
  const hookName = 'agents:identity:set';
  if (isObject(raw)) {
    if (raw.outcome === 'saved' || raw.outcome === 'unchanged') {
      return { kind: 'saved', record: toView(hookName, raw.record) };
    }
    if (raw.outcome === 'conflict') return { kind: 'retry' };
    if (
      raw.outcome === 'refused' &&
      typeof raw.code === 'string' &&
      REFUSAL_CODES.includes(raw.code) &&
      typeof raw.reason === 'string'
    ) {
      return { kind: 'refused', code: raw.code as IdentityRefusalCode, reason: raw.reason };
    }
  }
  throw invalidReturn(hookName, `${hookName} returned an unreadable outcome`);
}

/**
 * Save the given sections: read, then set with the revision just read,
 * retrying a lost compare-and-set (see the header). Only the sections named in
 * `patch` are written.
 *
 * Throws whatever either hook throws, and an `invalid-return` for a reply it
 * cannot read — never a `saved` it cannot vouch for.
 */
export async function writeAgentIdentity(
  bus: HookBus,
  ctx: AgentContext,
  agentId: string,
  patch: Partial<Record<IdentitySection, string>>,
): Promise<IdentityWriteResult> {
  if (!bus.hasService('agents:identity:get') || !bus.hasService('agents:identity:set')) {
    return { kind: 'unavailable' };
  }
  for (let attempt = 1; attempt <= IDENTITY_WRITE_ATTEMPTS; attempt++) {
    const current = await readAgentIdentity(bus, ctx, agentId);
    if (current === 'unavailable') return { kind: 'unavailable' };
    const raw = await bus.call<IdentitySetInput, unknown>('agents:identity:set', ctx, {
      agentId,
      patch,
      expectedRevision: current.revision,
    });
    const outcome = toSetOutcome(raw);
    if (outcome.kind !== 'retry') return outcome;
  }
  return { kind: 'conflict' };
}
