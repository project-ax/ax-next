import { describe, it, expect } from 'vitest';
import {
  makeReqId,
  createLogger,
  makeAgentContext,
  isOwnerlessId,
  ownerlessIdFor,
  OWNERLESS_ID_PREFIX,
} from '../context.js';

describe('makeReqId', () => {
  it('generates a unique, readable id', () => {
    const a = makeReqId();
    const b = makeReqId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^req-[a-z0-9]+$/);
  });
});

describe('createLogger', () => {
  it('binds reqId into every log entry', () => {
    const out: string[] = [];
    const logger = createLogger({
      reqId: 'req-abc',
      writer: (line) => out.push(line),
    });
    logger.info('hello', { a: 1 });
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!);
    expect(parsed).toMatchObject({
      level: 'info',
      reqId: 'req-abc',
      msg: 'hello',
      a: 1,
    });
  });

  it('logs at error level with serialized Error', () => {
    const out: string[] = [];
    const logger = createLogger({
      reqId: 'req-xyz',
      writer: (line) => out.push(line),
    });
    logger.error('boom', { err: new Error('bang') });
    const parsed = JSON.parse(out[0]!);
    expect(parsed.level).toBe('error');
    expect(parsed.err).toMatchObject({ name: 'Error', message: 'bang' });
  });

  it('child() adds bindings without losing parent bindings', () => {
    const out: string[] = [];
    const logger = createLogger({
      reqId: 'req-1',
      writer: (line) => out.push(line),
    });
    const child = logger.child({ plugin: 'llm-anthropic' });
    child.info('x');
    const parsed = JSON.parse(out[0]!);
    expect(parsed).toMatchObject({
      reqId: 'req-1',
      plugin: 'llm-anthropic',
      msg: 'x',
    });
  });

  it('reserved fields (reqId/level/ts/msg) cannot be spoofed by bindings', () => {
    const out: string[] = [];
    const logger = createLogger({
      reqId: 'req-real',
      writer: (line) => out.push(line),
      bindings: { reqId: 'spoof-via-base', level: 'spoof', ts: 'spoof', msg: 'spoof' },
    });
    logger.warn('actual', { reqId: 'spoof-per-call', level: 'spoof', ts: 'spoof', msg: 'spoof' });
    const child = logger.child({ reqId: 'spoof-via-child', level: 'spoof' });
    child.info('child-msg');
    const a = JSON.parse(out[0]!);
    const b = JSON.parse(out[1]!);
    expect(a).toMatchObject({ reqId: 'req-real', level: 'warn', msg: 'actual' });
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(b).toMatchObject({ reqId: 'req-real', level: 'info', msg: 'child-msg' });
  });
});

describe('makeAgentContext', () => {
  it('carries the expected identity fields', () => {
    const ctx = makeAgentContext({
      reqId: 'req-1',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      userId: 'user-1',
    });
    expect(ctx.reqId).toBe('req-1');
    expect(ctx.sessionId).toBe('sess-1');
    expect(ctx.agentId).toBe('agent-1');
    expect(ctx.userId).toBe('user-1');
    expect(ctx.state).toEqual(new Map());
    expect(typeof ctx.logger.info).toBe('function');
  });

  it('generates a reqId when not supplied', () => {
    const ctx = makeAgentContext({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      userId: 'user-1',
    });
    expect(ctx.reqId).toMatch(/^req-/);
  });

  it('defaults workspace.rootPath to process.cwd() when not supplied', () => {
    const ctx = makeAgentContext({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      userId: 'user-1',
    });
    expect(ctx.workspace.rootPath).toBe(process.cwd());
  });

  it('carries an explicit workspace.rootPath through', () => {
    const ctx = makeAgentContext({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      userId: 'user-1',
      workspace: { rootPath: '/tmp/some/ws' },
    });
    expect(ctx.workspace.rootPath).toBe('/tmp/some/ws');
  });

  it('round-trips an explicit source', () => {
    const routine = makeAgentContext({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      userId: 'user-1',
      source: 'routine',
    });
    expect(routine.source).toBe('routine');

    const user = makeAgentContext({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      userId: 'user-1',
      source: 'user',
    });
    expect(user.source).toBe('user');
  });

  it('leaves source undefined (and absent) when not supplied', () => {
    const ctx = makeAgentContext({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      userId: 'user-1',
    });
    expect(ctx.source).toBeUndefined();
    // Conditional-spread: the key is never set to a literal `undefined`, so
    // `source` should not even be an own property when omitted.
    expect(Object.prototype.hasOwnProperty.call(ctx, 'source')).toBe(false);
  });

  it('carries an explicit triggerLabel through', () => {
    const ctx = makeAgentContext({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      userId: 'user-1',
      triggerLabel: 'Morning email pass',
    });
    expect(ctx.triggerLabel).toBe('Morning email pass');
  });

  it('leaves triggerLabel undefined (and absent) when not supplied', () => {
    const ctx = makeAgentContext({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      userId: 'user-1',
    });
    expect(ctx.triggerLabel).toBeUndefined();
    // Conditional-spread: the key is never set to a literal `undefined`, so
    // `triggerLabel` should not even be an own property when omitted.
    expect(Object.prototype.hasOwnProperty.call(ctx, 'triggerLabel')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TASK-411 — the owner-less stand-in.
//
// `agentId` / `userId` are required non-empty strings, but a canary / `serve` /
// pre-9.5 session has no owner, so the IPC listeners have to put SOMETHING
// there. They used to put a per-transport constant ('ipc-http' / 'ipc-server'),
// and since every agent-partitioned store keys on the agent id, one constant
// meant one partition shared by every owner-less session in the deployment.
//
// Two properties are load-bearing, and they are separate: uniqueness (nothing
// pools, in ANY store, whether or not it knows about this helper) and
// recognisability (a store that needs a real owner can refuse).
// ---------------------------------------------------------------------------
describe('owner-less ids', () => {
  it('is distinct per session — the property that stops pooling', () => {
    expect(ownerlessIdFor('s-1')).not.toBe(ownerlessIdFor('s-2'));
  });

  it('is stable for one session — a session reads back what it wrote', () => {
    // Not cosmetic: a per-REQUEST id would give the same session a different
    // partition on every call.
    expect(ownerlessIdFor('s-1')).toBe(ownerlessIdFor('s-1'));
  });

  it('is recognisable — the property that lets a store fail closed', () => {
    expect(isOwnerlessId(ownerlessIdFor('s-1'))).toBe(true);
  });

  it('never matches a minted id, and never the old transport constants', () => {
    // `mintAgentId` produces `agt_<base64url>`; user ids come from the auth
    // provider. Neither namespace can collide with the reserved prefix.
    for (const id of ['agt_AAAA', 'usr_1', 'agent-1', 'ipc-http', 'ipc-server', '']) {
      expect(isOwnerlessId(id)).toBe(false);
    }
  });

  it('is a PREFIX test, not a substring search', () => {
    // A real agent whose id happens to contain the marker later in the string
    // must not be locked out of its own workspace.
    expect(isOwnerlessId(`agt_x-${OWNERLESS_ID_PREFIX}suffix`)).toBe(false);
    expect(isOwnerlessId(` ${OWNERLESS_ID_PREFIX}s-1`)).toBe(false);
  });
});
