import { describe, it, expect } from 'vitest';
import {
  PluginError,
  reject,
  isRejection,
  hold,
  isHold,
  HOLD_NOTE_MAX,
} from '../errors.js';

describe('PluginError', () => {
  it('captures code, plugin, and cause', () => {
    const cause = new Error('underlying');
    const err = new PluginError({
      code: 'no-service',
      plugin: 'core',
      message: 'no plugin registered for llm:call',
      cause,
    });
    expect(err.code).toBe('no-service');
    expect(err.plugin).toBe('core');
    expect(err.message).toBe('no plugin registered for llm:call');
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });

  it('serializes for logging without leaking cause/stack', () => {
    const cause = new Error('boom');
    const err = new PluginError({
      code: 'timeout',
      plugin: 'llm-anthropic',
      message: 'llm:call timed out after 60s',
      cause,
    });
    const json = err.toJSON();
    expect(json).toMatchObject({
      name: 'PluginError',
      code: 'timeout',
      plugin: 'llm-anthropic',
      message: 'llm:call timed out after 60s',
    });
    expect('cause' in json).toBe(false);
    expect('stack' in json).toBe(false);
  });

  it('captures and serializes hookName when provided', () => {
    const err = new PluginError({
      code: 'no-service',
      plugin: 'core',
      hookName: 'llm:call',
      message: "no plugin registered for service hook 'llm:call'",
    });
    expect(err.hookName).toBe('llm:call');
    expect(err.toJSON()).toMatchObject({ hookName: 'llm:call' });
  });
});

describe('reject', () => {
  it('returns a rejection sentinel', () => {
    const r = reject({ reason: 'secret detected' });
    expect(isRejection(r)).toBe(true);
    expect(r.rejected).toBe(true);
    expect(r.reason).toBe('secret detected');
  });

  it('isRejection returns false for ordinary objects', () => {
    expect(isRejection({ foo: 'bar' })).toBe(false);
    expect(isRejection(null)).toBe(false);
    expect(isRejection(undefined)).toBe(false);
  });
});

describe('hold', () => {
  it('is structurally a rejection so unaware callers fail closed', () => {
    const h = hold({ decisionId: 'dec_1', note: 'Waiting for you to approve this' });
    expect(isRejection(h)).toBe(true);
    expect(h.reason).toBe('Waiting for you to approve this');
  });

  it('is distinguishable from a plain rejection', () => {
    expect(isHold(hold({ decisionId: 'dec_1', note: 'n' }))).toBe(true);
    expect(isHold({ rejected: true, reason: 'nope' })).toBe(false);
  });

  it('carries the decision id through', () => {
    expect(hold({ decisionId: 'dec_1', note: 'n' }).hold.decisionId).toBe('dec_1');
  });

  it('clamps an over-long note to the wire ceiling so it cannot 500 into a deny', () => {
    const h = hold({ decisionId: 'dec_1', note: 'x'.repeat(HOLD_NOTE_MAX + 500) });
    expect(h.hold.note).toHaveLength(HOLD_NOTE_MAX);
    expect(h.reason).toHaveLength(HOLD_NOTE_MAX);
    expect(isHold(h)).toBe(true);
  });

  it('does not recognise a structurally-broken hold, so it degrades to a plain deny', () => {
    // Each of these would fail ToolPreCallResponseSchema's `.min(1)` /
    // `.max(2000)`. Reading them as ordinary rejections means the runner gets
    // a deny carrying the real reason instead of an opaque internal error.
    expect(isHold({ rejected: true, reason: 'r', hold: { decisionId: '', note: 'n' } })).toBe(
      false,
    );
    expect(isHold({ rejected: true, reason: 'r', hold: { decisionId: 'd', note: '' } })).toBe(
      false,
    );
    expect(
      isHold({
        rejected: true,
        reason: 'r',
        hold: { decisionId: 'd', note: 'x'.repeat(HOLD_NOTE_MAX + 1) },
      }),
    ).toBe(false);
  });
});

describe('reject() offendingPaths (TASK-287)', () => {
  it('carries the paths a rejection is about', () => {
    const r = reject({ reason: 'nope', offendingPaths: ['CLAUDE.md'] });
    expect(r.offendingPaths).toEqual(['CLAUDE.md']);
  });

  it('omits the key entirely when absent or empty', () => {
    // Absent and "present but empty" must not be two different things
    // downstream: a consumer checks `length > 0` to decide whether a rejection
    // can be scoped, and an empty array would read as "some paths, none of
    // them" — which is the whole-batch case wearing the scoped case's clothes.
    expect('offendingPaths' in reject({ reason: 'nope' })).toBe(false);
    expect('offendingPaths' in reject({ reason: 'nope', offendingPaths: [] })).toBe(false);
  });
});
