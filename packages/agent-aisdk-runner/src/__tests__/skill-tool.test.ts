import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHoldLatch, type PreToolVerdict, type ToolPolicy } from '@ax/agent-runner-core';
import { POLICY_WRAPPED } from '../tools/policy-wrap.js';
import {
  MCP_NOT_LOADED_NOTE,
  SKILL_TOOL_NAME,
  buildSkillTool,
} from '../tools/skill-tool.js';
import { discoverInstalledSkills, type DiscoveredSkill } from '../skills-index.js';

// Same fake as `policy-wrap.test.ts` — the wrapper is already covered there, so
// here the policy exists only to prove `Skill` goes through the ONE gate.
function fakePolicy(over: Partial<ToolPolicy> = {}): ToolPolicy & {
  preToolUse: ReturnType<typeof vi.fn>;
  postToolUse: ReturnType<typeof vi.fn>;
} {
  const policy = {
    preToolUse: vi.fn(
      async (): Promise<PreToolVerdict> => ({ decision: 'allow' }),
    ),
    postToolUse: vi.fn(async () => ({})),
    ...over,
  };
  return policy as never;
}

const holdLatch = createHoldLatch();

const OPTS = { toolCallId: 'call-1' };

function skill(over: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return {
    id: 'pdf-filler',
    name: 'pdf-filler',
    description: 'Fills in PDF forms',
    dir: '/home/agent/.claude/skills/pdf-filler',
    body: '# pdf-filler\n\nOpen the form, then fill each field.\n',
    hasMcpServers: false,
    ...over,
  };
}

/** Reach into the built record the way the loop will, then call `execute`. */
function executeOf(tools: Record<string, { execute?: unknown }>): (
  input: unknown,
  options: { toolCallId: string; abortSignal?: AbortSignal },
) => Promise<string> {
  const entry = tools[SKILL_TOOL_NAME];
  expect(entry).toBeDefined();
  return entry?.execute as never;
}

describe('buildSkillTool', () => {
  it('registers exactly one tool, named Skill, with a required `name` input', () => {
    const tools = buildSkillTool({ policy: fakePolicy(), skills: [skill()], holdLatch, onHold: () => {}, onToolFailure: () => {}, loadedMcpBundles: new Set() });

    expect(Object.keys(tools)).toEqual([SKILL_TOOL_NAME]);
    const schema = (
      tools[SKILL_TOOL_NAME] as unknown as {
        inputSchema: { jsonSchema: Record<string, unknown> };
      }
    ).inputSchema.jsonSchema;
    expect(schema['type']).toBe('object');
    expect(schema['required']).toEqual(['name']);
    expect((schema['properties'] as Record<string, unknown>)['name']).toMatchObject({
      type: 'string',
    });
  });

  // I₁ — every tool on this runner goes through `wrapWithPolicy`. `Skill` is
  // not special-cased just because it executes in-process.
  it('wraps execute in the policy gate', async () => {
    const policy = fakePolicy();
    const tools = buildSkillTool({ policy, skills: [skill()], holdLatch, onHold: () => {}, onToolFailure: () => {}, loadedMcpBundles: new Set() });
    const execute = executeOf(tools);

    expect(
      (execute as unknown as Record<symbol, unknown>)[POLICY_WRAPPED],
    ).toBe(true);

    await execute({ name: 'pdf-filler' }, OPTS);
    expect(policy.preToolUse).toHaveBeenCalledWith(
      'Skill',
      { name: 'pdf-filler' },
      'call-1',
    );
    expect(policy.postToolUse).toHaveBeenCalled();
  });

  it('returns the body and the bundle directory', async () => {
    const tools = buildSkillTool({ policy: fakePolicy(), skills: [skill()], holdLatch, onHold: () => {}, onToolFailure: () => {}, loadedMcpBundles: new Set() });

    const out = await executeOf(tools)({ name: 'pdf-filler' }, OPTS);

    expect(out).toContain('Open the form, then fill each field.');
    // The dir is what makes the rest of the bundle reachable — the model
    // Read/Bash-es inside it for scripts and references.
    expect(out).toContain('/home/agent/.claude/skills/pdf-filler');
    expect(out).not.toContain(MCP_NOT_LOADED_NOTE);
  });

  it('accepts the bundle directory id when it differs from the manifest name', async () => {
    const tools = buildSkillTool({
      policy: fakePolicy(),
      skills: [skill({ id: 'pdf-filler-v2', name: 'pdf-filler' })],
      holdLatch, onHold: () => {}, onToolFailure: () => {},
      loadedMcpBundles: new Set(),
    });

    await expect(
      executeOf(tools)({ name: 'pdf-filler-v2' }, OPTS),
    ).resolves.toContain('Open the form, then fill each field.');
  });

  // A typo'd skill name is a MODEL MISTAKE to recover from, not a tool failure.
  // Throwing would surface as an error result and teach the model nothing about
  // what it could have called instead.
  it('returns a helpful result listing available names for an unknown skill', async () => {
    const tools = buildSkillTool({
      policy: fakePolicy(),
      skills: [skill(), skill({ id: 'csv-wrangler', name: 'csv-wrangler' })],
      holdLatch, onHold: () => {}, onToolFailure: () => {},
      loadedMcpBundles: new Set(),
    });

    const settled = await executeOf(tools)({ name: 'pdf-fillr' }, OPTS).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );

    expect(settled.status).toBe('fulfilled');
    const out = settled.status === 'fulfilled' ? settled.value : '';
    expect(out).toContain('pdf-fillr');
    expect(out).toContain('pdf-filler');
    expect(out).toContain('csv-wrangler');
  });

  it('returns a helpful result for a missing or non-string name', async () => {
    const tools = buildSkillTool({ policy: fakePolicy(), skills: [skill()], holdLatch, onHold: () => {}, onToolFailure: () => {}, loadedMcpBundles: new Set() });
    const execute = executeOf(tools);

    await expect(execute({}, OPTS)).resolves.toContain('pdf-filler');
    await expect(execute({ name: 42 }, OPTS)).resolves.toContain('pdf-filler');
  });

  it('registers nothing when no skills are installed', () => {
    expect(buildSkillTool({ policy: fakePolicy(), skills: [], holdLatch, onHold: () => {}, onToolFailure: () => {}, loadedMcpBundles: new Set() })).toEqual({});
  });

  it('surfaces a policy denial as the tool result (inherited from the wrapper)', async () => {
    const policy = fakePolicy({
      preToolUse: vi.fn(async () => ({
        decision: 'deny' as const,
        reason: 'skills are disabled for this session',
        cause: 'policy' as const,
      })),
    } as never);
    const tools = buildSkillTool({ policy, skills: [skill()], holdLatch, onHold: () => {}, onToolFailure: () => {}, loadedMcpBundles: new Set() });

    const out = await executeOf(tools)({ name: 'pdf-filler' }, OPTS);

    expect(out).toContain('skills are disabled for this session');
    expect(out).not.toContain('Open the form, then fill each field.');
  });
});

