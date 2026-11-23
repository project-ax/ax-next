import { describe, it, expect } from 'vitest';
import { effectiveLimits, runnerEnv, sandboxTimeLeftMs, warmSandboxTooOld } from '../agent-limits.js';

const MIN = 60_000;
const caps = { maxTurnMinutes: 120, maxIdleMinutes: 60, defaults: { turnMs: 10 * MIN, idleMs: 5 * MIN } };

describe('effectiveLimits', () => {
  it('an agent with no settings gets the defaults, a 15-minute runner floor and a 30-minute hold', () => {
    expect(effectiveLimits({}, caps)).toEqual({
      turnMs: 10 * MIN, idleMs: 5 * MIN, inboxIdleMs: 15 * MIN, reapHoldMs: 30 * MIN,
    });
    expect(effectiveLimits({ turnLimitMinutes: null, idleMinutes: null, runnerSize: null }, caps))
      .toEqual(effectiveLimits({}, caps));
  });

  it('uses the agent settings, clamped to the caps', () => {
    expect(effectiveLimits({ turnLimitMinutes: 120, idleMinutes: 30 }, caps)).toMatchObject({
      turnMs: 120 * MIN, idleMs: 30 * MIN, inboxIdleMs: 35 * MIN, reapHoldMs: 120 * MIN,
    });
    expect(effectiveLimits({ turnLimitMinutes: 1440, idleMinutes: 1440 }, caps)).toMatchObject({
      turnMs: 120 * MIN, idleMs: 60 * MIN, inboxIdleMs: 65 * MIN,
    });
  });

  it('a value that is not a positive number falls back to the default', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(effectiveLimits({ turnLimitMinutes: bad, idleMinutes: bad }, caps)).toMatchObject({
        turnMs: 10 * MIN, idleMs: 5 * MIN,
      });
    }
  });

  it('an explicit hold (a test override) applies to every agent', () => {
    const withHold = { ...caps, reapHoldOverrideMs: 2_500 };
    expect(effectiveLimits({}, withHold).reapHoldMs).toBe(2_500);
    expect(effectiveLimits({ turnLimitMinutes: 90 }, withHold).reapHoldMs).toBe(2_500);
    expect(effectiveLimits({ turnLimitMinutes: 90 }, caps).reapHoldMs).toBe(90 * MIN);
  });

  it('copies only the runner size parts that are set', () => {
    const cpuMillis = { request: 2000, limit: 4000 };
    expect(effectiveLimits({ runnerSize: { cpuMillis } }, caps).runnerSize).toEqual({ cpuMillis });
    expect(effectiveLimits({ runnerSize: {} }, caps)).not.toHaveProperty('runnerSize');
  });
});

describe('runnerEnv', () => {
  it('writes whole milliseconds as digit strings', () => {
    expect(runnerEnv(effectiveLimits({ turnLimitMinutes: 120, idleMinutes: 30 }, caps))).toEqual({
      AX_INBOX_IDLE_MS: '2100000', AX_TURN_LIMIT_MS: '7200000',
    });
    expect(runnerEnv(effectiveLimits({ turnLimitMinutes: 0.0001 }, caps)).AX_TURN_LIMIT_MS).toBe('6');
  });
});

describe('sandboxTimeLeftMs', () => {
  it('is what is left of the lifetime, or undefined without one', () => {
    expect(sandboxTimeLeftMs({ openedAt: 1_000, now: 61_000, lifetimeMs: 180 * MIN })).toBe(179 * MIN);
    expect(sandboxTimeLeftMs({ openedAt: 0, now: 1, lifetimeMs: undefined })).toBeUndefined();
  });
});

describe('warmSandboxTooOld', () => {
  it('is too old when less than the turn limit plus 10 minutes is left', () => {
    const life = 180 * MIN;
    expect(warmSandboxTooOld({ openedAt: 0, now: 50 * MIN, lifetimeMs: life, turnMs: 120 * MIN })).toBe(false);
    expect(warmSandboxTooOld({ openedAt: 0, now: 50 * MIN + 1, lifetimeMs: life, turnMs: 120 * MIN })).toBe(true);
  });
  it('never, without a known lifetime', () => {
    expect(warmSandboxTooOld({ openedAt: 0, now: 1e12, lifetimeMs: undefined, turnMs: 120 * MIN })).toBe(false);
  });
});
