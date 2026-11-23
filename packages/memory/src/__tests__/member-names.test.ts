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
  TEAMS_IS_MEMBER_HOOK,
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

/** A team agent, for the harness (whose `agents:resolve` says it belongs to `TEAM_ID`). */
const TEAM_AGENT = { visibility: 'team' } as const;
/** The team that owns the agent in the unit tests below, and who is in it now. */
const UNIT_TEAM = 'team-unit';
const UNIT_MEMBERS = new Set(['u-alice', 'u-bob', 'u-carol', 'u-dave']);
/** A team agent's access, as `resolveMemoryAccess` answers it. */
const TEAM = { visibility: 'team', teamId: UNIT_TEAM } as const;
const PERSONAL = { visibility: 'personal' } as const;
const JAN = '2026-01-15T00:00:00.000Z';
const CHANNEL = 'conv-channel';
/** An account auth knows, who is not on the agent's team. */
const EVE = 'user-eve';

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
    type IsMember = (input: { teamId: string; userId: string }) => unknown;
    const onTheTeam: IsMember = ({ teamId, userId }) => ({ member: teamId === UNIT_TEAM && UNIT_MEMBERS.has(userId) });

    /**
     * A bare bus with `auth:get-user` answering `answer`, and `teams:is-member`
     * answering `isMember` (by default: `UNIT_MEMBERS` are on `UNIT_TEAM`), or
     * no such service with `false`. `asked` and `memberAsked` are the ids each
     * was asked about.
     */
    function authBus(
      answer: (userId: string) => unknown,
      isMember: IsMember | false = onTheTeam,
    ): { bus: HookBus; asked: string[]; memberAsked: string[] } {
      const bus = new HookBus();
      const asked: string[] = [];
      const memberAsked: string[] = [];
      bus.registerService<{ userId: string }, unknown>(AUTH_GET_USER_HOOK, '@ax/test-auth', async (_ctx, input) => {
        asked.push(input.userId);
        return answer(input.userId);
      });
      if (isMember !== false) {
        bus.registerService<{ teamId: string; userId: string }, unknown>(
          TEAMS_IS_MEMBER_HOOK,
          '@ax/test-teams',
          async (_ctx, input) => {
            memberAsked.push(input.userId);
            return isMember(input);
          },
        );
      }
      return { bus, asked, memberAsked };
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
      ({
        'u-bob': { id: 'u-bob', displayName: 'Bob Smith', email: 'bob@x.test', isAdmin: false },
        'u-eve': { id: 'u-eve', displayName: 'Eve Example', email: 'eve@x.test', isAdmin: false },
      })[userId] ?? null;

    it('asks nobody on a personal agent', async () => {
      const logs: LoggedEvent[] = [];
      const { bus, asked, memberAsked } = authBus(named);
      const labels = await memberLabels(bus, ctxOf(logs), PERSONAL, ['user:u-bob', 'user:u-carol'], 'user:u-alice');
      expect([...labels]).toEqual([]);
      expect(asked).toEqual([]);
      expect(memberAsked).toEqual([]);
    });

    it("on a team agent, asks once per other member and names only member keys", async () => {
      const logs: LoggedEvent[] = [];
      const { bus, asked, memberAsked } = authBus(named);
      const labels = await memberLabels(
        bus,
        ctxOf(logs),
        TEAM,
        ['user:u-bob', 'user:u-bob', 'user:u-alice', 'acme_corp', 'user'],
        'user:u-alice',
      );
      expect(memberAsked).toEqual(['u-bob']);
      expect(asked).toEqual(['u-bob']);
      expect([...labels]).toEqual([['user:u-bob', 'Bob Smith']]);
      expect(logs).toEqual([]);
    });

    // TASK-1209's security review: a subject is model output, so `user:<id>`
    // can name any account, and auth answers for any account. Only a proven
    // current member of the agent's own team is looked up.
    it("never asks auth about an account that isn't on the agent's team", async () => {
      const logs: LoggedEvent[] = [];
      const teams: string[] = [];
      const { bus, asked, memberAsked } = authBus(named, (input) => {
        teams.push(input.teamId);
        return onTheTeam(input);
      });
      const labels = await memberLabels(bus, ctxOf(logs), TEAM, ['user:u-eve', 'user:u-bob'], undefined);
      expect(Object.fromEntries(labels)).toEqual({ 'user:u-eve': TEAMMATE_TEXT, 'user:u-bob': 'Bob Smith' });
      expect([...memberAsked].sort()).toEqual(['u-bob', 'u-eve']);
      expect(teams).toEqual([UNIT_TEAM, UNIT_TEAM]);
      expect(asked).toEqual(['u-bob']);
      expect(logs).toEqual([]);
    });

    it('without teams:is-member, nobody is proven a member: auth is never asked', async () => {
      const logs: LoggedEvent[] = [];
      const { bus, asked } = authBus(named, false);
      const labels = await memberLabels(bus, ctxOf(logs), TEAM, ['user:u-bob', 'user:u-eve'], undefined);
      expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': TEAMMATE_TEXT, 'user:u-eve': TEAMMATE_TEXT });
      expect(asked).toEqual([]);
      expect(logs).toEqual([]);
    });

    it('a team agent whose team is unknown names nobody', async () => {
      const { bus, asked, memberAsked } = authBus(named);
      for (const access of [{ visibility: 'team' }, { visibility: 'team', teamId: '' }] as const) {
        const labels = await memberLabels(bus, ctxOf([]), access, ['user:u-bob'], undefined);
        expect([...labels]).toEqual([['user:u-bob', TEAMMATE_TEXT]]);
      }
      expect(memberAsked).toEqual([]);
      expect(asked).toEqual([]);
    });

    it.each([
      ['null', null],
      ['an array', []],
      ['no member field', {}],
      ['the string "true"', { member: 'true' }],
      ['the number 1', { member: 1 }],
      ['not an object', 'yes'],
    ])('a membership answer of %s is no proof: auth is never asked', async (_label, answer) => {
      const logs: LoggedEvent[] = [];
      const { bus, asked } = authBus(named, () => answer);
      const labels = await memberLabels(bus, ctxOf(logs), TEAM, ['user:u-bob'], undefined);
      expect([...labels]).toEqual([['user:u-bob', TEAMMATE_TEXT]]);
      expect(asked).toEqual([]);
      expect(logs).toEqual([]);
    });

    it('a membership check that throws: that id is never looked up; one warn, by code only', async () => {
      const logs: LoggedEvent[] = [];
      const { bus, asked } = authBus(
        (userId) => ({ id: userId, displayName: 'Carol Chen', email: 'carol@x.test' }),
        (input) => {
          if (input.userId === 'u-bob') {
            throw new PluginError({ code: 'store-unavailable', plugin: 'x', message: 'u-bob bob@x.test Bob' });
          }
          return onTheTeam(input);
        },
      );
      const labels = await memberLabels(bus, ctxOf(logs), TEAM, ['user:u-bob', 'user:u-carol'], undefined);
      expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': TEAMMATE_TEXT, 'user:u-carol': 'Carol Chen' });
      expect(asked).toEqual(['u-carol']);
      const warns = eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT);
      expect(warns).toHaveLength(1);
      expect(warns[0]!.bindings).toMatchObject({
        agentId: 'agent-1',
        hook: TEAMS_IS_MEMBER_HOOK,
        code: 'store-unavailable',
      });
      const logged = JSON.stringify(logs);
      for (const secret of ['u-bob', 'bob@x.test', 'Bob', 'u-carol', 'Carol']) expect(logged).not.toContain(secret);
    });

    it('membership down for everyone: auth is never asked, and one warn', async () => {
      const logs: LoggedEvent[] = [];
      const { bus, asked } = authBus(named, () => {
        throw new Error('teams down');
      });
      const labels = await memberLabels(bus, ctxOf(logs), TEAM, ['user:u-bob', 'user:u-carol'], undefined);
      expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': TEAMMATE_TEXT, 'user:u-carol': TEAMMATE_TEXT });
      expect(asked).toEqual([]);
      expect(eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT)).toHaveLength(1);
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
        hook: AUTH_GET_USER_HOOK,
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

    // Review: a member can rename themself to a teammate's name. Two
    // different members who would read the same in one answer read "a
    // teammate", both of them, so neither's facts pass for the other's. Same
    // means the same whole name word by word (`nameWords`), as the reserved
    // check compares: case, spacing and punctuation don't tell names apart.
    it('two members whose names read the same both read "a teammate"; the others keep their names', async () => {
      const logs: LoggedEvent[] = [];
      const { bus } = authBus(
        (userId) =>
          ({
            'u-bob': { id: 'u-bob', displayName: 'Bob Smith' },
            'u-carol': { id: 'u-carol', displayName: '  bob   SMITH. ' },
            'u-dave': { id: 'u-dave', displayName: 'Dave' },
          })[userId] ?? null,
      );
      const labels = await memberLabels(
        bus,
        ctxOf(logs),
        TEAM,
        ['user:u-bob', 'user:u-carol', 'user:u-dave', 'user:u-bob'],
        undefined,
      );
      expect(Object.fromEntries(labels)).toEqual({
        'user:u-bob': TEAMMATE_TEXT,
        'user:u-carol': TEAMMATE_TEXT,
        'user:u-dave': 'Dave',
      });
      expect(logs).toEqual([]);
    });

    it("a member's name that only contains another's is still a name", async () => {
      const { bus } = authBus(
        (userId) =>
          ({
            'u-bob': { id: 'u-bob', displayName: 'Bob' },
            'u-carol': { id: 'u-carol', displayName: 'Bob Smith' },
          })[userId] ?? null,
      );
      const labels = await memberLabels(bus, ctxOf([]), TEAM, ['user:u-bob', 'user:u-carol'], undefined);
      expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': 'Bob', 'user:u-carol': 'Bob Smith' });
    });

    // DOCUMENTED RESIDUAL (round-2 review), pinned so a change is deliberate:
    // the duplicate-name check sees only the keys in ONE answer. Bob renamed
    // "Carol Chen" reads as "Carol Chen" wherever Carol's rows aren't in the
    // same answer. A team-wide check needs a member list, which
    // `teams:list-members` gives only admins (follow-up).
    it("DOCUMENTED RESIDUAL: a member renamed to a teammate's name reads as it when the teammate's rows are not in the same answer", async () => {
      const { bus, asked } = authBus(
        (userId) =>
          ({
            'u-bob': { id: 'u-bob', displayName: 'Carol Chen' },
            'u-carol': { id: 'u-carol', displayName: 'Carol Chen' },
          })[userId] ?? null,
      );
      // Only Bob's row is in this answer: nothing to collide with.
      const alone = await memberLabels(bus, ctxOf([]), TEAM, ['user:u-bob'], undefined);
      expect(Object.fromEntries(alone)).toEqual({ 'user:u-bob': 'Carol Chen' });
      expect(asked).toEqual(['u-bob']);
      // The same two members in one answer do collide: that is the per-answer check.
      const together = await memberLabels(bus, ctxOf([]), TEAM, ['user:u-bob', 'user:u-carol'], undefined);
      expect(Object.fromEntries(together)).toEqual({ 'user:u-bob': TEAMMATE_TEXT, 'user:u-carol': TEAMMATE_TEXT });
    });

    // DOCUMENTED RESIDUAL (round-2 review): `self` is never looked up, so the
    // caller's own name never enters the collision set. In Alice's turn, Bob
    // renamed "Alice Jones" reads "Alice Jones" beside Alice's rows, which the
    // surfaces show as `you` (follow-up: count the caller's name as a holder).
    it("DOCUMENTED RESIDUAL: the caller's own name is not a holder, so a member renamed to it reads as it", async () => {
      const { bus, asked, memberAsked } = authBus(
        (userId) =>
          ({
            'u-alice': { id: 'u-alice', displayName: 'Alice Jones' },
            'u-bob': { id: 'u-bob', displayName: 'Alice Jones' },
          })[userId] ?? null,
      );
      const labels = await memberLabels(bus, ctxOf([]), TEAM, ['user:u-alice', 'user:u-bob'], 'user:u-alice');
      // Alice's key holds no label (it reads `you` where it is shown) and was never looked up.
      expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': 'Alice Jones' });
      expect(asked).toEqual(['u-bob']);
      expect(memberAsked).toEqual(['u-bob']);
    });

    it('never throws on a subject that is not a string', async () => {
      const { bus, asked } = authBus(named);
      const labels = await memberLabels(bus, ctxOf([]), TEAM, [42 as unknown as string, 'user:u-bob'], undefined);
      expect([...labels]).toEqual([['user:u-bob', 'Bob Smith']]);
      expect(asked).toEqual(['u-bob']);
    });

    // Names follow the recall rule: a team agent's turn from a source this
    // build doesn't know reads shared rows only (it fails closed), so it is
    // told no names either. Its members still never read as a raw id. That
    // is one outside the type, and a stored one the session store and IPC
    // read back as `'unrecognized'` (TASK-1213).
    it.each(['satellite', 'unrecognized'])("asks nobody in a turn from a source this build doesn't know (%j), on a team agent", async (source) => {
      const logs: LoggedEvent[] = [];
      const { bus, asked, memberAsked } = authBus(named);
      for (const audience of ['shared', 'private', undefined] as const) {
        const labels = await memberLabels(
          bus,
          ctxOf(logs, { source: source as AgentContextSource, ...(audience !== undefined ? { audience } : {}) }),
          TEAM,
          ['user:u-bob'],
          undefined,
        );
        expect([...labels]).toEqual([['user:u-bob', TEAMMATE_TEXT]]);
      }
      expect(memberAsked).toEqual([]);
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
    const h = await makeHarness({ agent: TEAM_AGENT, authUser: authOver(PEOPLE) });
    await seedTeam(h);
    expect(aboutTexts(await h.recall({}, h.ctx()))).toEqual({
      Boston: 'Bob Smith',
      teal: 'you',
      Nightjar: 'launch plan',
    });
    expect(h.memberCalls).toEqual([BOB]);
    expect(h.authCalls).toEqual([BOB]);
  });

  it('without auth:get-user, a teammate reads "a teammate"', async () => {
    const h = await makeHarness({ agent: TEAM_AGENT });
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
    expect(h.memberCalls).toEqual([]);
    expect(h.authCalls).toEqual([]);
  });

  it("in an outsider's turn the requester reads by their name, never you", async () => {
    const h = await makeHarness({ agent: TEAM_AGENT, authUser: authOver(PEOPLE) });
    await seedTeam(h);
    const outsider = h.ctx({ conversationId: CHANNEL, source: 'external', audience: 'shared' });
    const out = await h.recall({}, outsider);
    expect(aboutTexts(out)).toEqual({ Boston: 'Bob Smith', teal: 'Alice Jones', Nightjar: 'launch plan' });
    expect([...h.memberCalls].sort()).toEqual([ALICE, BOB].sort());
    expect([...h.authCalls].sort()).toEqual([ALICE, BOB].sort());
    const tool = await recallTool(h, outsider, 'teal');
    expect(tool).toContain('Alice Jones favorite color: teal');
    expect(tool).not.toContain('| user favorite color');
  });

  it('a teammate whose name reads as "you" reads "a teammate"', async () => {
    const h = await makeHarness({
      agent: TEAM_AGENT,
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
    const h = await makeHarness({ agent: TEAM_AGENT, authUser: authOver(PEOPLE) });
    await seedTeam(h);
    const tool = await recallTool(h, h.ctx(), 'Boston');
    expect(tool).toContain('Bob Smith lives in: Boston');
    expect(tool).not.toContain(BOB);
  });

  it('never shows an email, even when auth has no name to give', async () => {
    const h = await makeHarness({
      agent: TEAM_AGENT,
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
      agent: TEAM_AGENT,
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
    const h = await makeHarness({ agent: TEAM_AGENT, authUser: authOver(PEOPLE) });
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
    expect(h.memberCalls).toEqual([]);
    expect(h.authCalls).toEqual([]);
  });

  // TASK-1209's security review: a stored subject is model output, so
  // `user:<id>` can name any account, and auth answers for any account. Only
  // a current member of the agent's own team is ever looked up.
  describe('only a current member of the team is named', () => {
    const WITH_EVE: Record<string, Person> = {
      ...PEOPLE,
      [EVE]: { displayName: 'Eve Example', email: 'eve@x.test' },
    };

    /** A fact filed under an account outside the team, as a member's private turn keeps it. */
    async function seedOutsideKey(h: MemoryHarness): Promise<void> {
      await engineRecord(h.bus, h.ctx(), [
        { about: `user:${EVE}`, relation: 'lives_in', value: 'Paris', when: JAN, ownerUserId: ALICE, conversationId: 'conv-alice' },
      ]);
    }

    it("a key for an account that isn't on the team reads \"a teammate\", and auth is never asked about it", async () => {
      const h = await makeHarness({ agent: TEAM_AGENT, authUser: authOver(WITH_EVE) });
      await seedTeam(h);
      await seedOutsideKey(h);
      const aliceTurn = h.ctx();
      const outsider = h.ctx({ conversationId: CHANNEL, source: 'external', audience: 'shared' });
      for (const ctx of [aliceTurn, outsider]) {
        const out = await h.recall({}, ctx);
        expect(aboutTexts(out).Paris).toBe(TEAMMATE_TEXT);
        expect(aboutTexts(out).Boston).toBe('Bob Smith');
        const tool = await recallTool(h, ctx, 'Paris');
        expect(tool).toContain('a teammate lives in: Paris');
        for (const text of [JSON.stringify(out), tool]) expect(text).not.toContain('Eve Example');
      }
      expect(h.memberCalls).toContain(EVE);
      expect(h.authCalls).not.toContain(EVE);
      expect(h.authCalls).toContain(BOB);
    });

    it('a member who has left the team is no longer named', async () => {
      const h = await makeHarness({ agent: TEAM_AGENT, authUser: authOver(PEOPLE) });
      await seedTeam(h);
      h.teamMembers.delete(BOB);
      expect(aboutTexts(await h.recall({}, h.ctx())).Boston).toBe(TEAMMATE_TEXT);
      expect(h.memberCalls).toEqual([BOB]);
      expect(h.authCalls).toEqual([]);
    });

    it('without teams:is-member nobody is named, auth is never asked, and the recall answers', async () => {
      const h = await makeHarness({ agent: TEAM_AGENT, authUser: authOver(PEOPLE), teamsIsMember: false });
      await seedTeam(h);
      expect(aboutTexts(await h.recall({}, h.ctx()))).toEqual({
        Boston: TEAMMATE_TEXT,
        teal: 'you',
        Nightjar: 'launch plan',
      });
      expect(await recallTool(h, h.ctx(), 'Boston')).toContain('a teammate lives in: Boston');
      expect(h.authCalls).toEqual([]);
      expect(eventsNamed(h.logs, MEMBER_NAMES_FAILED_EVENT)).toEqual([]);
    });

    it('a membership check that throws: auth is never asked, the recall answers, the log names no account', async () => {
      const h = await makeHarness({
        agent: TEAM_AGENT,
        authUser: authOver(PEOPLE),
        teamsIsMember: ({ userId }) => {
          throw new PluginError({
            code: 'store-unavailable',
            plugin: '@ax/test-teams',
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
      expect(h.authCalls).toEqual([]);
      const warns = eventsNamed(h.logs, MEMBER_NAMES_FAILED_EVENT);
      expect(warns).toHaveLength(1);
      expect(warns[0]!.bindings).toMatchObject({ hook: TEAMS_IS_MEMBER_HOOK, code: 'store-unavailable' });
      const logged = JSON.stringify(h.logs);
      for (const secret of [BOB, 'bob@x.test', 'Bob Smith']) expect(logged).not.toContain(secret);
    });
  });
});
