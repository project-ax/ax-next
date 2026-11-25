import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HookBus,
  makeAgentContext,
  MEMORY_PRE_CAPTURE_HOOK,
  PluginError,
  type AgentContext,
  type AgentContextAudience,
  type AgentContextSource,
  type LlmCallInput,
  type LlmCallOutput,
  type Logger,
  type MemoryPreCapturePayload,
  type Plugin,
  type ToolDescriptor,
} from '@ax/core';
import { createMemoryFactsSqlitePlugin } from '@ax/memory-facts-sqlite';

import { AGENTS_RESOLVE_HOOK } from '../access.js';
import { createMemoryPlugin, type MemoryPluginConfig } from '../plugin.js';
import type {
  MemoryCorrectInput,
  MemoryCorrectOutput,
  MemoryForgetInput,
  MemoryForgetOutput,
  MemoryUnforgetInput,
  MemoryUnforgetOutput,
  MemoryUncorrectInput,
  MemoryUncorrectOutput,
  MemoryRecallInput,
  MemoryRecallOutput,
  MemoryRememberInput,
  MemoryRememberOutput,
} from '../types.js';

/**
 * The integration harness: `@ax/memory` over the REAL sqlite engine on a real
 * `HookBus`.
 *
 * Deliberately not a mock. TASK-434's mutation pass found that every channel
 * test called the function directly and NONE covered its wiring, so a mutation
 * to the wiring reddened nothing. The properties this card owes — provenance
 * by hook, owner scoping, the speaker rewrite surviving a round trip — are
 * properties of the two plugins TOGETHER, and a stub that answers whatever we
 * hand it cannot observe any of them.
 *
 * A stub bus is still the right tool for the engine-response edge cases (a
 * `null` return, a missing service), and `engine-contract.test.ts` uses one
 * there for exactly that reason.
 *
 * Note this file imports `@ax/memory-facts-sqlite` as a VALUE. That is legal
 * here and only here: `eslint.config.mjs` turns the cross-plugin import rule
 * off under every package's `src/__tests__` tree, because the test graph is
 * not the production graph. `src/` must reach the engine through the bus, and
 * does.
 */
/** One log line a test can assert on. */
export interface LoggedEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  bindings: Record<string, unknown>;
}

export interface MemoryHarness {
  bus: HookBus;
  ctx: (opts?: {
    agentId?: string;
    userId?: string;
    conversationId?: string;
    source?: AgentContextSource;
    /** Absent by default, which reads as `'private'` (TASK-1091). */
    audience?: AgentContextAudience;
    sessionId?: string;
  }) => AgentContext;
  recall: (input: MemoryRecallInput, ctx?: AgentContext) => Promise<MemoryRecallOutput>;
  remember: (input: MemoryRememberInput, ctx?: AgentContext) => Promise<MemoryRememberOutput>;
  forget: (input: MemoryForgetInput, ctx?: AgentContext) => Promise<MemoryForgetOutput>;
  unforget: (input: MemoryUnforgetInput, ctx?: AgentContext) => Promise<MemoryUnforgetOutput>;
  uncorrect: (input: MemoryUncorrectInput, ctx?: AgentContext) => Promise<MemoryUncorrectOutput>;
  correct: (input: MemoryCorrectInput, ctx?: AgentContext) => Promise<MemoryCorrectOutput>;
  memoryPlugin: Plugin;
  /**
   * The engine's sqlite file. Exposed so a test can open a SECOND connection
   * and count EVERY row, closed ones included — `memory:recall` only ever
   * shows active, owner-scoped rows, and "the batch rolled back" is a
   * question about every row.
   */
  databasePath: string;
  /** Every log line any harness ctx emitted, in order. */
  logs: LoggedEvent[];
  /** Every `llm:call:openrouter` request the observer made, in order. */
  llmCalls: LlmCallInput[];
  toolDescriptors: ToolDescriptor[];
  /**
   * Await every DETACHED observer run started so far.
   *
   * The observer returns to `chat:end` before its work finishes — that is the
   * property the card is about — so a test that asserted on the store right
   * after `fire` would be racing it. This awaits the plugin's own handle on
   * the detached promise rather than sleeping.
   */
  settleObserver: () => Promise<void>;
  teamMembers: Set<string>;
  /**
   * Every id `auth:get-user` was asked about, in order (TASK-1209). Stays `[]`
   * when the harness was built without `authUser`: then no such service is
   * registered at all.
   */
  authCalls: string[];
  /** Every id `teams:is-member` was asked about, in order (TASK-1209). */
  memberCalls: string[];
  /** Every `userId` the fake `agents:resolve` was asked about, in order (TASK-1248). */
  resolveCalls: string[];
  /**
   * Share the personal agent with `agent.members` (`true`) or take it back to
   * Just me (`false`), between calls (TASK-1248). Just me admits only
   * `agent.ownerUserId`. Throws on a team agent, which is always shared.
   */
  setShared: (shared: boolean) => void;
  teardown: () => Promise<void>;
}

