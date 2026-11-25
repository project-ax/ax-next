import {
  HookBus,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type AgentContextAudience,
  type AgentContextSource,
  type Logger,
} from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AGENTS_RESOLVE_HOOK, resolveMemoryAccess, type MemoryAccess } from '../access.js';
import {
  AUTH_GET_USER_HOOK,
  MEMBER_NAME_MAX,
  MEMBER_NAMES_DEADLINE_MS,
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
  registerMemoryAgents,
  TEAM_ID,
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

    it.each(['You Li', 'Agent Smith', 'Ian Assistant', 'Userton', 'Mei', 'Teammate Tina'])(
      'keeps %j: a name that only contains one of those words is still a name',
      (raw) => {
        expect(memberName(raw)).toBe(raw);
      },
    );

    // TASK-1213: "a teammate" is what memory shows for a member it can't
    // name. A member named that would pass for the fallback, so the reader
    // couldn't tell a name from no name.
    it.each(['a teammate', 'A Teammate', 'a-teammate', 'A  TEAMMATE.', 'ａ ｔｅａｍｍａｔｅ'])(
      '%j is refused: it reads like "a teammate"',
      (raw) => {
        expect(memberName(raw)).toBeUndefined();
      },
    );

    // TASK-1213: a member named like the agent would put their facts in the
    // agent's own mouth. Compared word by word, as the reserved check is.
    it.each([
      ['Fern', 'Fern'],
      ['fern.', 'Fern'],
      ['ＦＥＲＮ', 'Fern'],
      ['  FERN  ', 'Fern'],
      ['Fern', '  fern '],
    ])('%j is refused on an agent named %j: it reads as the agent', (raw, agent) => {
      expect(memberName(raw, agent)).toBeUndefined();
    });

    it.each([
      ['Fern Li', 'Fern'],
      ['Ferns', 'Fern'],
    ])('%j stays a name on an agent named %j', (raw, agent) => {
      expect(memberName(raw, agent)).toBe(raw);
    });

    it('an agent name with no letter or digit refuses nothing by itself', () => {
      expect(memberName('Bob', '\u{1F916}')).toBe('Bob');
    });

    // An agent's name may run to 128 characters, and a member's is shown cut
    // to MEMBER_NAME_MAX. A member who copies a long agent name would be
    // shown as its first 80 units: still the agent's name to a reader.
    it(`a member who copies an agent name longer than ${MEMBER_NAME_MAX} units is refused`, () => {
      const agent = 'Fern, the team helper who answers every question about the launch plan and its dates';
      expect(agent.length).toBeGreaterThan(MEMBER_NAME_MAX);
      expect(memberName(agent, agent)).toBeUndefined();
      expect(memberName(` ${agent.toUpperCase()}. `, agent)).toBeUndefined();
      // The agent's name as written still decides on its own words.
      expect(memberName('Fern', agent)).toBe('Fern');
    });

    // And as written: a zero-width space inside the agent's name draws
    // nothing wherever that name is shown, so a member named `Fern` still
    // reads as an agent named Fe<ZWSP>rn. (Cleaned the way a member's name
    // is, the agent's name would read `Fe rn`, and `Fern` would pass.)
    it("an invisible character inside the agent's name hides nothing", () => {
      expect(memberName('Fern', 'Fe​rn')).toBeUndefined();
      expect(memberName('fern.', 'Fe​rn')).toBeUndefined();
    });
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
        'u-alice': { id: 'u-alice', displayName: 'Alice Jones', email: 'alice@x.test', isAdmin: false },
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

    // TASK-1213: the caller is asked too, once, but only to count their name
    // in the collision check. Their key never holds a label, even with a name
    // nobody else holds: it reads `you` wherever it is shown.
    it('asks once per member on the page, and the caller to count; names only other member keys', async () => {
      const logs: LoggedEvent[] = [];
      const { bus, asked, memberAsked } = authBus(named);
      const labels = await memberLabels(
        bus,
        ctxOf(logs),
        TEAM,
        ['user:u-bob', 'user:u-bob', 'user:u-alice', 'acme_corp', 'user'],
        'user:u-alice',
      );
      expect([...memberAsked].sort()).toEqual(['u-alice', 'u-bob']);
      expect([...asked].sort()).toEqual(['u-alice', 'u-bob']);
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

    // TASK-1213: memory reads the agent's own name from `agents:resolve`
    // (`MemoryAccess.agentName`), and a member who takes it reads "a
    // teammate", like any reserved name. The others keep theirs.
    it("a member who calls themself the agent's name reads \"a teammate\"", async () => {
      const logs: LoggedEvent[] = [];
      const { bus, asked } = authBus(
        (userId) =>
          ({
            'u-bob': { id: 'u-bob', displayName: 'fern' },
            'u-carol': { id: 'u-carol', displayName: 'Carol Chen' },
          })[userId] ?? null,
      );
      const labels = await memberLabels(
        bus,
        ctxOf(logs),
        { ...TEAM, agentName: 'Fern' },
        ['user:u-bob', 'user:u-carol'],
        undefined,
      );
      expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': TEAMMATE_TEXT, 'user:u-carol': 'Carol Chen' });
      expect([...asked].sort()).toEqual(['u-bob', 'u-carol']);
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

    // TASK-1213 (was a documented residual): the caller's own name is a
    // holder. In Alice's turn, Bob renamed "Alice Jones" would pass for her
    // beside her own rows, which the surfaces show as `you`. So he reads "a
    // teammate", compared word by word, as any two members are.
    it("the caller's own name is a holder: a member renamed to it reads \"a teammate\" in the caller's turn", async () => {
      const logs: LoggedEvent[] = [];
      const { bus } = authBus(
        (userId) =>
          ({
            'u-alice': { id: 'u-alice', displayName: 'Alice Jones' },
            'u-bob': { id: 'u-bob', displayName: 'alice  jones.' },
            'u-carol': { id: 'u-carol', displayName: 'Carol Chen' },
          })[userId] ?? null,
      );
      const labels = await memberLabels(
        bus,
        ctxOf(logs),
        TEAM,
        ['user:u-alice', 'user:u-bob', 'user:u-carol'],
        'user:u-alice',
      );
      expect(labels.get('user:u-bob')).toBe(TEAMMATE_TEXT);
      expect(labels.get('user:u-carol')).toBe('Carol Chen');
      // Counted, never shown: Alice's key reads `you` wherever it is shown.
      expect(labels.has('user:u-alice')).toBe(false);
      expect(logs).toEqual([]);
    });

    it("the caller's name counts even when none of the caller's own rows is on the page", async () => {
      const { bus } = authBus(
        (userId) =>
          ({
            'u-alice': { id: 'u-alice', displayName: 'Alice Jones' },
            'u-bob': { id: 'u-bob', displayName: 'Alice Jones' },
          })[userId] ?? null,
      );
      const labels = await memberLabels(bus, ctxOf([]), TEAM, ['user:u-bob'], 'user:u-alice');
      expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': TEAMMATE_TEXT });
    });

    // Nothing else on the page, nothing to collide with: nobody is asked.
    it('the caller is asked only when another member key is on the page', async () => {
      const logs: LoggedEvent[] = [];
      const { bus, asked, memberAsked } = authBus(named);
      const labels = await memberLabels(bus, ctxOf(logs), TEAM, ['user:u-alice', 'launch_plan'], 'user:u-alice');
      expect([...labels]).toEqual([]);
      expect(memberAsked).toEqual([]);
      expect(asked).toEqual([]);
      expect(logs).toEqual([]);
    });

    // TASK-1209 row 35's per-id rule holds for the caller too: a lookup that
    // fails leaves that one name out, and every other name stands.
    it('a caller whose own lookup throws: the others keep their names; one warn', async () => {
      const logs: LoggedEvent[] = [];
      const { bus, asked } = authBus((userId) => {
        if (userId === 'u-alice') {
          throw new PluginError({ code: 'store-unavailable', plugin: 'x', message: 'u-alice alice@x.test Alice' });
        }
        return named(userId);
      });
      const labels = await memberLabels(bus, ctxOf(logs), TEAM, ['user:u-alice', 'user:u-bob'], 'user:u-alice');
      expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': 'Bob Smith' });
      expect([...asked].sort()).toEqual(['u-alice', 'u-bob']);
      const warns = eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT);
      expect(warns).toHaveLength(1);
      expect(warns[0]!.bindings).toMatchObject({ agentId: 'agent-1', hook: AUTH_GET_USER_HOOK, code: 'store-unavailable' });
      const logged = JSON.stringify(logs);
      for (const secret of ['u-alice', 'alice@x.test', 'Alice', 'u-bob', 'Bob']) expect(logged).not.toContain(secret);
    });

    it('the caller goes through the same membership check: not answered a member, never asked by name', async () => {
      const { bus, asked, memberAsked } = authBus(named, (input) =>
        input.userId === 'u-alice' ? { member: false } : onTheTeam(input),
      );
      const labels = await memberLabels(bus, ctxOf([]), TEAM, ['user:u-bob'], 'user:u-alice');
      expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': 'Bob Smith' });
      expect([...memberAsked].sort()).toEqual(['u-alice', 'u-bob']);
      expect(asked).toEqual(['u-bob']);
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

    // TASK-1213: a stalled lookup can't hold up a recall, the block or an
    // export. The whole round races one timer, and a round that loses names
    // nobody: a partial set of names can't be checked for collisions. The
    // stalled tests carry a 2 s test timeout so a missing deadline fails fast.
    describe('the deadline (TASK-1213)', () => {
      const never = (): Promise<never> => new Promise<never>(() => {});
      const SHORT = { deadlineMs: 20 } as const;

      it(
        'a membership check that never answers: every member reads "a teammate" by the deadline; one warn, code timeout, hook teams:is-member',
        async () => {
          const logs: LoggedEvent[] = [];
          const { bus, asked } = authBus(named, never);
          const labels = await memberLabels(bus, ctxOf(logs), TEAM, ['user:u-bob', 'user:u-carol'], undefined, SHORT);
          expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': TEAMMATE_TEXT, 'user:u-carol': TEAMMATE_TEXT });
          expect(asked).toEqual([]);
          const warns = eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT);
          expect(warns).toHaveLength(1);
          expect(warns[0]!.level).toBe('warn');
          expect(warns[0]!.bindings).toMatchObject({ agentId: 'agent-1', hook: TEAMS_IS_MEMBER_HOOK, code: 'timeout' });
          const logged = JSON.stringify(logs);
          for (const secret of ['u-bob', 'u-carol']) expect(logged).not.toContain(secret);
        },
        2_000,
      );

      it(
        'a name lookup that never answers: nobody is named, not even a member whose name came back in time; hook auth:get-user',
        async () => {
          const logs: LoggedEvent[] = [];
          const { bus, asked } = authBus((userId) => (userId === 'u-carol' ? never() : named(userId)));
          const labels = await memberLabels(bus, ctxOf(logs), TEAM, ['user:u-bob', 'user:u-carol'], undefined, SHORT);
          expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': TEAMMATE_TEXT, 'user:u-carol': TEAMMATE_TEXT });
          expect([...asked].sort()).toEqual(['u-bob', 'u-carol']);
          const warns = eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT);
          expect(warns).toHaveLength(1);
          expect(warns[0]!.bindings).toMatchObject({ agentId: 'agent-1', hook: AUTH_GET_USER_HOOK, code: 'timeout' });
          const logged = JSON.stringify(logs);
          for (const secret of ['u-bob', 'Bob', 'u-carol', 'Carol']) expect(logged).not.toContain(secret);
        },
        2_000,
      );

      it(
        'with a membership check and a name lookup both still out, the warn names the membership hook',
        async () => {
          const logs: LoggedEvent[] = [];
          const { bus } = authBus(
            (userId) => (userId === 'u-carol' ? never() : named(userId)),
            (input) => (input.userId === 'u-bob' ? never() : onTheTeam(input)),
          );
          await memberLabels(bus, ctxOf(logs), TEAM, ['user:u-bob', 'user:u-carol'], undefined, SHORT);
          const warns = eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT);
          expect(warns).toHaveLength(1);
          expect(warns[0]!.bindings).toMatchObject({ hook: TEAMS_IS_MEMBER_HOOK, code: 'timeout' });
        },
        2_000,
      );

      it(
        'a throw before the deadline is not logged as well: the timeout is the call\'s one warn',
        async () => {
          const logs: LoggedEvent[] = [];
          const { bus } = authBus(named, (input) => {
            if (input.userId === 'u-bob') {
              throw new PluginError({ code: 'store-unavailable', plugin: 'x', message: 'u-bob bob@x.test' });
            }
            return never();
          });
          const labels = await memberLabels(bus, ctxOf(logs), TEAM, ['user:u-bob', 'user:u-carol'], undefined, SHORT);
          expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': TEAMMATE_TEXT, 'user:u-carol': TEAMMATE_TEXT });
          const warns = eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT);
          expect(warns).toHaveLength(1);
          expect(warns[0]!.bindings).toMatchObject({ hook: TEAMS_IS_MEMBER_HOOK, code: 'timeout' });
        },
        2_000,
      );

      // Something that WOULD name Bob happens after the deadline: his
      // membership answers, auth is asked, auth answers. The map already
      // returned must not move.
      it(
        'an answer that lands after the deadline changes nothing already returned',
        async () => {
          const logs: LoggedEvent[] = [];
          let answerBob: (value: unknown) => void = () => {};
          const late = new Promise<unknown>((resolve) => {
            answerBob = resolve;
          });
          const { bus, asked } = authBus(named, (input) => (input.userId === 'u-bob' ? late : onTheTeam(input)));
          const labels = await memberLabels(bus, ctxOf(logs), TEAM, ['user:u-bob'], undefined, SHORT);
          expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': TEAMMATE_TEXT });
          expect(asked).toEqual([]);

          answerBob({ member: true });
          await vi.waitFor(() => expect(asked).toEqual(['u-bob']), { interval: 1 });
          await new Promise((resolve) => setImmediate(resolve));

          expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': TEAMMATE_TEXT });
          expect(eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT)).toHaveLength(1);
        },
        2_000,
      );

      it('a round that finishes in time names members as before, with no warn', async () => {
        const logs: LoggedEvent[] = [];
        const { bus } = authBus(named);
        const labels = await memberLabels(bus, ctxOf(logs), TEAM, ['user:u-bob'], 'user:u-alice', { deadlineMs: 1_000 });
        expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': 'Bob Smith' });
        expect(logs).toEqual([]);
      });

      // Only `setTimeout`/`clearTimeout` are faked: the bus and its stubs
      // answer on promises, which stay real.
      it('the deadline is on by default', async () => {
        expect(MEMBER_NAMES_DEADLINE_MS).toBe(2_000);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          const logs: LoggedEvent[] = [];
          const { bus } = authBus(named, never);
          let answer: ReadonlyMap<string, string> | undefined;
          void memberLabels(bus, ctxOf(logs), TEAM, ['user:u-bob'], undefined).then((labels) => {
            answer = labels;
          });
          await vi.advanceTimersByTimeAsync(MEMBER_NAMES_DEADLINE_MS - 1);
          expect(answer).toBeUndefined();
          await vi.advanceTimersByTimeAsync(1);
          await new Promise((resolve) => setImmediate(resolve));
          expect(answer === undefined ? undefined : Object.fromEntries(answer)).toEqual({ 'user:u-bob': TEAMMATE_TEXT });
          expect(eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT)).toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
      });

      // The deadline's timer is cleared the moment the round wins, so a
      // name lookup leaves nothing behind it.
      it('a round that answers in time leaves no timer running', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          const { bus } = authBus(named);
          const labels = await memberLabels(bus, ctxOf([]), TEAM, ['user:u-bob'], undefined);
          expect(Object.fromEntries(labels)).toEqual({ 'user:u-bob': 'Bob Smith' });
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });
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
    // Alice is asked too, only to count her name (TASK-1213).
    expect([...h.memberCalls].sort()).toEqual([ALICE, BOB].sort());
    expect([...h.authCalls].sort()).toEqual([ALICE, BOB].sort());
  });

  // TASK-1213: the caller's own name is a holder, so a teammate who takes it
  // can't pass for the person talking, whose own rows read `you`.
  it("in a member's own turn, a teammate renamed to the caller's name reads \"a teammate\"", async () => {
    const h = await makeHarness({
      agent: TEAM_AGENT,
      authUser: authOver({ ...PEOPLE, [BOB]: { displayName: 'ALICE JONES', email: 'bob@x.test' } }),
    });
    await seedTeam(h);
    const aliceTurn = h.ctx();
    expect(aboutTexts(await h.recall({}, aliceTurn))).toEqual({
      Boston: TEAMMATE_TEXT,
      teal: 'you',
      Nightjar: 'launch plan',
    });
    const tool = await recallTool(h, aliceTurn, 'Boston');
    expect(tool).toContain('a teammate lives in: Boston');
    expect(tool).not.toMatch(/alice jones/i);
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

  // TASK-1213: a member renamed to the agent's own name, in any case or
  // spacing, would read as the agent talking about itself.
  it('a teammate named like the agent reads "a teammate"', async () => {
    const h = await makeHarness({
      agent: { ...TEAM_AGENT, displayName: 'Fern' },
      authUser: authOver({ ...PEOPLE, [BOB]: { displayName: 'fern.', email: 'bob@x.test' } }),
    });
    await seedTeam(h);
    const aliceTurn = h.ctx();
    expect(aboutTexts(await h.recall({}, aliceTurn))).toEqual({
      Boston: TEAMMATE_TEXT,
      teal: 'you',
      Nightjar: 'launch plan',
    });
    const tool = await recallTool(h, aliceTurn, 'Boston');
    expect(tool).toContain('a teammate lives in: Boston');
    expect(tool).not.toContain('fern.');
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
      // Alice, the caller, is still a member: asked by name, only to count it.
      expect([...h.memberCalls].sort()).toEqual([ALICE, BOB].sort());
      expect(h.authCalls).toEqual([ALICE]);
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

describe("the agent's own name (TASK-1213)", () => {
  const aliceCtx = (): AgentContext =>
    makeAgentContext({
      sessionId: 's',
      agentId: 'agent-1',
      userId: ALICE,
      workspace: { rootPath: '/tmp' },
      logger: capturingLogger([]),
    });

  /** `resolveMemoryAccess` over a bare bus whose `agents:resolve` answers as `agent` says. */
  async function accessFor(agent: Parameters<typeof registerMemoryAgents>[1]): Promise<MemoryAccess> {
    const bus = new HookBus();
    registerMemoryAgents(bus, agent);
    return resolveMemoryAccess(bus, aliceCtx());
  }

  // Memory already asks `agents:resolve` before any read, and its answer
  // carries the agent's display name. A team agent keeps it, to refuse a
  // member named like the agent. A personal agent has no teammates to name.
  it("resolveMemoryAccess carries a team agent's display name as agentName; a personal agent carries none", async () => {
    expect(await accessFor({ visibility: 'team', displayName: 'Fern' })).toEqual({
      userId: ALICE,
      visibility: 'team',
      teamId: TEAM_ID,
      agentName: 'Fern',
    });
    // An answer with no display name: nothing to compare with, so none is carried.
    expect(await accessFor({ visibility: 'team' })).toEqual({ userId: ALICE, visibility: 'team', teamId: TEAM_ID });
    expect(await accessFor({ visibility: 'personal', displayName: 'Fern' })).toEqual({
      userId: ALICE,
      visibility: 'personal',
    });
  });
});

// ---------------------------------------------------------------------------
// TASK-1248: a personal agent shared with other people names them the way a
// team agent names its members. Only the proof differs: `agents:resolve` must
// admit the id to THIS agent (the one "can use it" rule), where a team agent
// asks `teams:is-member`. Then `auth:get-user`, cleaned, refused and
// collision-checked the same way, under the same deadline. A refusal, a fault
// or a stall reads "a teammate", and the read still answers.
// ---------------------------------------------------------------------------

describe('memberLabels on a personal agent shared with everyone (TASK-1248)', () => {
  const CAROL = 'user-carol';
  const DAVE = 'user-dave';
  const NAMES: Record<string, string> = {
    [ALICE]: 'Alice Jones',
    [BOB]: 'Bob Smith',
    [CAROL]: 'Carol Chen',
    [DAVE]: 'Dave Diaz',
    [EVE]: 'Eve Example',
  };
  /** That agent's access, as `resolveMemoryAccess` answers it: shared, no team, proven through the agent. */
  const SHARED = { visibility: 'team', memberCheck: 'agent' } as const;

  type ResolveInput = { agentId: string; userId: string };

  /** ALICE's agent, shared with `ids`, as the harness's `agents:resolve` fake answers it. A fresh set each time. */
  function sharedWith(...ids: string[]): NonNullable<MemoryHarnessOptions['agent']> {
    return { visibility: 'personal', shared: true, ownerUserId: ALICE, members: new Set(ids) };
  }

  /** What that fake answers for someone it admits: an answer about the agent asked about. */
  function admitted(input: ResolveInput): unknown {
    return {
      agent: {
        id: input.agentId,
        ownerId: ALICE,
        ownerType: 'user',
        visibility: 'personal',
        shared: true,
        audience: 'everyone',
        isOwner: input.userId === ALICE,
      },
    };
  }

  /** `auth:get-user` as auth answers it, with some display names replaced. */
  function authWith(names: Record<string, unknown> = {}): (userId: string) => unknown {
    return (userId) =>
      NAMES[userId] === undefined
        ? null
        : {
            id: userId,
            displayName: userId in names ? names[userId] : NAMES[userId],
            email: `${userId}@x.test`,
            isAdmin: false,
          };
  }

  /**
   * A bare bus with `agents:resolve` (the harness's fake for ALICE's agent
   * shared with BOB, CAROL and DAVE, or `resolve` in its place),
   * `auth:get-user` answering `answer`, and a `teams:is-member` that would
   * say yes to anyone: if it were ever the proof here, everyone would be
   * named.
   */
  function sharedBus(opts: { resolve?: (input: ResolveInput) => unknown; answer?: (userId: string) => unknown } = {}) {
    const bus = new HookBus();
    const fake = opts.resolve === undefined ? registerMemoryAgents(bus, sharedWith(BOB, CAROL, DAVE)) : undefined;
    const resolveCalls = fake?.resolveCalls ?? [];
    if (opts.resolve !== undefined) {
      const resolve = opts.resolve;
      bus.registerService<ResolveInput, unknown>(AGENTS_RESOLVE_HOOK, '@ax/test-agents', async (_ctx, input) => {
        resolveCalls.push(input.userId);
        return resolve(input);
      });
    }
    const asked: string[] = [];
    const answer = opts.answer ?? authWith();
    bus.registerService<{ userId: string }, unknown>(AUTH_GET_USER_HOOK, '@ax/test-auth', async (_ctx, input) => {
      asked.push(input.userId);
      return answer(input.userId);
    });
    const memberAsked: string[] = [];
    bus.registerService<{ teamId: string; userId: string }, unknown>(
      TEAMS_IS_MEMBER_HOOK,
      '@ax/test-teams',
      async (_ctx, input) => {
        memberAsked.push(input.userId);
        return { member: true };
      },
    );
    return { bus, resolveCalls, asked, memberAsked, setShared: fake?.setShared };
  }

  /** ALICE's turn on `agent-1`. */
  function turn(
    logs: LoggedEvent[],
    opts: { source?: AgentContextSource; audience?: AgentContextAudience; agentId?: string } = {},
  ): AgentContext {
    return makeAgentContext({
      sessionId: 's',
      agentId: opts.agentId ?? 'agent-1',
      userId: ALICE,
      workspace: { rootPath: '/tmp' },
      logger: capturingLogger(logs),
      ...(opts.source !== undefined ? { source: opts.source } : {}),
      ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
    });
  }

  function refusal(code: string, userId: string): PluginError {
    return new PluginError({
      code,
      plugin: '@ax/test-agents',
      hookName: AGENTS_RESOLVE_HOOK,
      message: `agent 'agent-1' not accessible to user '${userId}' (${NAMES[userId] ?? ''})`,
    });
  }

  /** Bob's `lives_in`, Alice's `favorite_color`, and one non-person subject: the team tests' rows, on this agent. */
  async function seed(h: MemoryHarness): Promise<void> {
    await engineRecord(h.bus, h.ctx({ userId: BOB }), [
      { about: `user:${BOB}`, relation: 'lives_in', value: 'Boston', when: JAN, ownerUserId: BOB, conversationId: 'conv-bob' },
    ]);
    await engineRecord(h.bus, h.ctx(), [
      { about: `user:${ALICE}`, relation: 'favorite_color', value: 'teal', when: JAN, ownerUserId: ALICE, conversationId: 'conv-alice' },
      { about: 'launch_plan', relation: 'codename', value: 'Nightjar', when: JAN, ownerUserId: ALICE, conversationId: 'conv-alice' },
    ]);
  }

  function aboutTexts(out: MemoryRecallOutput): Record<string, string | undefined> {
    return Object.fromEntries(out.statements.map((s) => [s.value, s.aboutText]));
  }

  function recallTool(h: MemoryHarness, ctx: AgentContext, query: string): Promise<string> {
    return h.bus.call<{ input: unknown }, string>(MEMORY_RECALL_TOOL_HOOK, ctx, { input: { query } });
  }

  it('names someone the agent is shared with: agents:resolve admits them, then auth:get-user names them', async () => {
    const h = await makeHarness({ agent: sharedWith(BOB), authUser: authWith() });
    await seed(h);
    const aliceTurn = h.ctx();

    expect(aboutTexts(await h.recall({}, aliceTurn))).toEqual({
      Boston: 'Bob Smith',
      teal: 'you',
      Nightjar: 'launch plan',
    });
    // Alice's own access first. Then everyone on the page, asked about this
    // agent: Bob, to be named, and Alice, only to count her name (TASK-1213).
    expect(h.resolveCalls[0]).toBe(ALICE);
    expect(h.resolveCalls.slice(1).sort()).toEqual([ALICE, BOB].sort());
    expect([...h.authCalls].sort()).toEqual([ALICE, BOB].sort());
    // There is no team to ask.
    expect(h.memberCalls).toEqual([]);

    // Bob's own turn names Alice, and he is "you".
    expect(aboutTexts(await h.recall({}, h.ctx({ userId: BOB })))).toEqual({
      Boston: 'you',
      teal: 'Alice Jones',
      Nightjar: 'launch plan',
    });
    const tool = await recallTool(h, aliceTurn, 'Boston');
    expect(tool).toContain('Bob Smith lives in: Boston');
    expect(tool).not.toContain(BOB);
    expect(h.memberCalls).toEqual([]);
  });

  // A stored subject is model output, so `user:<id>` can name any account,
  // and auth answers for any account. Only someone `agents:resolve` lets use
  // this agent is looked up. Eve has an account; the agent isn't shared with her.
  it('someone agents:resolve refuses reads "a teammate", with no auth:get-user call and no warning', async () => {
    const h = await makeHarness({ agent: sharedWith(BOB), authUser: authWith() });
    await seed(h);
    await engineRecord(h.bus, h.ctx(), [
      { about: `user:${EVE}`, relation: 'lives_in', value: 'Paris', when: JAN, ownerUserId: ALICE, conversationId: 'conv-alice' },
    ]);
    const aliceTurn = h.ctx();

    const out = await h.recall({}, aliceTurn);
    expect(aboutTexts(out)).toMatchObject({ Paris: TEAMMATE_TEXT, Boston: 'Bob Smith' });
    expect(h.resolveCalls).toContain(EVE);
    expect(h.authCalls).not.toContain(EVE);
    expect(h.authCalls).toContain(BOB);
    const tool = await recallTool(h, aliceTurn, 'Paris');
    expect(tool).toContain('a teammate lives in: Paris');
    for (const text of [JSON.stringify(out), tool]) expect(text).not.toContain('Eve Example');
    expect(eventsNamed(h.logs, MEMBER_NAMES_FAILED_EVENT)).toEqual([]);
  });

  // `not-found` is a refusal too: the agent is gone by the time names are asked.
  it.each(['forbidden', 'not-found'])('a %s refusal names nobody for that id, quietly; the others are still named', async (code) => {
    const logs: LoggedEvent[] = [];
    const { bus, asked, memberAsked } = sharedBus({
      resolve: (input) => {
        if (input.userId === EVE) throw refusal(code, EVE);
        return admitted(input);
      },
    });
    const labels = await memberLabels(bus, turn(logs), SHARED, [`user:${EVE}`, `user:${BOB}`], undefined);
    expect(Object.fromEntries(labels)).toEqual({ [`user:${EVE}`]: TEAMMATE_TEXT, [`user:${BOB}`]: 'Bob Smith' });
    expect(asked).toEqual([BOB]);
    expect(memberAsked).toEqual([]);
    expect(logs).toEqual([]);
  });

  it.each([
    [
      'about another agent',
      {
        agent: {
          id: 'agent-elsewhere',
          ownerId: ALICE,
          ownerType: 'user',
          visibility: 'personal',
          shared: true,
          audience: 'everyone',
          isOwner: false,
        },
      },
    ],
    ['with no agent', {}],
    ['whose agent has no id', { agent: { ownerId: ALICE, ownerType: 'user', visibility: 'personal', shared: true } }],
    ['of null', null],
    ['that is not an object', 'yes'],
  ])('an answer %s names nobody for that id, with no auth:get-user call and no warning', async (_label, answer) => {
    const logs: LoggedEvent[] = [];
    const { bus, asked } = sharedBus({ resolve: (input) => (input.userId === BOB ? answer : admitted(input)) });
    const labels = await memberLabels(bus, turn(logs), SHARED, [`user:${BOB}`, `user:${CAROL}`], undefined);
    expect(Object.fromEntries(labels)).toEqual({ [`user:${BOB}`]: TEAMMATE_TEXT, [`user:${CAROL}`]: 'Carol Chen' });
    expect(asked).toEqual([CAROL]);
    expect(logs).toEqual([]);
  });

  it('a resolve fault reads "a teammate" and warns once, naming agents:resolve; the others are still named', async () => {
    const logs: LoggedEvent[] = [];
    const { bus, asked } = sharedBus({
      resolve: (input) => {
        if (input.userId === BOB) {
          throw new PluginError({ code: 'store-unavailable', plugin: '@ax/test-agents', message: `${BOB} bob@x.test Bob Smith` });
        }
        if (input.userId === CAROL) throw new Error(`${CAROL} carol@x.test Carol Chen`);
        return admitted(input);
      },
    });
    const labels = await memberLabels(
      bus,
      turn(logs),
      SHARED,
      [`user:${BOB}`, `user:${CAROL}`, `user:${DAVE}`],
      undefined,
    );
    expect(Object.fromEntries(labels)).toEqual({
      [`user:${BOB}`]: TEAMMATE_TEXT,
      [`user:${CAROL}`]: TEAMMATE_TEXT,
      [`user:${DAVE}`]: 'Dave Diaz',
    });
    expect(asked).toEqual([DAVE]);
    const warns = eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.level).toBe('warn');
    // The first id asked whose lookup threw: Bob's.
    expect(warns[0]!.bindings).toMatchObject({ agentId: 'agent-1', hook: AGENTS_RESOLVE_HOOK, code: 'store-unavailable' });
    const logged = JSON.stringify(logs);
    for (const secret of [BOB, 'bob@x.test', 'Bob', CAROL, 'carol@x.test', 'Carol', DAVE, 'Dave']) {
      expect(logged).not.toContain(secret);
    }
  });

  // A refusal is exactly `forbidden` or `not-found`. Anything else is an
  // outage or a bad answer, and is never passed off as one.
  it.each(['invalid-return', 'timeout', 'invalid-payload', 'unknown'])(
    'a %s from agents:resolve is a fault, not a refusal: one warn, by its code',
    async (code) => {
      const logs: LoggedEvent[] = [];
      const { bus, asked } = sharedBus({
        resolve: () => {
          throw new PluginError({ code, plugin: '@ax/test-agents', message: 'x' });
        },
      });
      const labels = await memberLabels(bus, turn(logs), SHARED, [`user:${BOB}`], undefined);
      expect([...labels]).toEqual([[`user:${BOB}`, TEAMMATE_TEXT]]);
      expect(asked).toEqual([]);
      const warns = eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT);
      expect(warns).toHaveLength(1);
      expect(warns[0]!.bindings).toMatchObject({ hook: AGENTS_RESOLVE_HOOK, code });
    },
  );

  // Nothing is cached: each call asks again, so an agent taken back to Just
  // me stops naming the people it was shared with on the very next read.
  it('asks agents:resolve afresh on every call: once the agent is Just me again, nobody it was shared with is named', async () => {
    const { bus, resolveCalls, asked, setShared } = sharedBus();
    const subjects = [`user:${BOB}`];
    const first = await memberLabels(bus, turn([]), SHARED, subjects, undefined);
    expect(Object.fromEntries(first)).toEqual({ [`user:${BOB}`]: 'Bob Smith' });

    setShared!(false);
    const second = await memberLabels(bus, turn([]), SHARED, subjects, undefined);
    expect(Object.fromEntries(second)).toEqual({ [`user:${BOB}`]: TEAMMATE_TEXT });
    expect(resolveCalls).toEqual([BOB, BOB]);
    expect(asked).toEqual([BOB]);
  });

  it("an outsider's turn names the same people a member's turn does", async () => {
    const h = await makeHarness({ agent: sharedWith(BOB), authUser: authWith() });
    await seed(h);
    // Bob's own turn: Alice by her name, and he is "you".
    expect(aboutTexts(await h.recall({}, h.ctx({ userId: BOB })))).toEqual({
      Boston: 'you',
      teal: 'Alice Jones',
      Nightjar: 'launch plan',
    });

    // An outsider's turn runs as Alice, the owner who set the bot up, and
    // nobody in it is "you": both of them read by name.
    const outsider = h.ctx({ conversationId: CHANNEL, source: 'external', audience: 'shared' });
    const out = await h.recall({}, outsider);
    expect(aboutTexts(out)).toEqual({ Boston: 'Bob Smith', teal: 'Alice Jones', Nightjar: 'launch plan' });
    const tool = await recallTool(h, outsider, 'teal');
    expect(tool).toContain('Alice Jones favorite color: teal');
    expect(tool).not.toContain('| user favorite color');
    expect(h.memberCalls).toEqual([]);
  });

  // Names follow the recall rule here too: a turn from a source this build
  // doesn't know reads shared rows only (it fails closed), and is told no
  // names. Nobody is asked, `agents:resolve` included.
  it.each(['satellite', 'unrecognized'])(
    "a turn from a source this build doesn't recognise (%j) names nobody and asks nobody",
    async (source) => {
      const logs: LoggedEvent[] = [];
      const { bus, resolveCalls, asked, memberAsked } = sharedBus();
      for (const audience of ['shared', 'private', undefined] as const) {
        const labels = await memberLabels(
          bus,
          turn(logs, { source: source as AgentContextSource, ...(audience !== undefined ? { audience } : {}) }),
          SHARED,
          [`user:${BOB}`],
          undefined,
        );
        expect([...labels]).toEqual([[`user:${BOB}`, TEAMMATE_TEXT]]);
      }
      expect(resolveCalls).toEqual([]);
      expect(asked).toEqual([]);
      expect(memberAsked).toEqual([]);
      expect(logs).toEqual([]);

      // The same bus names Bob in a turn from a source it knows.
      const known = await memberLabels(bus, turn(logs, { source: 'user' }), SHARED, [`user:${BOB}`], undefined);
      expect(Object.fromEntries(known)).toEqual({ [`user:${BOB}`]: 'Bob Smith' });
    },
  );

  // TASK-1213's refusals hold for everyone it is shared with.
  it('the agent\'s own name and "a teammate" are refused as names', async () => {
    const logs: LoggedEvent[] = [];
    const { bus, asked } = sharedBus({ answer: authWith({ [BOB]: 'fern.', [CAROL]: 'A  Teammate' }) });
    const labels = await memberLabels(
      bus,
      turn(logs),
      { ...SHARED, agentName: 'Fern' },
      [`user:${BOB}`, `user:${CAROL}`, `user:${DAVE}`],
      undefined,
    );
    expect(Object.fromEntries(labels)).toEqual({
      [`user:${BOB}`]: TEAMMATE_TEXT,
      [`user:${CAROL}`]: TEAMMATE_TEXT,
      [`user:${DAVE}`]: 'Dave Diaz',
    });
    expect([...asked].sort()).toEqual([BOB, CAROL, DAVE].sort());
    expect(logs).toEqual([]);
  });

  // TASK-1213: the caller is asked, through the same proof, only so their
  // name counts. Someone who takes it can't pass for the person talking.
  it('the caller is asked only to count their name: someone renamed to it reads "a teammate"', async () => {
    const logs: LoggedEvent[] = [];
    const { bus, resolveCalls, asked } = sharedBus({ answer: authWith({ [BOB]: 'alice  jones.' }) });
    const labels = await memberLabels(
      bus,
      turn(logs),
      SHARED,
      [`user:${ALICE}`, `user:${BOB}`, `user:${CAROL}`],
      `user:${ALICE}`,
    );
    expect(Object.fromEntries(labels)).toEqual({ [`user:${BOB}`]: TEAMMATE_TEXT, [`user:${CAROL}`]: 'Carol Chen' });
    expect([...resolveCalls].sort()).toEqual([ALICE, BOB, CAROL].sort());
    expect([...asked].sort()).toEqual([ALICE, BOB, CAROL].sort());
    expect(logs).toEqual([]);
  });

  // Which proof is asked comes from the access alone: a team agent's team
  // id (today's path, unchanged), else `memberCheck`, else nobody.
  it('the access picks the proof: a team id asks teams:is-member, memberCheck asks agents:resolve, neither asks nobody', async () => {
    const { bus, resolveCalls, memberAsked } = sharedBus({ resolve: admitted });
    const subjects = [`user:${BOB}`];
    const bob = (labels: ReadonlyMap<string, string>) => labels.get(`user:${BOB}`);

    expect(bob(await memberLabels(bus, turn([]), { visibility: 'team', teamId: TEAM_ID, memberCheck: 'agent' }, subjects, undefined))).toBe('Bob Smith');
    expect(memberAsked).toEqual([BOB]);
    expect(resolveCalls).toEqual([]);

    expect(bob(await memberLabels(bus, turn([]), SHARED, subjects, undefined))).toBe('Bob Smith');
    expect(memberAsked).toEqual([BOB]);
    expect(resolveCalls).toEqual([BOB]);

    for (const access of [{ visibility: 'team' }, { visibility: 'team', teamId: '' }] as const) {
      expect(bob(await memberLabels(bus, turn([]), access, subjects, undefined))).toBe(TEAMMATE_TEXT);
    }
    // A Just-me agent labels nothing, whatever its access carries.
    expect([...(await memberLabels(bus, turn([]), { visibility: 'personal', memberCheck: 'agent' }, subjects, undefined))]).toEqual([]);
    expect(memberAsked).toEqual([BOB]);
    expect(resolveCalls).toEqual([BOB]);
  });

  it('without agents:resolve, without auth:get-user, or with no agent id, nobody is named and nothing is logged', async () => {
    const logs: LoggedEvent[] = [];
    const subjects = [`user:${BOB}`];

    const noResolve = new HookBus();
    const authAsked: string[] = [];
    noResolve.registerService<{ userId: string }, unknown>(AUTH_GET_USER_HOOK, '@ax/test-auth', async (_ctx, input) => {
      authAsked.push(input.userId);
      return authWith()(input.userId);
    });
    expect([...(await memberLabels(noResolve, turn(logs), SHARED, subjects, undefined))]).toEqual([
      [`user:${BOB}`, TEAMMATE_TEXT],
    ]);
    expect(authAsked).toEqual([]);

    const noAuth = new HookBus();
    const noAuthResolve = registerMemoryAgents(noAuth, sharedWith(BOB));
    expect([...(await memberLabels(noAuth, turn(logs), SHARED, subjects, undefined))]).toEqual([
      [`user:${BOB}`, TEAMMATE_TEXT],
    ]);
    expect(noAuthResolve.resolveCalls).toEqual([]);

    // A resolve that would answer anything: with no agent id, an answer
    // "about" it proves nothing, so it is never asked.
    const { bus, resolveCalls, asked } = sharedBus({ resolve: admitted });
    expect([...(await memberLabels(bus, turn(logs, { agentId: '' }), SHARED, subjects, undefined))]).toEqual([
      [`user:${BOB}`, TEAMMATE_TEXT],
    ]);
    expect(resolveCalls).toEqual([]);
    expect(asked).toEqual([]);
    expect(logs).toEqual([]);
  });

  describe('the deadline', () => {
    const never = (): Promise<never> => new Promise<never>(() => {});
    const SHORT = { deadlineMs: 20 } as const;

    it(
      'past the deadline nobody is named: a resolve that never answers; one warn, code timeout, hook agents:resolve',
      async () => {
        const logs: LoggedEvent[] = [];
        const { bus, asked } = sharedBus({ resolve: () => never() });
        const labels = await memberLabels(bus, turn(logs), SHARED, [`user:${BOB}`, `user:${CAROL}`], undefined, SHORT);
        expect(Object.fromEntries(labels)).toEqual({ [`user:${BOB}`]: TEAMMATE_TEXT, [`user:${CAROL}`]: TEAMMATE_TEXT });
        expect(asked).toEqual([]);
        const warns = eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT);
        expect(warns).toHaveLength(1);
        expect(warns[0]!.level).toBe('warn');
        expect(warns[0]!.bindings).toMatchObject({ agentId: 'agent-1', hook: AGENTS_RESOLVE_HOOK, code: 'timeout' });
        const logged = JSON.stringify(logs);
        for (const secret of [BOB, CAROL]) expect(logged).not.toContain(secret);
      },
      2_000,
    );

    it(
      'one resolve still out at the deadline: nobody is named, not even someone whose name came back in time',
      async () => {
        const logs: LoggedEvent[] = [];
        const { bus, asked } = sharedBus({ resolve: (input) => (input.userId === CAROL ? never() : admitted(input)) });
        const labels = await memberLabels(bus, turn(logs), SHARED, [`user:${BOB}`, `user:${CAROL}`], undefined, SHORT);
        expect(Object.fromEntries(labels)).toEqual({ [`user:${BOB}`]: TEAMMATE_TEXT, [`user:${CAROL}`]: TEAMMATE_TEXT });
        expect(asked).toEqual([BOB]);
        const warns = eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT);
        expect(warns).toHaveLength(1);
        expect(warns[0]!.bindings).toMatchObject({ hook: AGENTS_RESOLVE_HOOK, code: 'timeout' });
      },
      2_000,
    );

    it(
      'a name lookup still out at the deadline: the warn names auth:get-user',
      async () => {
        const logs: LoggedEvent[] = [];
        const { bus } = sharedBus({ answer: (userId) => (userId === CAROL ? never() : authWith()(userId)) });
        const labels = await memberLabels(bus, turn(logs), SHARED, [`user:${BOB}`, `user:${CAROL}`], undefined, SHORT);
        expect(Object.fromEntries(labels)).toEqual({ [`user:${BOB}`]: TEAMMATE_TEXT, [`user:${CAROL}`]: TEAMMATE_TEXT });
        const warns = eventsNamed(logs, MEMBER_NAMES_FAILED_EVENT);
        expect(warns).toHaveLength(1);
        expect(warns[0]!.bindings).toMatchObject({ hook: AUTH_GET_USER_HOOK, code: 'timeout' });
      },
      2_000,
    );
  });
});
