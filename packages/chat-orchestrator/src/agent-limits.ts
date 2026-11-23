// §5 / §6 (sandbox-service-reach design) — the per-agent turn limit, idle
// time and runner size, turned into the numbers the orchestrator runs on.
// Pure: no bus, no timers. The orchestrator calls `effectiveLimits` once per
// turn, right after `agents:resolve`.

const MIN = 60_000;

/** The runner's own idle floor never drops below today's 15 minutes. */
export const INBOX_IDLE_FLOOR_MS = 15 * MIN;
/** The runner outlives the host's idle reaper by this much (§6.4). */
export const INBOX_IDLE_MARGIN_MS = 5 * MIN;
/** The continuation reap hold never drops below Slack's 30-minute reply cap (§6.5). */
export const REAP_HOLD_FLOOR_MS = 30 * MIN;
/** How often a running turn's sign-ins are rotated (§6.4). */
export const MID_TURN_ROTATION_MS = 30 * MIN;
/** A warm sandbox needs this much more than the turn limit left before its ceiling (§6.4). */
export const WARM_LIFETIME_MARGIN_MS = 10 * MIN;
/** The chart's caps, used when the host passes none. */
export const DEFAULT_MAX_TURN_MINUTES = 120;
export const DEFAULT_MAX_IDLE_MINUTES = 60;

export interface ResourcePair {
  request: number;
  limit: number;
}
/** Numbers on the wire: CPU in millicores, memory in MiB. The sandbox clamps. */
export interface RunnerSize {
  cpuMillis?: ResourcePair;
  memoryMiB?: ResourcePair;
}

/**
 * The three settings on the agent row `agents:resolve` returns. Null/absent
 * means "the default". Stored values may sit above today's caps: they are
 * clamped here, never refused.
 */
export interface AgentLimitSettings {
  turnLimitMinutes?: number | null;
  idleMinutes?: number | null;
  runnerSize?: RunnerSize | null;
}

export interface EffectiveLimits {
  /** Longest one turn may run. */
  turnMs: number;
  /** How long a finished turn's warm sandbox waits for the next message. */
  idleMs: number;
  /** The runner's own idle floor: max(15 min, idleMs + 5 min). */
  inboxIdleMs: number;
  /** The idle reaper's continuation hold: max(30 min, turnMs). */
  reapHoldMs: number;
  runnerSize?: RunnerSize;
}

export interface LimitCaps {
  maxTurnMinutes: number;
  maxIdleMinutes: number;
  /** What an agent without its own turn limit or idle time gets. */
  defaults: { turnMs: number; idleMs: number };
  /**
   * A host's explicit `reapHoldMaxMs` (a test override): the hold for EVERY
   * agent. Absent (production), the hold is max(30 min, turnMs).
   */
  reapHoldOverrideMs?: number;
}

function minutesOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function effectiveLimits(agent: AgentLimitSettings, caps: LimitCaps): EffectiveLimits {
  const turnMinutes = minutesOrUndefined(agent.turnLimitMinutes);
  const idleMinutes = minutesOrUndefined(agent.idleMinutes);
  const turnMs =
    turnMinutes === undefined ? caps.defaults.turnMs : Math.min(turnMinutes, caps.maxTurnMinutes) * MIN;
  const idleMs =
    idleMinutes === undefined ? caps.defaults.idleMs : Math.min(idleMinutes, caps.maxIdleMinutes) * MIN;
  const reapHoldMs = caps.reapHoldOverrideMs ?? Math.max(REAP_HOLD_FLOOR_MS, turnMs);
  const limits: EffectiveLimits = {
    turnMs,
    idleMs,
    inboxIdleMs: Math.max(INBOX_IDLE_FLOOR_MS, idleMs + INBOX_IDLE_MARGIN_MS),
    reapHoldMs,
  };
  const size = agent.runnerSize;
  if (size !== null && size !== undefined) {
    const copy: RunnerSize = {};
    if (size.cpuMillis !== undefined) copy.cpuMillis = { request: size.cpuMillis.request, limit: size.cpuMillis.limit };
    if (size.memoryMiB !== undefined) copy.memoryMiB = { request: size.memoryMiB.request, limit: size.memoryMiB.limit };
    if (copy.cpuMillis !== undefined || copy.memoryMiB !== undefined) limits.runnerSize = copy;
  }
  return limits;
}

/** Whole milliseconds, 1 or more: the sandbox wire accepts digits only, no leading zero. */
function msDigits(ms: number): string {
  return String(Math.max(1, Math.round(ms)));
}

/** The only env the orchestrator sets on a runner (`sandbox:open-session`'s `env`). */
export function runnerEnv(limits: EffectiveLimits): { AX_INBOX_IDLE_MS: string; AX_TURN_LIMIT_MS: string } {
  return { AX_INBOX_IDLE_MS: msDigits(limits.inboxIdleMs), AX_TURN_LIMIT_MS: msDigits(limits.turnMs) };
}

/** What is left of a sandbox's lifetime, in ms; undefined without a known lifetime. */
export function sandboxTimeLeftMs(o: {
  openedAt: number;
  now: number;
  lifetimeMs: number | undefined;
}): number | undefined {
  return o.lifetimeMs === undefined ? undefined : o.openedAt + o.lifetimeMs - o.now;
}

/**
 * True when a warm sandbox opened at `openedAt` has less than the turn limit
 * plus 10 minutes left before its lifetime ceiling, so a turn routed into it
 * could be cut by the ceiling. Never true without a known lifetime.
 */
export function warmSandboxTooOld(o: {
  openedAt: number;
  now: number;
  lifetimeMs: number | undefined;
  turnMs: number;
}): boolean {
  const left = sandboxTimeLeftMs(o);
  return left !== undefined && left < o.turnMs + WARM_LIFETIME_MARGIN_MS;
}
