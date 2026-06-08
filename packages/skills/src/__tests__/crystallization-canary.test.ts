/**
 * Skill-crystallization wiring canary (TASK-178, skill-crystallization PR-C).
 *
 * The skill-crystallization loop (design: 2026-06-08-skill-crystallization-design.md)
 * is: a `skill-reflection` routine fires per agent → runs the agent in a hidden
 * per-fire reflection turn → the turn authors an instruction-only draft and
 * proposes it via `skill_propose` → `skills:propose` → it lands `active` for the
 * SAME agent next turn (the shipped projection, PRs #218/#219). PR-A/B (landed)
 * supply the routine-origin signal + the memory guard.
 *
 * A unit test CANNOT exercise the model's judgment (no real LLM) — whether the
 * reflection crystallizes the RIGHT things and respects the ≥2-conversation
 * recurrence gate is the MANUAL-ACCEPTANCE walk (plan §"MANUAL-ACCEPTANCE walk").
 * This canary exercises the WIRING, with no over-mock:
 *
 *   1. wiring — the REAL `createFireRoutine` (from @ax/routines) drives a stub
 *      `agent:invoke` that calls the REAL `skills:propose` (real @ax/skills +
 *      real Postgres) with an instruction-only authored manifest. We assert the
 *      proposal lands `status: 'active'`, `skills:proposed` fired, and the row is
 *      visible to `skills:list-authored`. The owner is REAL (ctx.userId from the
 *      fire path), so an owner/auth regression in the propose path surfaces here
 *      — NOT a synthetic actor.
 *
 *   2. capability-fence — the propose gate (`classifyProposal`) is origin+scan
 *      only (TASK-100 moved all reach to connectors; an authored skill is
 *      ALWAYS zero-reach instruction scaffolding). So the fence that keeps an
 *      un-vetted skill OUT of the auto-active path is the ORIGIN axis: anything
 *      not `origin: 'authored'` (i.e. pulled from outside / needing approval)
 *      lands `pending`, not active. The design's "connector declared → pending"
 *      is this same fence: a connector's reach is gated by the connector
 *      approval card (TASK-94), and a non-authored proposal waits for a human.
 *      We assert a non-authored proposal driven through the real fire path
 *      lands `pending`.
 *
 *   3. no-self-reflection — the real fire path stamps `source: 'routine'` on the
 *      fire ctx (PR-A, host-side, unforgeable by the runner). A `chat:end`
 *      subscriber that mimics the memory observer's guard MUST skip a
 *      routine-origin turn, so the reflection turn never feeds the agent's own
 *      memory (which would make the loop reflect on itself). We assert the
 *      source-stamped ctx the fire path produces carries `source: 'routine'`
 *      and that a guard keyed on it skips — the established TASK-176 source path.
 *      (The end-to-end happy-path guarantee against the REAL memory-strata
 *      observer is TASK-181, asserted in @ax/memory-strata's own suite.)
 *
 *   4. recurrence prompt-guard — assert SKILL_REFLECTION_PROMPT carries the
 *      ≥2-distinct-conversations clause, the anti-pattern list, prefer-patch,
 *      and the ≤3-ops cap, so the IP can't silently regress. Behavioral gating
 *      is the manual walk, NOT this unit test (logged below).
 *
 * Why this is a TEST-only import of @ax/routines: it's a devDependency, imported
 * only here. eslint's no-restricted-imports cross-plugin guard does not apply
 * under __tests__/ (same pattern as the skill-install e2e canary importing
 * @ax/agents + @ax/chat-orchestrator). We are NOT establishing a runtime
 * cross-plugin dep — the production coupling is the hook bus (skill_propose tool
 * → skill.propose IPC → skills:propose), exercised here through the real plugin.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import {
  HookBus,
  makeAgentContext,
  type AgentContext,
  type ServiceHandler,
} from '@ax/core';
import {
  createFireRoutine,
  SKILL_REFLECTION_PROMPT,
  type FireDeps,
  type PendingFires,
} from '@ax/routines';
import type { RoutineRow } from '@ax/routines';
import { createSkillsPlugin } from '../plugin.js';
import { blobStoreFakeServices } from './_blob-fake.js';
import type {
  SkillsProposeInput,
  SkillsProposeOutput,
  SkillsListAuthoredInput,
  SkillsListAuthoredOutput,
  SkillsProposedEvent,
} from '../types.js';

// ---------------------------------------------------------------------------
// Postgres testcontainer (shared across the file; fresh harness per test).
// ---------------------------------------------------------------------------
let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

const httpRegisterRouteStub: ServiceHandler = async () => ({ unregister: () => {} });
const authRequireUserStub: ServiceHandler = async () => ({
  user: { id: 'admin', isAdmin: true },
});

// capabilityProposal is a DEPRECATED wire hint the host ignores (TASK-100 — a
// skill declares no caps). Pass empty; the gate keys on origin + scan only.
const emptyCaps = {
  allowedHosts: [],
  credentials: [],
  mcpServers: [],
  packages: { npm: [], pypi: [] },
};

// An instruction-only manifest: zero declared reach (the reflection authors
// these). Lands `active` on the authored + clean path.
const INSTRUCTION_ONLY_MANIFEST = `name: commit-style
description: how we format commits
version: 1
`;

async function makeSkillsHarness(
  services: Record<string, ServiceHandler> = {},
): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      ...blobStoreFakeServices(),
      'http:register-route': httpRegisterRouteStub,
      'auth:require-user': authRequireUserStub,
      ...services,
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createSkillsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

/**
 * A minimal `skill-reflection` RoutineRow (per-fire, REFLECTION_DONE token,
 * the real meta-prompt body). The canary fires this through the REAL
 * createFireRoutine.
 */