// ---------------------------------------------------------------------------
// TASK-826: connector (HTTP MCP) tools now load on this runner. The `Skill`
// response therefore warns ONLY when a skill's bundle ships MCP servers that did
// NOT load this session — a skill whose servers loaded gets no note, because its
// tools are simply in the tool list. `loadedMcpBundles` holds bundle dir names,
// which are `DiscoveredSkill.id`.
// ---------------------------------------------------------------------------
describe('skills declaring mcpServers — the connector note', () => {
  let tmpRoot: string;
  let configDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-skill-tool-'));
    configDir = path.join(tmpRoot, 'claude-config');
    const dir = path.join(configDir, 'skills', 'linear-helper');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      '---\nname: linear-helper\ndescription: Works Linear issues\n---\n# linear-helper\n\nUse the linear MCP tools to triage.\n',
      'utf8',
    );
    // What `materializeInstalledSkillsFromEnv` writes for a skill with servers.
    await fs.writeFile(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { linear: { url: 'https://mcp.linear.app/sse', type: 'http' } },
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  /** Build the tool for `skills` + `loadedMcpBundles`, call `Skill({ name })`. */
  async function run(
    skills: DiscoveredSkill[],
    loadedMcpBundles: ReadonlySet<string>,
    name: string,
  ): Promise<string> {
    const tools = buildSkillTool({
      policy: fakePolicy(),
      skills,
      holdLatch,
      onHold: () => {},
      onToolFailure: () => {},
      loadedMcpBundles,
    });
    return executeOf(tools)({ name }, OPTS);
  }

  it('notes plainly when a skill’s connector tools did not load this session', async () => {
    const out = await run(
      [skill({ id: 'conn-a', name: 'conn-a', hasMcpServers: true })],
      new Set(),
      'conn-a',
    );
    expect(out).toContain(MCP_NOT_LOADED_NOTE);
  });

  it('adds no note when the skill’s connector tools loaded', async () => {
    const out = await run(
      [skill({ id: 'conn-a', name: 'conn-a', hasMcpServers: true })],
      new Set(['conn-a']),
      'conn-a',
    );
    expect(out).not.toContain(MCP_NOT_LOADED_NOTE);
    expect(out).not.toMatch(/not available on this runner/i);
  });

  // `loadedMcpBundles` is keyed by the bundle DIRECTORY name; discovery's `id`
  // is that same directory name. Prove the two meet end to end, with a skill
  // discovered from a real projection rather than a hand-built fixture.
  it('matches loadedMcpBundles against the discovered bundle directory id', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const skills = await discoverInstalledSkills({ configDir });
    expect(skills.map((s) => s.id)).toEqual(['linear-helper']);
    expect(skills[0]?.hasMcpServers).toBe(true);

    const loaded = await run(skills, new Set(['linear-helper']), 'linear-helper');
    expect(loaded).toContain('Use the linear MCP tools to triage.');
    expect(loaded).not.toContain(MCP_NOT_LOADED_NOTE);

    const notLoaded = await run(skills, new Set(), 'linear-helper');
    expect(notLoaded).toContain('Use the linear MCP tools to triage.');
    expect(notLoaded).toContain(MCP_NOT_LOADED_NOTE);
  });
});
