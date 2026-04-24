import { describe, it, expect } from 'vitest';
import { makeReqId, createLogger, makeChatContext } from '../context.js';

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

describe('makeChatContext', () => {
  it('carries the expected identity fields', () => {
    const ctx = makeChatContext({
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
    const ctx = makeChatContext({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      userId: 'user-1',
    });
    expect(ctx.reqId).toMatch(/^req-/);
  });

  it('defaults workspace.rootPath to process.cwd() when not supplied', () => {
    const ctx = makeChatContext({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      userId: 'user-1',
    });
    expect(ctx.workspace.rootPath).toBe(process.cwd());
  });

  it('carries an explicit workspace.rootPath through', () => {
    const ctx = makeChatContext({
      sessionId: 'sess-1',
      agentId: 'agent-1',
      userId: 'user-1',
      workspace: { rootPath: '/tmp/some/ws' },
    });
    expect(ctx.workspace.rootPath).toBe('/tmp/some/ws');
  });
});
