import { HookBus, PluginError, makeAgentContext, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { logCode } from '../log-code.js';
import { accountName, personName } from '../person-name.js';

/*
  What a page calls a person it only knows by id (person-name.ts). `personName`
  folds "auth has no such account" and an auth fault into its fallback, so a
  name never fails the members' pages it's on. `accountName` keeps "gone" apart
  as null and lets a fault through (TASK-1172: Admin › Slack marks a bot's
  approver who has left, and an outage must fail that list rather than read
  as nobody having left). Auth's `auth:get-user` answers null for an id it
  doesn't know and throws on a fault (@ax/auth-better's getUserById).
*/

const ADA = 'usr_ada';
const FALLBACK = 'A teammate';

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
};

/** A bus whose `auth:get-user` answers `answer` (or throws it, with `throws`), recording each id it was asked about. */
function authSays(answer: unknown, o: { throws?: boolean } = {}) {
  const bus = new HookBus();
  const asked: string[] = [];
  bus.registerService('auth:get-user', '@ax/auth-better', async (_ctx, raw) => {
    asked.push((raw as { userId: string }).userId);
    if (o.throws === true) throw answer;
    return answer;
  });
  const ctx = makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId: 'usr_reader', logger: silent });
  const faults: unknown[] = [];
  const onFault = (err: unknown): void => {
    faults.push(err);
  };
  return { bus, ctx, asked, faults, onFault };
}

describe('accountName', () => {
  it('accountName: a display name, cleaned to one line', async () => {
    const a = authSays({ id: ADA, displayName: '  Ada\u202E   Admin  ', email: 'ada@canopyworks.example' });

    const name = await accountName(a.bus, a.ctx, ADA, { allowEmail: true, fallback: FALLBACK });

    expect(name).toBe('Ada Admin');
    expect(a.asked).toEqual([ADA]);
  });

  it('accountName: the email only where allowEmail says so, else the fallback', async () => {
    const a = authSays({ id: ADA, displayName: null, email: 'ada@canopyworks.example' });

    expect(await accountName(a.bus, a.ctx, ADA, { allowEmail: true, fallback: FALLBACK })).toBe('ada@canopyworks.example');
    expect(await accountName(a.bus, a.ctx, ADA, { allowEmail: false, fallback: FALLBACK })).toBe(FALLBACK);
  });

  it('accountName: null when auth no longer has the account', async () => {
    const a = authSays(null);

    expect(await accountName(a.bus, a.ctx, ADA, { allowEmail: true, fallback: FALLBACK })).toBeNull();
    expect(a.asked).toEqual([ADA]);
  });

  it("accountName: an answer that isn't an account reads as the fallback, never as gone", async () => {
    // Only auth's null says the account is gone: a malformed answer must not mark anyone as having left.
    for (const answer of [undefined, 'usr_ada', ['Ada Admin'], 42]) {
      const a = authSays(answer);
      expect(
        await accountName(a.bus, a.ctx, ADA, { allowEmail: true, fallback: FALLBACK }),
        JSON.stringify(answer) ?? 'undefined',
      ).toBe(FALLBACK);
    }
  });

  it('accountName: an auth fault throws, never a name or null: a page that marks who has left must not read an outage as nobody leaving', async () => {
    const fault = Object.assign(new Error('x'), { code: 'ECONNRESET' });
    const a = authSays(fault, { throws: true });

    const err = await accountName(a.bus, a.ctx, ADA, { allowEmail: true, fallback: FALLBACK }).then(
      (name) => ({ answered: name }),
      (e: unknown) => e,
    );

    // That error, as the bus hands it on: wrapped, with the fault as its cause, so the page logs its code.
    expect(err).toBeInstanceOf(PluginError);
    expect((err as Error).cause).toBe(fault);
    expect(logCode(err)).toBe('ECONNRESET');
    expect(a.asked).toEqual([ADA]);
  });
});

describe('personName', () => {
  it('personName: an account auth no longer has still reads as the fallback', async () => {
    const a = authSays(null);

    expect(await personName(a.bus, a.ctx, ADA, { allowEmail: true, fallback: FALLBACK, onFault: a.onFault })).toBe(
      FALLBACK,
    );
    expect(a.faults).toEqual([]);
  });

  it('personName: an auth fault reaches onFault once and answers the fallback, so a name never fails the page', async () => {
    const fault = Object.assign(new Error('x'), { code: 'ECONNRESET' });
    const a = authSays(fault, { throws: true });

    expect(await personName(a.bus, a.ctx, ADA, { allowEmail: false, fallback: FALLBACK, onFault: a.onFault })).toBe(
      FALLBACK,
    );
    // That error, as the bus hands it on: wrapped, with the fault as its cause, so a page logs its code.
    expect(a.faults).toHaveLength(1);
    expect(a.faults[0]).toBeInstanceOf(PluginError);
    expect((a.faults[0] as Error).cause).toBe(fault);
    expect(logCode(a.faults[0])).toBe('ECONNRESET');
  });

  it('personName: a display name, else the email only where allowEmail says so, else the fallback', async () => {
    const named = authSays({ id: ADA, displayName: '  Ada\u202E   Admin  ', email: 'ada@canopyworks.example' });
    expect(await personName(named.bus, named.ctx, ADA, { allowEmail: false, fallback: FALLBACK, onFault: named.onFault })).toBe(
      'Ada Admin',
    );
    const nameless = authSays({ id: ADA, displayName: null, email: 'ada@canopyworks.example' });
    expect(
      await personName(nameless.bus, nameless.ctx, ADA, { allowEmail: true, fallback: FALLBACK, onFault: nameless.onFault }),
    ).toBe('ada@canopyworks.example');
    expect(
      await personName(nameless.bus, nameless.ctx, ADA, { allowEmail: false, fallback: FALLBACK, onFault: nameless.onFault }),
    ).toBe(FALLBACK);
    expect([...named.faults, ...nameless.faults]).toEqual([]);
  });
});