export const DEFAULT_AGENT = 'agent-1';
export const ALICE = 'user-alice';
export const BOB = 'user-bob';
/** The team that owns a team agent here: `agents:resolve`'s `ownerId`. */
export const TEAM_ID = 'team-1';

export interface MemoryHarnessOptions {
  /**
   * The stub extraction provider. Registered as `llm:call:openrouter` — the
   * provider `DEFAULT_MEMORY_OPS_MODEL` routes to. Omit it entirely to build
   * a harness with NO provider registered, which is the degraded shape the
   * `optionalCalls` entry describes.
   */
  llm?: (input: LlmCallInput, call: number) => Promise<LlmCallOutput> | LlmCallOutput;
  agent?: {
    visibility?: 'personal' | 'team';
    ownerUserId?: string;
    members?: Set<string>;
    /** The agent's display name, as `agents:resolve` answers it. Omitted, the answer carries none. */
    displayName?: string;
    /**
     * A personal agent shared with other people (TASK-1248): `agents:resolve`
     * then admits `ownerUserId` and every id in `members`, and answers
     * `shared: true`. Omitted or `false`, it is Just me. Personal agents only.
     */
    shared?: boolean;
  };
  /**
   * Registers `auth:get-user` (TASK-1209), answering with whatever this returns
   * (or throws) for the id asked about, the way `@ax/auth-better` answers
   * `{ id, email, displayName, isAdmin } | null`. Omit it to build a harness
   * with NO such service, the degraded shape memory's `optionalCalls` entry
   * describes.
   */
  authUser?: (userId: string) => unknown | Promise<unknown>;
  /**
   * `teams:is-member` (TASK-1209: memory names only current members of the
   * agent's team). By default it answers from `agent.members` for
   * {@link TEAM_ID}, the same people `agents:resolve` lets in, as
   * `@ax/agents`' ACL does. `false` registers no such service; a function
   * answers (or throws) in its place.
   */
  teamsIsMember?: false | ((input: { teamId: string; userId: string }) => unknown | Promise<unknown>);
}

