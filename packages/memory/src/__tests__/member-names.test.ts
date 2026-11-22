import {
  HookBus,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type AgentContextAudience,
  type AgentContextSource,
  type Logger,
} from '@ax/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTH_GET_USER_HOOK,
  MEMBER_NAME_MAX,
  MEMBER_NAMES_FAILED_EVENT,
  memberKeyId,
  memberLabels,
  memberName,
  TEAMMATE_TEXT,
} from '../member-names.js';
import { MEMORY_RECALL_TOOL_HOOK } from '../recall-tool.js';
import type { MemoryRecallOutput } from '../types.js';
import {
  ALICE,
  BOB,
  capturingLogger,
  engineRecord,
  eventsNamed,
  makeMemoryHarness,
  type LoggedEvent,
  type MemoryHarness,
  type MemoryHarnessOptions,
} from './harness.js';

/**
 * TASK-1209: on a team agent another member's memories read by their display
 * name, from the `auth:get-user` hook memory declares in `optionalCalls`.
 * Never their raw id, never their email, never "you", and never a name that
 * would read as the person talking or as the agent. A personal agent asks
 * nobody. Every failure reads "a teammate" and the recall still answers.
 */

let harness: MemoryHarness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

async function makeHarness(options: MemoryHarnessOptions = {}): Promise<MemoryHarness> {
  harness = await makeMemoryHarness({}, options);
  return harness;
}

const TEAM = { visibility: 'team' } as const;
const PERSONAL = { visibility: 'personal' } as const;
const JAN = '2026-01-15T00:00:00.000Z';
const CHANNEL = 'conv-channel';

