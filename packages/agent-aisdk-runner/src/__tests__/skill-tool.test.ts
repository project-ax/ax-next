import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHoldLatch, type PreToolVerdict, type ToolPolicy } from '@ax/agent-runner-core';
import { POLICY_WRAPPED } from '../tools/policy-wrap.js';
import {
  MCP_UNAVAILABLE_NOTE,
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
    const tools = buildSkillTool({ policy: fakePolicy(), skills: [skill()], holdLatch });

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
    const tools = buildSkillTool({ policy, skills: [skill()], holdLatch });
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
    const tools = buildSkillTool({ policy: fakePolicy(), skills: [skill()], holdLatch });

    const out = await executeOf(tools)({ name: 'pdf-filler' }, OPTS);

    expect(out).toContain('Open the form, then fill each field.');
    // The dir is what makes the rest of the bundle reachable — the model
    // Read/Bash-es inside it for scripts and references.
    expect(out).toContain('/home/agent/.claude/skills/pdf-filler');
    expect(out).not.toContain(MCP_UNAVAILABLE_NOTE);
  });

  it('accepts the bundle directory id when it differs from the manifest name', async () => {
    const tools = buildSkillTool({
      policy: fakePolicy(),
      skills: [skill({ id: 'pdf-filler-v2', name: 'pdf-filler' })],
      holdLatch,
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
      holdLatch,
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
    const tools = buildSkillTool({ policy: fakePolicy(), skills: [skill()], holdLatch });
    const execute = executeOf(tools);

    await expect(execute({}, OPTS)).resolves.toContain('pdf-filler');
    await expect(execute({ name: 42 }, OPTS)).resolves.toContain('pdf-filler');
  });

  it('registers nothing when no skills are installed', () => {
    expect(buildSkillTool({ policy: fakePolicy(), skills: [], holdLatch })).toEqual({});
  });

  it('surfaces a policy denial as the tool result (inherited from the wrapper)', async () => {
    const policy = fakePolicy({
      preToolUse: vi.fn(async () => ({
        decision: 'deny' as const,
        reason: 'skills are disabled for this session',
        cause: 'policy' as const,
      })),
    } as never);
    const tools = buildSkillTool({ policy, skills: [skill()], holdLatch });

    const out = await executeOf(tools)({ name: 'pdf-filler' }, OPTS);

    expect(out).toContain('skills are disabled for this session');
    expect(out).not.toContain('Open the form, then fill each field.');
  });
});

// ---------------------------------------------------------------------------
// Design §8: "The acceptance suite asserts the DEGRADATION, not the capability."
// `ai@7` exports no MCP client and we deliberately did not build one. The bar is
// therefore: a skill whose MCP servers were materialized still loads, still
// appears in the index, and its `Skill` response tells the model the servers are
// gone — so it adapts instead of hallucinating tools that will never resolve.
// ---------------------------------------------------------------------------
describe('skills declaring mcpServers — the documented degradation', () => {
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

  it('loads, indexes, and carries the unavailability note', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const skills = await discoverInstalledSkills({ configDir });
    expect(skills.map((s) => s.id)).toEqual(['linear-helper']);
    expect(skills[0]?.hasMcpServers).toBe(true);

    const tools = buildSkillTool({ policy: fakePolicy(), skills, holdLatch });
    const out = await executeOf(tools)({ name: 'linear-helper' }, OPTS);

    // Still loads — degradation, not removal.
    expect(out).toContain('Use the linear MCP tools to triage.');
    // ...and says so at the moment it matters.
    expect(out).toContain(MCP_UNAVAILABLE_NOTE);
    expect(MCP_UNAVAILABLE_NOTE).toMatch(/not available/i);
  });
});