export async function makeMemoryHarness(
  config: MemoryPluginConfig = {},
  options: MemoryHarnessOptions = {},
): Promise<MemoryHarness> {
  const bus = new HookBus();
  const dir = await mkdtemp(join(tmpdir(), 'ax-memory-'));
  const databasePath = join(dir, 'facts.db');
  const engine = createMemoryFactsSqlitePlugin({ databasePath });
  await engine.init({ bus, config: {} });

  const logs: LoggedEvent[] = [];
  const llmCalls: LlmCallInput[] = [];
  const toolDescriptors: ToolDescriptor[] = [];
  const detached: Array<Promise<void>> = [];

  bus.registerService<ToolDescriptor, { ok: true }>(
    'tool:register',
    '@ax/test-tool-catalog',
    async (_ctx, descriptor) => {
      toolDescriptors.push(descriptor);
      return { ok: true };
    },
  );

  const teamMembers =
    options.agent?.members ?? new Set<string>([ALICE, BOB]);
  const agents = registerMemoryAgents(bus, {
    visibility: options.agent?.visibility,
    ownerUserId: options.agent?.ownerUserId,
    members: teamMembers,
    displayName: options.agent?.displayName,
    shared: options.agent?.shared,
  });

  const memberCalls: string[] = [];
  if (options.teamsIsMember !== false) {
    const answer =
      options.teamsIsMember ??
      ((input: { teamId: string; userId: string }) => ({
        member: input.teamId === TEAM_ID && teamMembers.has(input.userId),
      }));
    bus.registerService<{ teamId: string; userId: string }, unknown>(
      'teams:is-member',
      '@ax/test-teams',
      async (_ctx, input) => {
        memberCalls.push(input.userId);
        return answer(input);
      },
    );
  }

  const authCalls: string[] = [];
  if (options.authUser !== undefined) {
    const authUser = options.authUser;
    bus.registerService<{ userId: string }, unknown>(
      'auth:get-user',
      '@ax/test-auth',
      async (_ctx, input) => {
        authCalls.push(input.userId);
        return authUser(input.userId);
      },
    );
  }

  if (options.llm !== undefined) {
    const llm = options.llm;
    bus.registerService<LlmCallInput, LlmCallOutput>(
      'llm:call:openrouter',
      'stub-llm',
      async (_ctx, input) => {
        llmCalls.push(input);
        return llm(input, llmCalls.length);
      },
    );
  }

  const memoryPlugin = createMemoryPlugin({
    ...config,
    onObserverDetached: (work) => {
      detached.push(work);
      config.onObserverDetached?.(work);
    },
  });
  await memoryPlugin.init({ bus, config: {} });

  const logger = capturingLogger(logs);

  const ctx: MemoryHarness['ctx'] = (opts = {}) =>
    makeAgentContext({
      sessionId: opts.sessionId ?? 'session-1',
      agentId: opts.agentId ?? DEFAULT_AGENT,
      userId: opts.userId ?? ALICE,
      workspace: { rootPath: '/tmp' },
      logger,
      ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
      ...(opts.source !== undefined ? { source: opts.source } : {}),
      ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
    });

  return {
    bus,
    ctx,
    memoryPlugin,
    databasePath,
    logs,
    llmCalls,
    toolDescriptors,
    teamMembers,
    authCalls,
    memberCalls,
    resolveCalls: agents.resolveCalls,
    setShared: agents.setShared,
    settleObserver: async () => {
      // Loop: a settle can race a run that starts another. Bounded so a
      // pathological test cannot hang the suite.
      for (let i = 0; i < 100; i++) {
        const pending = [...detached];
        if (pending.length === 0) return;
        await Promise.all(pending);
        if (detached.length === pending.length) return;
      }
    },
    recall: (input, c) => bus.call<MemoryRecallInput, MemoryRecallOutput>('memory:recall', c ?? ctx(), input),
    remember: (input, c) =>
      bus.call<MemoryRememberInput, MemoryRememberOutput>('memory:remember', c ?? ctx(), input),
    forget: (input, c) =>
      bus.call<MemoryForgetInput, MemoryForgetOutput>('memory:forget', c ?? ctx(), input),
    unforget: (input, c) =>
      bus.call<MemoryUnforgetInput, MemoryUnforgetOutput>('memory:unforget', c ?? ctx(), input),
    uncorrect: (input, c) =>
      bus.call<MemoryUncorrectInput, MemoryUncorrectOutput>('memory:uncorrect', c ?? ctx(), input),
    correct: (input, c) =>
      bus.call<MemoryCorrectInput, MemoryCorrectOutput>('memory:correct', c ?? ctx(), input),
    teardown: async () => {
      await memoryPlugin.shutdown?.();
      await engine.shutdown?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** The fake `agents:resolve`'s handle: what it was asked, and the sharing switch. */
export interface MemoryAgentsFake {
  /** Every `userId` it was asked about, in order. */
  resolveCalls: string[];
  /** See {@link MemoryHarness.setShared}. */
  setShared: (shared: boolean) => void;
}

/**
 * A fake `agents:resolve`, answering the way `@ax/agents` does since
 * TASK-1246: `shared` on every answer, and `isOwner` for the id asked about.
 *
 * - A team agent admits `members`, and answers `shared: true, isOwner: false`.
 * - A personal agent that is Just me (the default) admits only `ownerUserId`,
 *   and answers `shared: false, audience: 'just-me', isOwner: true`.
 * - A personal agent shared with other people (`shared: true`, TASK-1248)
 *   admits `ownerUserId` and every id in `members`, and answers
 *   `shared: true, audience: 'everyone'`, with `isOwner` true for
 *   `ownerUserId` only.
 */
export function registerMemoryAgents(
  bus: HookBus,
  options: {
    visibility?: 'personal' | 'team' | undefined;
    ownerUserId?: string | undefined;
    members?: Set<string>;
    /** Answered only when set: the stub's answer carries no `displayName` otherwise. */
    displayName?: string | undefined;
    /** A personal agent shared with other people (TASK-1248). Personal agents only. */
    shared?: boolean | undefined;
  } = {},
): MemoryAgentsFake {
  const visibility = options.visibility ?? 'personal';
  const ownerUserId = options.ownerUserId ?? ALICE;
  const members = options.members ?? new Set<string>([ALICE, BOB]);
  const displayName = options.displayName;
  if (visibility === 'team' && options.shared !== undefined) {
    throw new Error('registerMemoryAgents: `shared` is for a personal agent; a team agent is always shared');
  }
  let shared = options.shared === true;
  const resolveCalls: string[] = [];
  bus.registerService<
    { agentId: string; userId: string },
    {
      agent: {
        id: string;
        ownerId: string;
        ownerType: string;
        visibility: string;
        shared: boolean;
        audience?: string;
        isOwner: boolean;
        displayName?: string;
      };
    }
  >(AGENTS_RESOLVE_HOOK, '@ax/test-agents', async (_ctx, input) => {
    resolveCalls.push(input.userId);
    const allowed =
      visibility === 'team'
        ? members.has(input.userId)
        : input.userId === ownerUserId || (shared && members.has(input.userId));
    if (!allowed) {
      throw new PluginError({
        code: 'forbidden',
        plugin: '@ax/test-agents',
        hookName: AGENTS_RESOLVE_HOOK,
        message: 'Caller is not authorized for this agent',
      });
    }
    return {
      agent: {
        id: input.agentId,
        ownerId: visibility === 'team' ? TEAM_ID : ownerUserId,
        ownerType: visibility === 'team' ? 'team' : 'user',
        visibility,
        ...(visibility === 'team'
          ? { shared: true, isOwner: false }
          : shared
            ? { shared: true, audience: 'everyone', isOwner: input.userId === ownerUserId }
            : { shared: false, audience: 'just-me', isOwner: true }),
        ...(displayName !== undefined ? { displayName } : {}),
      },
    };
  });
  return {
    resolveCalls,
    setShared: (next) => {
      if (visibility === 'team') {
        throw new Error('setShared: a team agent is always shared');
      }
      shared = next;
    },
  };
}

/**
 * Answer `memory:pre-capture` the way a channel that labels its speakers does
 * (TASK-1146): let memory learn, and add `names` to the payload after any an
 * earlier subscriber added. With `conversationId`, only that conversation is
 * answered, and any other gets no opinion.
 *
 * Returns every payload it was asked with, in order, so a test can count the
 * asks and see that memory asked with the conversation alone.
 */
export function answerSpeakerNames(
  bus: HookBus,
  names: readonly string[],
  conversationId?: string,
): MemoryPreCapturePayload[] {
  const asked: MemoryPreCapturePayload[] = [];
  bus.subscribe<MemoryPreCapturePayload>(MEMORY_PRE_CAPTURE_HOOK, 'test-speaker-names', async (_ctx, payload) => {
    asked.push(payload);
    if (conversationId !== undefined && payload.conversationId !== conversationId) return undefined;
    return { ...payload, speakerNames: [...(payload.speakerNames ?? []), ...names] };
  });
  return asked;
}

export function capturingLogger(sink: LoggedEvent[]): Logger {
  const at =
    (level: LoggedEvent['level']) =>
    (event: string, bindings?: Record<string, unknown>): void => {
      sink.push({ level, event, bindings: bindings ?? {} });
    };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return logger;
}

/** Find every captured line with this event name. */
export function eventsNamed(logs: readonly LoggedEvent[], event: string): LoggedEvent[] {
  return logs.filter((line) => line.event === event);
}

/**
 * Read a row straight out of the engine, bypassing `@ax/memory`'s owner
 * scoping, so a test can prove a row EXISTS and is still active even though
 * the product layer refuses to show it to the caller under test.
 *
 * Without this, "owner B cannot see it" and "the row was destroyed" are the
 * same observation, and only one of them is what we mean.
 */
export async function engineRecall(
  bus: HookBus,
  ctx: AgentContext,
  input: { about?: string; limit: number; activeOnly?: boolean; ownerUserId?: string },
): Promise<{
  statements: Array<{ id: string; about: string; until?: string }>;
  degraded: string[];
}> {
  return bus.call('memory:facts:recall', ctx, input);
}

/**
 * Write rows straight into the engine, bypassing `@ax/memory`'s product hooks.
 *
 * The injected block (design §4.1) reads `slot`, `conversationId` and
 * `provenance`, and `memory:remember` deliberately sets none of them — it
 * sends no slot, and it hardcodes `provenance: 'human'`. The block's fixtures
 * therefore cannot be built through the product surface at all, so they are
 * recorded here the way the observer and the normalizer will record them.
 */
export async function engineRecord(
  bus: HookBus,
  ctx: AgentContext,
  statements: Array<{
    about: string;
    relation: string;
    value: string;
    when: string;
    slot?: string;
    provenance?: 'extracted' | 'agent' | 'human';
    ownerUserId?: string;
    conversationId?: string;
    sourceTurnId?: string;
    sourceRole?: 'user' | 'assistant';
    /**
     * The engine's audience stamp (TASK-1091). Omitted, the row is stored
     * unstamped, the way every row written before the field existed is.
     */
    audience?: 'private' | 'shared';
  }>,
): Promise<{ records: Array<{ id: string }> }> {
  return bus.call('memory:facts:record', ctx, { statements });
}