describe('member names (TASK-1209)', () => {
  describe('memberName', () => {
    it('keeps an ordinary name as it is', () => {
      expect(memberName('Bob Smith')).toBe('Bob Smith');
    });

    it('flattens a name that hides characters onto one clean line', () => {
      // A bidi override, a newline and a zero-width space: each becomes a
      // space, and the spaces collapse.
      expect(memberName('Bob‮ \n Smith​')).toBe('Bob Smith');
      expect(memberName('Bob Smith')).toBe('Bob Smith');
    });

    it(`clamps a name to ${MEMBER_NAME_MAX} code units without splitting a surrogate pair`, () => {
      // 79 + 2 units: the cut at 80 would land inside the emoji, so it all goes.
      expect(memberName('a'.repeat(79) + '\u{1F600}')).toBe('a'.repeat(79));
      expect(memberName('b'.repeat(200))).toBe('b'.repeat(MEMBER_NAME_MAX));
    });

    it.each([
      ['null', null],
      ['a number', 42],
      ['an object', { first: 'Bob' }],
      ['empty', ''],
      ['blank', '   '],
      ['only a zero-width space', '​'],
      ['only a bidi override', '‮'],
      // Not in core's class, and draws nothing: the line would read as
      // nobody's, which a model may take for the person talking.
      ['only a soft hyphen', '­'],
      ['only punctuation', '...'],
      ['only an emoji', '\u{1F600}'],
    ])('has no name to show for %s', (_label, raw) => {
      expect(memberName(raw)).toBeUndefined();
    });

    // A name that reads as the person talking (`you` in the block and the
    // memory view, `user` in the evidence table) or as the agent would pin a
    // teammate's facts on the wrong person.
    it.each([
      'you',
      'You',
      ' YOU ',
      'ｙｏｕ', // fullwidth "you"
      'You.',
      '(you)',
      'Y­ou', // a soft hyphen, invisible in most renderers
      'Yöu', // "you" with a combining diaeresis
      'user',
      'User',
      'user:abc',
      'The User',
      'Me',
      'I',
      'Assistant',
      'AI Assistant',
      'ai-assistant',
      'Assistant!',
      'the agent',
      'Ａｓｓｉｓｔａｎｔ', // fullwidth "Assistant"
    ])('refuses %j: it reads as the person talking or the agent', (raw) => {
      expect(memberName(raw)).toBeUndefined();
    });

    it.each(['You Li', 'Agent Smith', 'Ian Assistant', 'Userton', 'Mei'])(
      'keeps %j: a name that only contains one of those words is still a name',
      (raw) => {
        expect(memberName(raw)).toBe(raw);
      },
    );
  });

  describe('memberKeyId', () => {
    it("reads a member's key", () => {
      expect(memberKeyId('user:abc')).toBe('abc');
    });

    it.each(['user:', 'user', 'User:abc', 'acme_corp', ' user:abc'])('%j is not a member key', (about) => {
      expect(memberKeyId(about)).toBeUndefined();
    });
  });

  describe('memberLabels', () => {
    function authBus(answer: (userId: string) => unknown): { bus: HookBus; asked: string[] } {
      const bus = new HookBus();
      const asked: string[] = [];
      bus.registerService<{ userId: string }, unknown>(AUTH_GET_USER_HOOK, '@ax/test-auth', async (_ctx, input) => {
        asked.push(input.userId);
        return answer(input.userId);
      });
      return { bus, asked };
    }

    function ctxOf(
      logs: LoggedEvent[],
      opts: { source?: AgentContextSource; audience?: AgentContextAudience; logger?: Logger } = {},
    ): AgentContext {
      return makeAgentContext({
        sessionId: 's',
        agentId: 'agent-1',
        userId: 'u-alice',
        workspace: { rootPath: '/tmp' },
        logger: opts.logger ?? capturingLogger(logs),
        ...(opts.source !== undefined ? { source: opts.source } : {}),
        ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
      });
    }

    const named = (userId: string): unknown =>
      ({ 'u-bob': { id: 'u-bob', displayName: 'Bob Smith', email: 'bob@x.test', isAdmin: false } })[userId] ?? null;

    it('asks nobody on a personal agent', async () => {
      const logs: LoggedEvent[] = [];
      const { bus, asked } = authBus(named);
      const labels = await memberLabels(bus, ctxOf(logs), PERSONAL, ['user:u-bob', 'user:u-carol'], 'user:u-alice');
      expect([...labels]).toEqual([]);
      expect(asked).toEqual([]);
    });

    it("on a team agent, asks once per other member and names only member keys", async () => {
      const logs: LoggedEvent[] = [];
      const { bus, asked } = authBus(named);
      const labels = await memberLabels(
        bus,
        ctxOf(logs),
        TEAM,
        ['user:u-bob', 'user:u-bob', 'user:u-alice', 'acme_corp', 'user'],
        'user:u-alice',
      );
      expect(asked).toEqual(['u-bob']);
      expect([...labels]).toEqual([['user:u-bob', 'Bob Smith']]);
      expect(logs).toEqual([]);
    });

    it('with no auth:get-user at all, every member reads "a teammate", with no warn', async () => {
      const logs: LoggedEvent[] = [];
      const labels = await memberLabels(new HookBus(), ctxOf(logs), TEAM, ['user:u-bob', 'user:u-carol'], undefined);
      expect([...labels]).toEqual([
        ['user:u-bob', TEAMMATE_TEXT],
        ['user:u-carol', TEAMMATE_TEXT],
      ]);
      expect(logs).toEqual([]);
    });

    it.each([
      ['no account (null)', null],
      ['an array', []],
      ['no displayName', { id: 'u-bob' }],
      ['a blank displayName', { id: 'u-bob', displayName: '  ' }],
      ['an email and no name', { id: 'u-bob', displayName: null, email: 'bob@x.test' }],
      ['a reserved name', { id: 'u-bob', displayName: 'You' }],
      ["another account's answer", { id: 'u-carol', displayName: 'Carol' }],
      ['an answer with no id', { displayName: 'Bob Smith' }],
    ])('%s reads "a teammate", with no warn', async (_label, answer) => {
      const logs: LoggedEvent[] = [];
      const { bus, asked } = authBus(() => answer);
      const labels = await memberLabels(bus, ctxOf(logs), TEAM, ['user:u-bob'], undefined);
      expect(asked).toEqual(['u-bob']);
      expect([...labels]).toEqual([['user:u-bob', TEAMMATE_TEXT]]);
      expect(JSON.stringify([...labels])).not.toContain('bob@x.test');
      expect(logs).toEqual([]);
    });

    it('a lookup that throws reads "a teammate"; the others are still named; one warn, by code only', async () => {
      const logs: LoggedEvent[] = [];
      const { bus } = authBus((userId) => {
        if (userId === 'u-bob') {
          throw new PluginError({ code: 'store-unavailable', plugin: 'x', message: 'bob@x.test u-bob Bob' });
        }
        if (userId === 'u-dave') throw new Error('dave@x.test u-dave Dave');
        return { id: userId, displayName: 'Carol Chen', email: 'carol@x.test' };
      });
      const labels = await memberLabels(
        bus,
        ctxOf(logs),
        TEAM,
        ['user:u-bob', 'user:u-carol', 'user:u-dave'],
        undefined,
      );
      expect(Object.fromEntries(labels)).toEqual({
        'user:u-bob': TEAMMATE_TEXT,
        'user:u-carol': 'Carol Chen',
        'user:u-dave': TEAMMATE_TEXT,
      });
      const warns = eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT);
      expect(warns).toHaveLength(1);
      expect(warns[0]!.level).toBe('warn');
      expect(warns[0]!.bindings).toMatchObject({ agentId: 'agent-1' });
      expect(typeof warns[0]!.bindings.code).toBe('string');
      const logged = JSON.stringify(logs);
      for (const secret of ['u-bob', 'bob@x.test', 'Bob', 'u-dave', 'dave@x.test', 'Dave', 'u-carol', 'Carol']) {
        expect(logged).not.toContain(secret);
      }
    });

    it("logs the first failure's code", async () => {
      const logs: LoggedEvent[] = [];
      const { bus } = authBus(() => {
        throw new PluginError({ code: 'store-unavailable', plugin: 'x', message: 'bob@x.test' });
      });
      await memberLabels(bus, ctxOf(logs), TEAM, ['user:u-bob'], undefined);
      expect(eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT)[0]!.bindings).toMatchObject({
        agentId: 'agent-1',
        code: 'store-unavailable',
      });
    });

    it('a logger that throws does not throw out', async () => {
      const throwing: Logger = {
        debug: () => {},
        info: () => {},
        warn: () => {
          throw new Error('logger down');
        },
        error: () => {},
        child: () => throwing,
      };
      const { bus } = authBus(() => {
        throw new Error('auth down');
      });
      const labels = await memberLabels(bus, ctxOf([], { logger: throwing }), TEAM, ['user:u-bob'], undefined);
      expect([...labels]).toEqual([['user:u-bob', TEAMMATE_TEXT]]);
    });

    it('never throws on a subject that is not a string', async () => {
      const { bus, asked } = authBus(named);
      const labels = await memberLabels(bus, ctxOf([]), TEAM, [42 as unknown as string, 'user:u-bob'], undefined);
      expect([...labels]).toEqual([['user:u-bob', 'Bob Smith']]);
      expect(asked).toEqual(['u-bob']);
    });

    // Names follow the recall rule: a team agent's turn from a source this
    // build doesn't know reads shared rows only (it fails closed), so it is
    // told no names either. Its members still never read as a raw id.
    it("asks nobody in a turn from a source this build doesn't know, on a team agent", async () => {
      const logs: LoggedEvent[] = [];
      const { bus, asked } = authBus(named);
      for (const audience of ['shared', 'private', undefined] as const) {
        const labels = await memberLabels(
          bus,
          ctxOf(logs, { source: 'satellite' as AgentContextSource, ...(audience !== undefined ? { audience } : {}) }),
          TEAM,
          ['user:u-bob'],
          undefined,
        );
        expect([...labels]).toEqual([['user:u-bob', TEAMMATE_TEXT]]);
      }
      expect(asked).toEqual([]);
    });

    it.each([
      ['an outsider', 'external'],
      ["a member's routine", 'routine'],
      ['a member', 'user'],
    ] as const)("names members in %s's turn on a team agent, in any audience", async (_who, source) => {
      const { bus, asked } = authBus(named);
      for (const audience of ['shared', 'private'] as const) {
        const labels = await memberLabels(bus, ctxOf([], { source, audience }), TEAM, ['user:u-bob'], undefined);
        expect([...labels]).toEqual([['user:u-bob', 'Bob Smith']]);
      }
      expect(asked).toEqual(['u-bob', 'u-bob']);
    });
  });
});

