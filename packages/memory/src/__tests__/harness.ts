import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HookBus,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type LlmCallInput,
  type LlmCallOutput,
  type Logger,
  type Plugin,
  type ToolDescriptor,
} from '@ax/core';
import { createMemoryFactsSqlitePlugin } from '@ax/memory-facts-sqlite';

import { AGENTS_RESOLVE_HOOK } from '../access.js';
import { createMemoryPlugin, type MemoryPluginConfig } from '../plugin.js';
import type {
  MemoryForgetInput,
  MemoryForgetOutput,
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
  ctx: (opts?: { agentId?: string; userId?: string; conversationId?: string; source?: 'routine' | 'user'; sessionId?: string }) => AgentContext;
  recall: (input: MemoryRecallInput, ctx?: AgentContext) => Promise<MemoryRecallOutput>;
  remember: (input: MemoryRememberInput, ctx?: AgentContext) => Promise<MemoryRememberOutput>;
  forget: (input: MemoryForgetInput, ctx?: AgentContext) => Promise<MemoryForgetOutput>;
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
  teardown: () => Promise<void>;
}

export const DEFAULT_AGENT = 'agent-1';
export const ALICE = 'user-alice';
export const BOB = 'user-bob';

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
  };
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
  registerMemoryAgents(bus, {
    visibility: options.agent?.visibility,
    ownerUserId: options.agent?.ownerUserId,
    members: teamMembers,
  });

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
    teardown: async () => {
      await engine.shutdown?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function registerMemoryAgents(
  bus: HookBus,
  options: {
    visibility?: 'personal' | 'team';
    ownerUserId?: string;
    members?: Set<string>;
  } = {},
): void {
  const visibility = options.visibility ?? 'personal';
  const ownerUserId = options.ownerUserId ?? ALICE;
  const members = options.members ?? new Set<string>([ALICE, BOB]);
  bus.registerService<
    { agentId: string; userId: string },
    { agent: { id: string; ownerId: string; ownerType: string; visibility: string } }
  >(AGENTS_RESOLVE_HOOK, '@ax/test-agents', async (_ctx, input) => {
    const allowed =
      visibility === 'personal' ? input.userId === ownerUserId : members.has(input.userId);
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
        ownerId: visibility === 'team' ? 'team-1' : ownerUserId,
        ownerType: visibility === 'team' ? 'team' : 'user',
        visibility,
      },
    };
  });
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
  }>,
): Promise<{ records: Array<{ id: string }> }> {
  return bus.call('memory:facts:record', ctx, { statements });
}

/**
 * Register a stand-in `memory:rules:read`.
 *
 * The human tier's provider is `@ax/memory-strata` today and is not part of
 * this plugin (design §10.4 keeps `memory:rules:*` a shared contract), so the
 * block reaches it through the bus. A test that wants a Rules section
 * registers this; a test that wants the no-provider case simply does not.
 */
export function registerRulesStub(
  bus: HookBus,
  body: string | (() => Promise<string>),
): void {
  bus.registerService<{ agentId: string }, { body: string }>(
    'memory:rules:read',
    '@ax/test-rules-stub',
    async () => ({ body: typeof body === 'string' ? body : await body() }),
  );
}