function reflectionRow(over: Partial<RoutineRow> = {}): RoutineRow {
  return {
    agentId: 'a1',
    path: 'default:skill-reflection',
    authorUserId: 'u1',
    name: 'skill-reflection',
    description: 'crystallization',
    specHash: 'h',
    trigger: { kind: 'interval', every: '24h' },
    activeHours: null,
    silenceToken: 'REFLECTION_DONE',
    silenceMaxChars: 4000,
    conversation: 'per-fire',
    promptBody: SKILL_REFLECTION_PROMPT,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    definitionId: 'skill-reflection',
    definitionUpdatedAt: null,
    ...over,
  };
}

/**
 * Build a bus that wires the real skills:propose (from the skills harness) plus
 * the conversation + agents:resolve stubs the fire path needs, and a stub
 * `agent:invoke` standing in for the reflection turn. `invoke` is called with
 * the REAL fire ctx (source: 'routine' stamped by createFireRoutine), so it can
 * propose against the real owner — exactly what the runner would do over the
 * skill_propose tool → skill.propose IPC → skills:propose.
 */
function makeFireBus(invoke: (ctx: AgentContext) => Promise<unknown>): {
  bus: HookBus;
  /** Resolves once the (fire-and-forget) agent:invoke handler has fully run. */
  invokeDone: Promise<void>;
} {
  const bus = new HookBus();
  let signalDone!: () => void;
  const invokeDone = new Promise<void>((res) => {
    signalDone = res;
  });
  bus.registerService('agents:resolve', 'test', async (_ctx, input) => {
    const i = input as { agentId: string; userId: string };
    return { agent: { id: i.agentId, ownerId: i.userId, workspaceRef: null } };
  });
  bus.registerService('conversations:create', 'test', async () => ({
    conversationId: 'cnv_reflection',
    userId: 'u1',
    agentId: 'a1',
  }));
  // The reflection turn. createFireRoutine calls this fire-and-forget with the
  // source-stamped ctx; we forward that ctx so the propose runs as the real
  // owner. We resolve invokeDone AFTER the handler completes (or throws) so the
  // test can deterministically await the real (Postgres-backed) propose round
  // trip rather than racing microtask ticks.
  bus.registerService('agent:invoke', 'test', async (ctx) => {
    try {
      return await invoke(ctx as AgentContext);
    } finally {
      signalDone();
    }
  });
  return { bus, invokeDone };
}

