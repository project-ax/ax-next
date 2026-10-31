// Shared Postgres harness for the TASK-989 identity suites (identity.test.ts,
// identity-tools.test.ts). Not a test file itself — vitest only collects
// `*.test.ts`.
//
// Each suite that calls `useIdentityEnv()` at module top level gets its own
// container (beforeAll/afterAll) and a clean pair of tables after every case.
// The harness registers a configurable `identity:scan` stub (default: clean;
// records every input) or, with `realScan`, the real @ax/validator-identity;
// optional `teams:is-member` / `tool:register` stubs; and a spy on
// `system-prompt:augment-changed`.
import { afterAll, afterEach, beforeAll } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createValidatorIdentityPlugin } from '@ax/validator-identity';
import {
  SYSTEM_PROMPT_AUGMENT_CHANGED_HOOK,
  type AgentContext,
  type SystemPromptAugmentChangedPayload,
  type ToolDescriptor,
} from '@ax/core';
import pg from 'pg';
import { createAgentsPlugin } from '../plugin.js';
import type { AgentInput, CreateInput, CreateOutput } from '../types.js';

export type ScanAnswer = (input: unknown) => Promise<unknown>;

export const CLEAN: ScanAnswer = async () => ({ verdict: 'clean' });

export interface IdentityHarnessOptions {
  /** Register the `identity:scan` stub. Default true. */
  withScan?: boolean;
  /**
   * Load the REAL @ax/validator-identity in place of the stub (so `scanned`
   * and `setScan` do nothing). Default false.
   */
  realScan?: boolean;
  /** Register a recording `tool:register` stub. Default false. */
  withToolRegister?: boolean;
  /** Users `teams:is-member` answers `member: true` for. Absent → no teams stub. */
  teamMembers?: readonly string[];
}

export interface IdentityHarness {
  h: TestHarness;
  /** Every `system-prompt:augment-changed` payload, in order. */
  changed: SystemPromptAugmentChangedPayload[];
  /** Every `identity:scan` input, in order. */
  scanned: unknown[];
  /** Descriptors handed to `tool:register` (only with `withToolRegister`). */
  descriptors: ToolDescriptor[];
  /** Replace the scan stub's answer for the rest of the case. */
  setScan(answer: ScanAnswer): void;
  ctx(agentId: string, userId: string, extra?: { source?: 'routine' | 'user' }): AgentContext;
  /** `agents:create` as `userId`; returns the new agent id. */
  createAgent(
    userId: string,
    opts?: { bootstrap?: unknown; input?: Partial<AgentInput> },
  ): Promise<string>;
}

export function makeAgentInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    displayName: 'Pip',
    allowedTools: ['bash.run'],
    mcpConfigIds: [],
    model: 'anthropic/claude-opus-4-7',
    visibility: 'personal',
    ...overrides,
  };
}

export function useIdentityEnv(): {
  makeHarness(opts?: IdentityHarnessOptions): Promise<IdentityHarness>;
  query<R>(text: string, values?: unknown[]): Promise<R[]>;
  /** The suite's Postgres connection string (valid after beforeAll). */
  connectionString(): string;
} {
  let container: StartedPostgreSqlContainer | undefined;
  let connectionString = '';
  const harnesses: TestHarness[] = [];

  async function query<R>(text: string, values: unknown[] = []): Promise<R[]> {
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const res = await client.query(text, values);
      return res.rows as R[];
    } finally {
      await client.end().catch(() => {});
    }
  }

  beforeAll(async () => {
    container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    connectionString = container.getConnectionUri();
  }, 120_000);

  afterEach(async () => {
    while (harnesses.length > 0) {
      await harnesses.pop()!.close({ onError: () => {} });
    }
    await query('DROP TABLE IF EXISTS agents_v1_identity');
    await query('DROP TABLE IF EXISTS agents_v1_agents');
  });

  afterAll(async () => {
    if (container) await stopPostgresContainer(container);
  });

  async function makeHarness(opts: IdentityHarnessOptions = {}): Promise<IdentityHarness> {
    const scanned: unknown[] = [];
    const descriptors: ToolDescriptor[] = [];
    let scanAnswer: ScanAnswer = CLEAN;
    const services: Record<string, (ctx: unknown, input: unknown) => Promise<unknown>> = {
      'http:register-route': async () => ({ unregister: () => {} }),
      'auth:require-user': async () => {
        throw new Error('auth:require-user is not used by the identity suites');
      },
    };
    if (opts.withScan !== false && opts.realScan !== true) {
      services['identity:scan'] = async (_ctx, input) => {
        scanned.push(input);
        return scanAnswer(input);
      };
    }
    if (opts.withToolRegister === true) {
      services['tool:register'] = async (_ctx, input) => {
        descriptors.push(input as ToolDescriptor);
        return { ok: true };
      };
    }
    if (opts.teamMembers !== undefined) {
      const members = new Set(opts.teamMembers);
      services['teams:is-member'] = async (_ctx, input) => ({
        member: members.has((input as { userId: string }).userId),
      });
    }
    const h = await createTestHarness({
      services,
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        ...(opts.realScan === true ? [createValidatorIdentityPlugin()] : []),
        createAgentsPlugin(),
      ],
    });
    harnesses.push(h);
    const changed: SystemPromptAugmentChangedPayload[] = [];
    h.bus.subscribe<SystemPromptAugmentChangedPayload>(
      SYSTEM_PROMPT_AUGMENT_CHANGED_HOOK,
      'test-augment-changed-spy',
      async (_ctx, payload) => {
        changed.push(payload);
        return undefined;
      },
    );
    return {
      h,
      changed,
      scanned,
      descriptors,
      setScan(answer) {
        scanAnswer = answer;
      },
      ctx(agentId, userId, extra = {}) {
        return h.ctx({
          sessionId: 's',
          agentId,
          userId,
          ...(extra.source !== undefined ? { source: extra.source } : {}),
        });
      },
      async createAgent(userId, createOpts = {}) {
        const payload = {
          actor: { userId, isAdmin: false },
          input: makeAgentInput(createOpts.input),
          ...(createOpts.bootstrap !== undefined ? { bootstrap: createOpts.bootstrap } : {}),
        } as CreateInput;
        const out = await h.bus.call<CreateInput, CreateOutput>(
          'agents:create',
          h.ctx({ userId }),
          payload,
        );
        return out.agent.id;
      },
    };
  }

  return { makeHarness, query, connectionString: () => connectionString };
}
