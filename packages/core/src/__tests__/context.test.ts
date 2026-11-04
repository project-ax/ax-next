import { describe, it, expect } from 'vitest';
import {
  makeReqId,
  createLogger,
  makeAgentContext,
  isOwnerlessId,
  ownerlessIdFor,
  OWNERLESS_ID_PREFIX,
} from '../context.js';
import { PluginError } from '../errors.js';

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

  // TASK-1028: HookBus.call wraps a service's raw throw as
  // PluginError{code:'unknown', cause}. Without `code` and `cause` a logged 5xx
  // said only "unknown" and pointed at the hook-bus stack, not what failed.
  describe('serialized Error carries code and one level of cause (TASK-1028)', () => {
    const logErr = (err: unknown): Record<string, unknown> => {
      const out: string[] = [];
      createLogger({ reqId: 'r', writer: (line) => out.push(line) }).error('boom', { err });
      return JSON.parse(out[0]!).err as Record<string, unknown>;
    };

    it('includes a string code', () => {
      const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      expect(logErr(err).code).toBe('ECONNREFUSED');
    });

    it('omits code when there is none', () => {
      expect('code' in logErr(new Error('plain'))).toBe(false);
    });

    it("includes an Error cause's name, code and stack frames", () => {
      const root = Object.assign(new TypeError('relation "skills" does not exist'), {
        code: '42P01',
      });
      const wrapped = Object.assign(new Error('skills:upsert failed', { cause: root }), {
        code: 'unknown',
      });
      const s = logErr(wrapped);
      expect(s.code).toBe('unknown');
      const cause = s.cause as Record<string, unknown>;
      expect(cause).toMatchObject({ name: 'TypeError', code: '42P01' });
      // The frames say WHERE it was thrown: this test file.
      expect(cause.frames).toMatch(/^\s+at .*context\.test\.ts/);
    });

    it("never writes the cause's message, not even via its stack header", () => {
      // credential-proxy wraps a resolver error whose message can carry an
      // OAuth server's error_description under FIXED outer text, because the
      // inner text is not loggable. The logger must not undo that.
      const secret = 'invalid_grant: refresh token rt_SECRET_123 revoked';
      const wrapped = new Error('a session credential could not be resolved', {
        cause: new Error(secret),
      });
      const out: string[] = [];
      createLogger({ reqId: 'r', writer: (line) => out.push(line) }).error('boom', { err: wrapped });
      expect(out[0]).not.toContain('rt_SECRET_123');
      const cause = (JSON.parse(out[0]!).err as { cause: Record<string, unknown> }).cause;
      expect('message' in cause).toBe(false);
      expect('stack' in cause).toBe(false);
    });

    it('never writes a multi-line cause message, even lines that look like frames', () => {
      // An OAuth error_description is free text; nothing stops it carrying a
      // newline followed by "  at …", which a per-line frame filter keeps.
      const secret = 'invalid_grant: revoked\n  at token rt_SECRET_ABC for alice@example.com';
      const wrapped = new Error('a session credential could not be resolved', {
        cause: new Error(secret),
      });
      const out: string[] = [];
      createLogger({ reqId: 'r', writer: (line) => out.push(line) }).error('boom', { err: wrapped });
      expect(out[0]).not.toContain('rt_SECRET_ABC');
      const cause = (JSON.parse(out[0]!).err as { cause: Record<string, unknown> }).cause;
      expect(cause.frames).toMatch(/^\s+at .*context\.test\.ts/);
    });

    it('writes no frames when the cause stack was rewritten without its message', () => {
      const inner = new Error('secret text rt_X');
      inner.stack = 'Error: something else entirely\n  at rt_X_looking_frame (x.js:1:1)';
      const s = logErr(new Error('outer', { cause: inner }));
      expect(JSON.stringify(s)).not.toContain('rt_X');
      expect('frames' in (s.cause as Record<string, unknown>)).toBe(false);
    });

    it('never throws over a cause with a non-string stack or name', () => {
      for (const bad of [null, 42, { secret: 'x' }]) {
        const inner = new Error('inner');
        (inner as { stack?: unknown }).stack = bad;
        (inner as { name?: unknown }).name = bad;
        const out: string[] = [];
        const logger = createLogger({ reqId: 'r', writer: (line) => out.push(line) });
        expect(() => logger.error('boom', { err: new Error('outer', { cause: inner }) })).not.toThrow();
        const cause = (JSON.parse(out[0]!).err as { cause: Record<string, unknown> }).cause;
        expect('name' in cause).toBe(false);
        expect('frames' in cause).toBe(false);
        expect(out[0]).not.toContain('secret');
      }
    });

    it('drops the cause rather than throw when reading it throws', () => {
      const inner = new Error('inner');
      Object.defineProperty(inner, 'stack', {
        get() {
          throw new Error('getter boom');
        },
      });
      const out: string[] = [];
      const logger = createLogger({ reqId: 'r', writer: (line) => out.push(line) });
      expect(() => logger.error('boom', { err: new Error('outer', { cause: inner }) })).not.toThrow();
      expect('cause' in (JSON.parse(out[0]!).err as Record<string, unknown>)).toBe(false);
    });

    it("names a PluginError cause's plugin and hook, so a fixed-text wrap still says which hook failed", () => {
      const busWrap = new PluginError({
        code: 'unknown',
        plugin: '@ax/credentials',
        hookName: 'credentials:get',
        message: "service hook 'credentials:get' threw: invalid_grant rt_SECRET",
      });
      const s = logErr(
        new PluginError({
          code: 'credential-resolve-failed',
          plugin: '@ax/credential-proxy',
          message: 'a session credential could not be resolved',
          cause: busWrap,
        }),
      );
      expect(s.cause).toMatchObject({
        name: 'PluginError',
        code: 'unknown',
        plugin: '@ax/credentials',
        hookName: 'credentials:get',
      });
      expect(JSON.stringify(s)).not.toContain('rt_SECRET');
    });

    it('caps the identifier fields a cause contributes', () => {
      const inner = Object.assign(new Error('inner'), { code: 'C'.repeat(500) });
      inner.name = 'N'.repeat(500);
      const c = logErr(new Error('outer', { cause: inner })).cause as Record<string, string>;
      expect(c.name!.length).toBe(100);
      expect(c.code!.length).toBe(100);

      const pe = new PluginError({
        code: 'unknown',
        plugin: 'P'.repeat(500),
        hookName: 'H'.repeat(500),
        message: 'wrapped',
      });
      const p = logErr(new Error('outer', { cause: pe })).cause as Record<string, string>;
      expect(p.plugin!.length).toBe(100);
      expect(p.hookName!.length).toBe(100);
    });

    it('writes no frames for a non-string cause message (an array merged onto an Error)', () => {
      // V8 stringifies the array into the header, where a frame-shaped line
      // can't be told from a real one.
      const inner = Object.assign(new Error('Request failed'), {
        message: ['email invalid', 'x\n  at rt_SECRET_ARR'],
      });
      inner.stack = `Error: email invalid,x\n  at rt_SECRET_ARR\n    at real (file.js:1:1)`;
      const s = logErr(new Error('outer', { cause: inner }));
      expect(JSON.stringify(s)).not.toContain('rt_SECRET_ARR');
      expect('frames' in (s.cause as Record<string, unknown>)).toBe(false);
    });

    it('writes frames for an empty message only when the header is the bare name', () => {
      const blanked = new Error('secret\n  at rt_BLANKED');
      void blanked.stack; // V8 builds the header now, from the secret message
      blanked.message = '';
      expect(JSON.stringify(logErr(new Error('outer', { cause: blanked })))).not.toContain(
        'rt_BLANKED',
      );

      // A `Name: ` header (vite's module runner writes one under vitest) is
      // ALSO what a message that began with `\n` leaves behind once blanked,
      // and the two can't be told apart from the string (TASK-1031). Node —
      // with or without --enable-source-maps — writes the bare name for an
      // empty message, so only the bare name gives frames.
      const leadingNl = new Error('');
      leadingNl.stack = 'Error: \n  at rt_LEADING_NL (secret)\n    at real (file.js:1:1)';
      const l = logErr(new Error('outer', { cause: leadingNl }));
      expect(JSON.stringify(l)).not.toContain('rt_LEADING_NL');
      expect('frames' in (l.cause as Record<string, unknown>)).toBe(false);

      const empty = new Error('');
      empty.stack = 'Error: \n    at fn (file.js:1:1)';
      const c = logErr(new Error('outer', { cause: empty })).cause as Record<string, unknown>;
      expect('frames' in c).toBe(false);

      // An empty name: V8 writes the message as the header, so a blanked
      // message that began with `\n` leaves an empty first line.
      const nameless = new Error('');
      nameless.name = '';
      nameless.stack = '\n  at rt_NAMELESS (secret)\n    at real (file.js:1:1)';
      const n = logErr(new Error('outer', { cause: nameless }));
      expect(JSON.stringify(n)).not.toContain('rt_NAMELESS');

      // Plain Node/V8 (production) writes the bare name: `Error`.
      const v8 = new Error('');
      v8.stack = 'Error\n    at fn (file.js:1:1)';
      const v = logErr(new Error('outer', { cause: v8 })).cause as Record<string, unknown>;
      expect(v.frames).toBe('    at fn (file.js:1:1)');
    });

    it('stops at one level of cause', () => {
      const deepest = Object.assign(new Error('deepest'), { code: 'DEEP' });
      const middle = new RangeError('middle', { cause: deepest });
      const top = new Error('top', { cause: middle });
      const s = logErr(top);
      const cause = s.cause as Record<string, unknown>;
      expect(cause.name).toBe('RangeError');
      expect('cause' in cause).toBe(false);
      expect(JSON.stringify(s)).not.toContain('DEEP');
    });

    it('drops a non-Error cause', () => {
      expect('cause' in logErr(new Error('a', { cause: 'socket hang up' }))).toBe(false);
      expect('cause' in logErr(new Error('b', { cause: { secret: 'x' } }))).toBe(false);
    });

    it('survives a self-referencing cause', () => {
      const e = new Error('loop');
      (e as { cause?: unknown }).cause = e;
      const s = logErr(e);
      expect((s.cause as Record<string, unknown>).name).toBe('Error');
    });
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