/** Drive the real fire path and await the fire-and-forget agent:invoke chain. */
async function fireReflection(
  fire: {
    bus: HookBus;
    invokeDone: Promise<void>;
  },
  row: RoutineRow = reflectionRow(),
): Promise<void> {
  const pending: PendingFires = new Map();
  const run = createFireRoutine({ bus: fire.bus, pending } as FireDeps);
  await run(row, 'tick');
  // agent:invoke is fire-and-forget; await its completion deterministically.
  await fire.invokeDone;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_authored');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skills');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_skills');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_attachments');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skill_files');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_catalog_requests');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_quarantine');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_approved_caps');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('skill-crystallization wiring canary (TASK-178)', () => {
  it('reflection fire → authored instruction-only skill → active + proposed event (real propose, real owner)', async () => {
    const h = await makeSkillsHarness();
    const proposed: SkillsProposedEvent[] = [];
    h.bus.subscribe<SkillsProposedEvent>('skills:proposed', '@test', async (_c, e) => {
      proposed.push(e);
      return undefined;
    });

    let proposeOut: SkillsProposeOutput | undefined;
    let invokeCtx: AgentContext | undefined;
    const fire = makeFireBus(async (ctx) => {
      invokeCtx = ctx;
      // The reflection turn authors an instruction-only skill and proposes it
      // through the REAL skills:propose with the REAL owner (ctx.userId), exactly
      // as a runner would over skill.propose.
      proposeOut = await h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
        'skills:propose',
        ctx,
        {
          ownerUserId: ctx.userId,
          agentId: ctx.agentId,
          manifestYaml: INSTRUCTION_ONLY_MANIFEST,
          bodyMd: '# Commit style\nUse conventional commits.',
          files: [],
          origin: 'authored',
          capabilityProposal: emptyCaps,
        },
      );
      return { kind: 'complete', messages: [] };
    });

    await fireReflection(fire);

    // The fire path produced a real ctx with a real owner.
    expect(invokeCtx?.userId).toBe('u1');
    expect(invokeCtx?.agentId).toBe('a1');
    // The real propose gate landed the instruction-only authored skill active.
    expect(proposeOut).toEqual({ skillId: 'commit-style', status: 'active' });
    // skills:proposed fired so the orchestrator re-spawns the session next turn.
    expect(proposed).toEqual([
      { ownerUserId: 'u1', agentId: 'a1', skillId: 'commit-style', status: 'active' },
    ]);

    // And it's visible to the agent's authored listing (the projection source).
    const listed = await h.bus.call<SkillsListAuthoredInput, SkillsListAuthoredOutput>(
      'skills:list-authored',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1' },
    );
    expect(listed.skills).toHaveLength(1);
    expect(listed.skills[0]).toMatchObject({ skillId: 'commit-style', status: 'active' });
  });

  it('capability-fence: a non-authored proposal lands pending, never auto-active', async () => {
    // TASK-100 — a skill carries no caps; the fence keeping an un-vetted skill
    // OUT of the auto-active path is the ORIGIN axis. A self-authored reflection
    // skill is `authored` → active; anything pulled from outside / needing human
    // approval is non-authored → pending. (A connector's reach is separately
    // gated by the connector approval card — the design's "connector declared →
    // pending".) We drive the real propose through the real fire path.
    const h = await makeSkillsHarness();
    let proposeOut: SkillsProposeOutput | undefined;
    const fire = makeFireBus(async (ctx) => {
      proposeOut = await h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
        'skills:propose',
        ctx,
        {
          ownerUserId: ctx.userId,
          agentId: ctx.agentId,
          manifestYaml: INSTRUCTION_ONLY_MANIFEST,
          bodyMd: '# body\n',
          files: [],
          origin: 'imported',
          capabilityProposal: emptyCaps,
        },
      );
      return { kind: 'complete', messages: [] };
    });

    await fireReflection(fire);

    expect(proposeOut?.skillId).toBe('commit-style');
    expect(proposeOut?.status).toBe('pending');

    const listed = await h.bus.call<SkillsListAuthoredInput, SkillsListAuthoredOutput>(
      'skills:list-authored',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1' },
    );
    expect(listed.skills[0]?.status).toBe('pending');
  });

  it('no-self-reflection: the fire path stamps source=routine, so a memory-observer-shaped guard skips', async () => {
    // The real createFireRoutine stamps source:'routine' on the fire ctx
    // (PR-A/TASK-181, host-side, unforgeable by the runner). A chat:end
    // subscriber shaped like the memory observer's guard must skip it, so the
    // reflection turn never pollutes the agent's own memory. We assert the
    // source-stamped ctx the fire path produces — the established TASK-176 path
    // the no-self-reflection guarantee is built on. (No skills harness needed:
    // this exercises the routine-origin signal + the guard, not the propose path.)

    // A stand-in for the memory observer's extraction LLM. It must NOT run for
    // a routine-origin turn.
    const observerExtraction = vi.fn();
    // The guard, copied from @ax/memory-strata's chat:end observer (plugin.ts):
    //   if (ctx.source === 'routine') return undefined;
    const observerGuard = (ctx: AgentContext): void => {
      if (ctx.source === 'routine') return; // skip — don't reflect on automated turns
      observerExtraction();
    };

    let invokeCtx: AgentContext | undefined;
    const fire = makeFireBus(async (ctx) => {
      invokeCtx = ctx;
      // The turn ends; the host would fire chat:end with this ctx. Run the
      // observer-shaped guard against the SAME source-stamped ctx.
      observerGuard(ctx);
      return { kind: 'complete', messages: [] };
    });

    await fireReflection(fire);

    // The fire ctx really carries source:'routine' (not hand-set in the test).
    expect(invokeCtx?.source).toBe('routine');
    // So the observer-shaped guard skipped — no memory extraction on a routine turn.
    expect(observerExtraction).not.toHaveBeenCalled();

    // Control: a user-origin turn (no source) does NOT skip — the guard runs.
    observerExtraction.mockClear();
    const userCtx = makeAgentContext({
      reqId: 'r-user',
      sessionId: 's-user',
      agentId: 'a1',
      userId: 'u1',
    });
    expect(userCtx.source).toBeUndefined();
    observerGuard(userCtx);
    expect(observerExtraction).toHaveBeenCalledTimes(1);
  });

  it('recurrence prompt-guard: SKILL_REFLECTION_PROMPT carries the gating clauses', () => {
    // Behavioral recurrence-gating (does the model actually crystallize only
    // ≥2-conversation procedures) is the MANUAL-ACCEPTANCE walk, NOT this unit
    // test — a unit test has no real LLM judgment. This guards the IP against a
    // silent regression of the clauses the design requires.
    const p = SKILL_REFLECTION_PROMPT;
    // Recurrence ≥2 distinct conversations (the structural inversion of Hermes).
    expect(p).toMatch(/2 DISTINCT past conversations/);
    expect(p).toMatch(/at least 2 DISTINCT past conversations/);
    // A no-op is the correct default (do not invent work).
    expect(p).toMatch(/A pass that changes nothing is the correct/);
    // Prefer patch over create.
    expect(p).toMatch(/prefer patch over create/i);
    expect(p).toMatch(/PATCH it/);
    // Hard cap: ≤3 author/patch ops per pass.
    expect(p).toMatch(/At most 3 author\/patch operations/);
    // Explicit anti-pattern list.
    expect(p).toMatch(/Do NOT crystallize/);
    expect(p).toMatch(/environment-dependent failures/);
    expect(p).toMatch(/one-off\/transient errors/);
    // Instruction-only by default.
    expect(p).toMatch(/INSTRUCTION-ONLY/);
    // Short-circuit marker + silence token contract: the prompt instructs the
    // turn to end by replying with the REFLECTION_DONE token (the closing
    // sentence carries a trailing period; the routine's silence detection
    // matches the token itself, seeded as silence_token = 'REFLECTION_DONE').
    expect(p).toMatch(/\.ax\/skill-reflection\/last-run\.json/);
    expect(p).toContain('REFLECTION_DONE');
    expect(p.trim()).toMatch(/REFLECTION_DONE\.?$/);
  });
});
