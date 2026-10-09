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
 *   1. wiring — the registered routine services (from @ax/routines) drive a stub
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
 *      (The REAL observer that carried this guard was @ax/memory-strata's,
 *      deleted in TASK-608. @ax/memory's observer deliberately does NOT skip
 *      routine turns, so no in-tree subscriber enforces this via a skip today. TASK-611
 *      turned skill-reflection back on under facts memory; its prompt tells
 *      the model not to count rows about reflection passes or skills. TASK-616
 *      then chose attribution over a skip: a routine turn's rows are stored
 *      with no conversation, so they never count toward the recurrence gate.)
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
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import {
  type HookBus,
  makeAgentContext,
  type AgentContext,
  type ServiceHandler,
} from '@ax/core';
import {
  createRoutinesPlugin,
  SKILL_REFLECTION_PROMPT,
} from '@ax/routines';
import { createAgentsPlugin } from '@ax/agents';
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

/** Use the registered DB services and real agent ACL for the reflection turn. */
async function makeFireBus(invoke: (ctx: AgentContext) => Promise<unknown>): Promise<{
  bus: HookBus; agentId: string; owner: AgentContext;
}> {
  const unusedApproval = async () => { throw new Error('Human services must not call tool authorization'); };
  const h = await createTestHarness({
    services: {
      'tool:register': async () => ({}),
      'decisions:authorize-routine-call': unusedApproval,
      'decisions:settle-routine-call': unusedApproval,
      'http:register-route': httpRegisterRouteStub,
      'auth:require-user': async ctx => ({ user: { id: ctx.userId, isAdmin: false } }),
      'auth:get-user': async (_ctx, raw) => ({ id: (raw as { userId: string }).userId, isAdmin: false }),
      'credentials:get': async () => null,
      'credentials:set': async () => { throw new Error('No secret in reflection'); },
      'credentials:delete': async () => undefined,
      'conversations:find-or-create': async () => ({ conversation: { conversationId: 'cnv_reflection' }, created: true }),
      'conversations:create': async () => ({ conversationId: 'cnv_reflection' }),
      'conversations:drop-turn': async () => undefined,
      'conversations:hide': async () => undefined,
      'agent:invoke': async ctx => {
        const result = await invoke(ctx);
        await liveBus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, turnId: 'reflection-turn', contentBlocks: [{ type: 'text', text: 'REFLECTION_DONE' }] });
        return result;
      },
    },
    plugins: [createDatabasePostgresPlugin({ connectionString }), createAgentsPlugin(), createRoutinesPlugin({ tickIntervalMs: 3600000 })],
  });
  harnesses.push(h); const liveBus = h.bus;
  const owner = makeAgentContext({ userId: 'u1', agentId: 'create', sessionId: 'reflection-test' });
  const { agent } = await h.bus.call<unknown, { agent: { id: string } }>('agents:create', owner, {
    actor: { userId: 'u1', isAdmin: false },
    input: { displayName: 'Reflection', model: 'anthropic/claude-sonnet-4-6', allowedTools: [], mcpConfigIds: [], visibility: 'personal' },
  });
  return { bus: h.bus, agentId: agent.id, owner };
}