describe('memory:recall names a teammate (TASK-1209)', () => {
  interface Person {
    displayName: string | null;
    email: string;
  }
  const PEOPLE: Record<string, Person> = {
    [ALICE]: { displayName: 'Alice Jones', email: 'alice@x.test' },
    [BOB]: { displayName: 'Bob Smith', email: 'bob@x.test' },
  };

  /** `auth:get-user` as auth answers it: the account, or null for no such account. */
  function authOver(people: Record<string, Person>): (userId: string) => unknown {
    return (userId) => {
      const person = people[userId];
      return person === undefined ? null : { id: userId, ...person, isAdmin: false };
    };
  }

  /** Bob's `lives_in`, Alice's `favorite_color`, and one non-person subject. */
  async function seedTeam(h: MemoryHarness, audience?: 'shared'): Promise<void> {
    const stamp = audience === undefined ? {} : { audience };
    await engineRecord(h.bus, h.ctx({ userId: BOB }), [
      { about: `user:${BOB}`, relation: 'lives_in', value: 'Boston', when: JAN, ownerUserId: BOB, conversationId: 'conv-bob', ...stamp },
    ]);
    await engineRecord(h.bus, h.ctx(), [
      { about: `user:${ALICE}`, relation: 'favorite_color', value: 'teal', when: JAN, ownerUserId: ALICE, conversationId: 'conv-alice', ...stamp },
      { about: 'launch_plan', relation: 'codename', value: 'Nightjar', when: JAN, ownerUserId: ALICE, conversationId: 'conv-alice', ...stamp },
    ]);
  }

  function aboutTexts(out: MemoryRecallOutput): Record<string, string | undefined> {
    return Object.fromEntries(out.statements.map((s) => [s.value, s.aboutText]));
  }

  function recallTool(h: MemoryHarness, ctx: AgentContext, query: string): Promise<string> {
    return h.bus.call<{ input: unknown }, string>(MEMORY_RECALL_TOOL_HOOK, ctx, { input: { query } });
  }

  it("in a member's own turn: the caller is you, a teammate reads by name, a topic by its words", async () => {
    const h = await makeHarness({ agent: TEAM, authUser: authOver(PEOPLE) });
    await seedTeam(h);
    expect(aboutTexts(await h.recall({}, h.ctx()))).toEqual({
      Boston: 'Bob Smith',
      teal: 'you',
      Nightjar: 'launch plan',
    });
    expect(h.authCalls).toEqual([BOB]);
  });

  it('without auth:get-user, a teammate reads "a teammate"', async () => {
    const h = await makeHarness({ agent: TEAM });
    await seedTeam(h);
    expect(aboutTexts(await h.recall({}, h.ctx()))).toEqual({
      Boston: TEAMMATE_TEXT,
      teal: 'you',
      Nightjar: 'launch plan',
    });
  });

  it('a personal agent asks nobody: another key reads "a teammate"', async () => {
    const h = await makeHarness({ authUser: authOver(PEOPLE) });
    await engineRecord(h.bus, h.ctx(), [
      { about: `user:${BOB}`, relation: 'likes', value: 'tea', when: JAN, ownerUserId: ALICE },
    ]);
    expect(aboutTexts(await h.recall({}, h.ctx()))).toEqual({ tea: TEAMMATE_TEXT });
    expect(await recallTool(h, h.ctx(), 'tea')).toContain('a teammate likes: tea');
    expect(h.authCalls).toEqual([]);
  });

  it("in an outsider's turn the requester reads by their name, never you", async () => {
    const h = await makeHarness({ agent: TEAM, authUser: authOver(PEOPLE) });
    await seedTeam(h);
    const outsider = h.ctx({ conversationId: CHANNEL, source: 'external', audience: 'shared' });
    const out = await h.recall({}, outsider);
    expect(aboutTexts(out)).toEqual({ Boston: 'Bob Smith', teal: 'Alice Jones', Nightjar: 'launch plan' });
    expect([...h.authCalls].sort()).toEqual([ALICE, BOB].sort());
    const tool = await recallTool(h, outsider, 'teal');
    expect(tool).toContain('Alice Jones favorite color: teal');
    expect(tool).not.toContain('| user favorite color');
  });

  it('a teammate whose name reads as "you" reads "a teammate"', async () => {
    const h = await makeHarness({
      agent: TEAM,
      authUser: authOver({ ...PEOPLE, [BOB]: { displayName: 'You', email: 'bob@x.test' } }),
    });
    await seedTeam(h);
    const aliceTurn = h.ctx();
    expect(aboutTexts(await h.recall({}, aliceTurn)).Boston).toBe(TEAMMATE_TEXT);
    const tool = await recallTool(h, aliceTurn, 'Boston');
    expect(tool).toContain('a teammate lives in: Boston');
    expect(tool).not.toContain('user lives in: Boston');
  });

  it("the memory_recall tool names a teammate's fact", async () => {
    const h = await makeHarness({ agent: TEAM, authUser: authOver(PEOPLE) });
    await seedTeam(h);
    const tool = await recallTool(h, h.ctx(), 'Boston');
    expect(tool).toContain('Bob Smith lives in: Boston');
    expect(tool).not.toContain(BOB);
  });

  it('never shows an email, even when auth has no name to give', async () => {
    const h = await makeHarness({
      agent: TEAM,
      authUser: authOver({ ...PEOPLE, [BOB]: { displayName: null, email: 'bob@x.test' } }),
    });
    await seedTeam(h);
    const aliceTurn = h.ctx();
    const out = await h.recall({}, aliceTurn);
    expect(aboutTexts(out).Boston).toBe(TEAMMATE_TEXT);
    expect(JSON.stringify(out)).not.toContain('bob@x.test');
    expect(await recallTool(h, aliceTurn, 'Boston')).not.toContain('bob@x.test');
    expect(JSON.stringify(h.logs)).not.toContain('bob@x.test');
  });

  it('a lookup that throws still answers the recall; the log names no account', async () => {
    const h = await makeHarness({
      agent: TEAM,
      authUser: (userId) => {
        throw new PluginError({
          code: 'store-unavailable',
          plugin: '@ax/test-auth',
          message: `no answer for ${userId} (bob@x.test, Bob Smith)`,
        });
      },
    });
    await seedTeam(h);
    expect(aboutTexts(await h.recall({}, h.ctx()))).toEqual({
      Boston: TEAMMATE_TEXT,
      teal: 'you',
      Nightjar: 'launch plan',
    });
    const warns = eventsNamed(h.logs, MEMBER_NAMES_FAILED_EVENT);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.bindings).toMatchObject({ code: 'store-unavailable' });
    const logged = JSON.stringify(h.logs);
    for (const secret of [BOB, 'bob@x.test', 'Bob Smith']) expect(logged).not.toContain(secret);
  });

  // TASK-1209's fail-closed rule: a team agent's turn from a source this build
  // doesn't know recalls shared rows only, and is told no names either. Its
  // members, the requester included, read "a teammate": never a name, never
  // "you", never a raw id.
  it("a turn from a source this build doesn't know is told no names on a team agent", async () => {
    const h = await makeHarness({ agent: TEAM, authUser: authOver(PEOPLE) });
    await seedTeam(h, 'shared');
    const unknown = h.ctx({ conversationId: CHANNEL, source: 'satellite' as AgentContextSource, audience: 'shared' });
    const out = await h.recall({}, unknown);
    expect(aboutTexts(out)).toEqual({ Boston: TEAMMATE_TEXT, teal: TEAMMATE_TEXT, Nightjar: 'launch plan' });
    const tool = await recallTool(h, unknown, 'Boston');
    expect(tool).toContain('a teammate lives in: Boston');
    for (const text of [JSON.stringify(out), tool]) {
      expect(text).not.toContain('Bob Smith');
      expect(text).not.toContain('Alice Jones');
    }
    expect(h.authCalls).toEqual([]);
  });
});