async function fireReflection(fire: Awaited<ReturnType<typeof makeFireBus>>): Promise<void> {
  const row = await fire.bus.call<unknown, { routineId: string; revision: string }>('routines:create', fire.owner, {
    agentId: fire.agentId, requestId: 'create-reflection',
    definition: { name: 'skill-reflection', promptBody: SKILL_REFLECTION_PROMPT, trigger: { kind: 'interval', every: '24h' }, conversation: 'per-fire', silenceToken: 'REFLECTION_DONE', silenceMaxChars: 4000 },
  });
  await fire.bus.call('routines:fire-now', fire.owner, { agentId: fire.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: 'fire-reflection' });
  await vi.waitFor(async () => {
    const result = await fire.bus.call<unknown, { fires: Array<{ status: string }> }>('routines:recent-fires', fire.owner, { agentId: fire.agentId, routineId: row.routineId });
    expect(result.fires[0]?.status).toBe('silenced');
  });
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
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
    const fire = await makeFireBus(async (ctx) => {
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
    expect(invokeCtx?.agentId).toBe(fire.agentId);
    // The real propose gate landed the instruction-only authored skill active.
    expect(proposeOut).toEqual({ skillId: 'commit-style', status: 'active' });
    // skills:proposed fired so the orchestrator re-spawns the session next turn.
    expect(proposed).toEqual([
      { ownerUserId: 'u1', agentId: fire.agentId, skillId: 'commit-style', status: 'active' },
    ]);

    // And it's visible to the agent's authored listing (the projection source).
    const listed = await h.bus.call<SkillsListAuthoredInput, SkillsListAuthoredOutput>(
      'skills:list-authored',
      h.ctx(),
      { ownerUserId: 'u1', agentId: fire.agentId },
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
    const fire = await makeFireBus(async (ctx) => {
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
      { ownerUserId: 'u1', agentId: fire.agentId },
    );
    expect(listed.skills[0]?.status).toBe('pending');
  });

  it('no-self-reflection: the fire path stamps source=routine, so a memory-observer-shaped guard skips', async () => {
    // The registered routine fire stamps source:'routine' on the fire ctx
    // (PR-A/TASK-181, host-side, unforgeable by the runner). A chat:end
    // subscriber shaped like the memory observer's guard must skip it, so the
    // reflection turn never pollutes the agent's own memory. We assert the
    // source-stamped ctx the fire path produces — the established TASK-176 path
    // the no-self-reflection guarantee is built on. (No skills harness needed:
    // this exercises the routine-origin signal + the guard, not the propose path.)

    // A stand-in for the memory observer's extraction LLM. It must NOT run for
    // a routine-origin turn.
    const observerExtraction = vi.fn();
    // The guard, copied from @ax/memory-strata's chat:end observer (plugin.ts;
    // deleted in TASK-608 — @ax/memory has no equivalent):
    //   if (ctx.source === 'routine') return undefined;
    const observerGuard = (ctx: AgentContext): void => {
      if (ctx.source === 'routine') return; // skip — don't reflect on automated turns
      observerExtraction();
    };

    let invokeCtx: AgentContext | undefined;
    const fire = await makeFireBus(async (ctx) => {
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
    // TASK-611: the recurrence signal is `memory_recall`'s per-answer
    // conversation numbers (Strata's `source_conversations` frontmatter went
    // with Strata in TASK-608), and still NOT a transcript grep (TASK-67
    // gitignores `.claude/projects/` out of /agent, so a transcript grep always
    // saw only the current session and always no-op'd). Lock in:
    //   - the prompt names the signal it reads and the >=2-numbers rule,
    //   - numbers are compared within ONE answer (they are per-answer ordinals),
    //   - rows saved outside a conversation, and rows about reflection itself,
    //     do not count,
    //   - no Strata-era path survives, and
    //   - it does not instruct the agent to grep `.claude/projects/` transcripts.
    expect(p).toMatch(/memory_recall/);
    expect(p).toMatch(/2 or more different conversation numbers in the same answer/);
    expect(p).toMatch(/only comparable within ONE answer/);
    expect(p).toMatch(/Rows marked "-" were saved outside a conversation and do not count/);
    expect(p).toMatch(/Rows about these reflection passes, or about skills you created or proposed, do not count/);
    expect(p).not.toMatch(/source_conversations/);
    expect(p).not.toMatch(/memory\/docs/);
    expect(p).not.toMatch(/memory\/system/);
    expect(p).not.toMatch(/\.claude\/projects/);
    expect(p).not.toMatch(/\.jsonl/);
    expect(p.toLowerCase()).not.toContain('grep your own transcripts');
    // TASK-188: the earlier wording carried a *residual* "do NOT grep
    // transcripts" clause in the recurrence step. Naming the deprecated path —
    // even to forbid it — still cued the model to go grep `.claude/projects/`
    // transcripts and then second-guess itself (2 of 3 reflection fires in the
    // TASK-180 walk). The recurrence step must reference ONLY the memory_recall
    // recurrence signal and must not mention transcripts or grepping
    // them at all (neither permitting nor prohibiting). Guard the prompt body
    // against re-acquiring any transcript/grep vocabulary.
    expect(p.toLowerCase()).not.toContain('transcript');
    expect(p.toLowerCase()).not.toContain('grep');
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
