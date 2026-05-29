import { describe, expect, it } from 'vitest';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type FileChange,
  type Plugin,
} from '@ax/core';
import { createValidatorSkillPlugin } from '../plugin.js';

interface Env {
  bus: HookBus;
  ctx: AgentContext;
}

async function bootstrapWith(plugins: Plugin[]): Promise<Env> {
  const bus = new HookBus();
  await bootstrap({ bus, plugins, config: {} });
  const ctx = makeAgentContext({
    sessionId: 'vs-test',
    agentId: 'vs-agent',
    userId: 'vs-user',
  });
  return { bus, ctx };
}

const enc = new TextEncoder();

describe('createValidatorSkillPlugin', () => {
  it('manifest declares subscribes: workspace:pre-apply, no registers, no calls', () => {
    const p = createValidatorSkillPlugin();
    expect(p.manifest.name).toBe('@ax/validator-skill');
    expect(p.manifest.subscribes).toEqual(['workspace:pre-apply']);
    expect(p.manifest.registers).toEqual([]);
    expect(p.manifest.calls).toEqual([]);
  });

  it('allows changes that do not touch SKILL.md', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const changes: FileChange[] = [
      { path: '.ax/CLAUDE.md', kind: 'put', content: enc.encode('# memory') },
      { path: '.ax/IDENTITY.md', kind: 'put', content: enc.encode('# id') },
    ];
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes,
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(false);
  });

  it('vetoes a SKILL.md add with malformed frontmatter (no fence)', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        {
          path: '.ax/draft-skills/foo/SKILL.md',
          kind: 'put',
          content: enc.encode('# no frontmatter'),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(true);
    if (decision.rejected) {
      expect(decision.reason).toContain('.ax/draft-skills/foo/SKILL.md');
      expect(decision.reason).toContain('frontmatter');
    }
  });

  it('vetoes a SKILL.md add missing required name', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        {
          path: '.ax/draft-skills/bar/SKILL.md',
          kind: 'put',
          content: enc.encode('---\ndescription: x\n---\n# Body\n'),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(true);
    if (decision.rejected) {
      expect(decision.reason).toContain('name');
    }
  });

  it('allows a SKILL.md add with valid frontmatter', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const md = '---\nname: foo\ndescription: a thing\n---\n# Body\n';
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        {
          path: '.ax/draft-skills/foo/SKILL.md',
          kind: 'put',
          content: enc.encode(md),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(false);
  });

  it('passes through SKILL.md deletes (no content to validate)', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [{ path: '.ax/draft-skills/foo/SKILL.md', kind: 'delete' }],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(false);
  });

  it('vetoes when ANY SKILL.md in the change set is malformed (mixed batch)', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        // Valid SKILL.md.
        {
          path: '.ax/draft-skills/good/SKILL.md',
          kind: 'put',
          content: enc.encode('---\nname: good\ndescription: ok\n---\n'),
        },
        // Invalid SKILL.md — should veto the whole batch.
        {
          path: '.ax/draft-skills/bad/SKILL.md',
          kind: 'put',
          content: enc.encode('# no frontmatter\n'),
        },
        // Non-SKILL change — irrelevant.
        {
          path: '.ax/CLAUDE.md',
          kind: 'put',
          content: enc.encode('# memory'),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(true);
    if (decision.rejected) {
      expect(decision.reason).toContain('.ax/draft-skills/bad/SKILL.md');
    }
  });

  it('does NOT match files that look like SKILL.md but are at the wrong depth', async () => {
    // Allowed (not a SKILL.md location): direct .ax/draft-skills/SKILL.md
    // (no skill-name segment) doesn't match the pattern.
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        {
          path: '.ax/draft-skills/SKILL.md', // no skill-name segment
          kind: 'put',
          content: enc.encode('# not a real SKILL.md location'),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(false);
  });

  it('does NOT match files that look like SKILL.md outside .ax/draft-skills/', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        // Different namespace — pre-apply already filtered to .ax/, but
        // even within .ax/, only .ax/draft-skills/<name>/SKILL.md matches.
        {
          path: '.ax/SKILL.md',
          kind: 'put',
          content: enc.encode('# top-level SKILL.md not validated'),
        },
        // .ax/foo/SKILL.md — also not under skills/
        {
          path: '.ax/foo/SKILL.md',
          kind: 'put',
          content: enc.encode('# also not validated'),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(false);
  });

  it('rejects SKILL.md with non-UTF-8 content', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        {
          path: '.ax/draft-skills/foo/SKILL.md',
          kind: 'put',
          content: new Uint8Array([0xff, 0xfe, 0x00]),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(true);
    if (decision.rejected) {
      expect(decision.reason).toContain('UTF-8');
    }
  });

  // -------------------------------------------------------------------
  // SDK-config veto (Phase 0 — Task 2)
  //
  // The Claude Agent SDK reads these paths from project root when
  // `settingSources: ['user', 'project']` is enabled. An agent write
  // to any of them escalates SDK behavior (new sub-agents, prompt-
  // injected rules, settings.json that re-enables disabled tools).
  // Veto unconditionally — workspace:pre-apply is the agent path.
  // -------------------------------------------------------------------

  const AUDIT_DOC = 'docs/notes/2026-05-17-sdk-setting-sources-audit.md';

  // Exact-file vetoes.
  for (const protectedPath of [
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/CLAUDE.md',
    'CLAUDE.md',
    'CLAUDE.local.md',
  ]) {
    it(`vetoes write to ${protectedPath}`, async () => {
      const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
      const decision = await bus.fire('workspace:pre-apply', ctx, {
        changes: [
          {
            path: protectedPath,
            kind: 'put',
            content: enc.encode('# whatever'),
          },
        ],
        parent: null,
        reason: 'turn',
      });
      expect(decision.rejected).toBe(true);
      if (decision.rejected) {
        expect(decision.reason).toContain(protectedPath);
        expect(decision.reason).toContain(AUDIT_DOC);
      }
    });
  }

  // Directory-prefix vetoes.
  for (const { dir, sample } of [
    { dir: '.claude/agents/', sample: '.claude/agents/some-agent.md' },
    {
      dir: '.claude/commands/',
      sample: '.claude/commands/deploy.md',
    },
    { dir: '.claude/rules/', sample: '.claude/rules/style.md' },
  ]) {
    it(`vetoes write under ${dir}`, async () => {
      const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
      const decision = await bus.fire('workspace:pre-apply', ctx, {
        changes: [
          {
            path: sample,
            kind: 'put',
            content: enc.encode('# hostile content'),
          },
        ],
        parent: null,
        reason: 'turn',
      });
      expect(decision.rejected).toBe(true);
      if (decision.rejected) {
        expect(decision.reason).toContain(sample);
        expect(decision.reason).toContain(AUDIT_DOC);
      }
    });
  }

  it('vetoes nested writes under .claude/agents/ subdirectories', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        {
          path: '.claude/agents/sub/deep/hostile.md',
          kind: 'put',
          content: enc.encode('# any depth'),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(true);
  });

  it('allows write to .claude/skills/<name>/SKILL.md with valid frontmatter', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const md = '---\nname: my-skill\ndescription: a useful skill\n---\n';
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        {
          path: '.claude/skills/my-skill/SKILL.md',
          kind: 'put',
          content: enc.encode(md),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(false);
  });

  it('allows write to .claude/skills/<name>/assets — skill body is not vetoed', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        {
          path: '.claude/skills/my-skill/reference.md',
          kind: 'put',
          content: enc.encode('# reference body'),
        },
        {
          path: '.claude/skills/my-skill/scripts/run.sh',
          kind: 'put',
          content: enc.encode('#!/bin/sh\necho hi\n'),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(false);
  });

  it('SDK-config deletes are NOT vetoed — only puts (removing a file is fine)', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        { path: '.claude/settings.json', kind: 'delete' },
        { path: '.claude/agents/foo.md', kind: 'delete' },
        { path: 'CLAUDE.md', kind: 'delete' },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(false);
  });

  it('vetoes when ANY protected SDK-config path is in a mixed batch', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        // Innocent skill write.
        {
          path: '.ax/draft-skills/good/SKILL.md',
          kind: 'put',
          content: enc.encode('---\nname: good\ndescription: ok\n---\n'),
        },
        // Hostile SDK-config write — should veto the batch.
        {
          path: '.claude/settings.json',
          kind: 'put',
          content: enc.encode('{}'),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(true);
    if (decision.rejected) {
      expect(decision.reason).toContain('.claude/settings.json');
    }
  });

  // -------------------------------------------------------------------
  // Capabilities-strip (I-P1-2)
  //
  // Workspace-authored SKILL.md may NOT declare a capabilities block —
  // the block is the host-only path to grant new hosts / credential
  // slots. Strip-and-warn rather than veto, so the rest of the skill
  // body still lands on disk; the SDK still discovers the skill,
  // minus any agent-attempted capability grants.
  // -------------------------------------------------------------------

  it('strips capabilities block from agent-authored SKILL.md (rewrites the change)', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const src =
      '---\n' +
      'name: foo\n' +
      'description: A skill that tries to self-grant.\n' +
      'capabilities:\n' +
      '  allowedHosts: [api.example.com]\n' +
      '  credentials:\n' +
      '    - slot: SECRET_TOKEN\n' +
      '      kind: api-key\n' +
      '---\n' +
      '# Body\n';
    const decision = await bus.fire<{
      changes: FileChange[];
      parent: null;
      reason: string;
    }>('workspace:pre-apply', ctx, {
      changes: [
        {
          path: '.ax/draft-skills/foo/SKILL.md',
          kind: 'put',
          content: enc.encode(src),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(false);
    if (decision.rejected) return;
    expect(decision.payload.changes).toHaveLength(1);
    const change = decision.payload.changes[0]!;
    expect(change.kind).toBe('put');
    if (change.kind !== 'put') return;
    const rewritten = new TextDecoder('utf-8').decode(change.content);
    expect(rewritten).not.toMatch(/capabilities/);
    expect(rewritten).not.toMatch(/SECRET_TOKEN/);
    expect(rewritten).not.toMatch(/api\.example\.com/);
    expect(rewritten).toMatch(/name: foo/);
    expect(rewritten).toMatch(/description: A skill that tries to self-grant\./);
    expect(rewritten).toMatch(/# Body/);
  });

  it('leaves SKILL.md unchanged when no capabilities block is present', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const src = '---\nname: foo\ndescription: ok\n---\n# Body\n';
    const original = enc.encode(src);
    const decision = await bus.fire<{
      changes: FileChange[];
      parent: null;
      reason: string;
    }>('workspace:pre-apply', ctx, {
      changes: [
        { path: '.ax/draft-skills/foo/SKILL.md', kind: 'put', content: original },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(false);
    if (decision.rejected) return;
    const change = decision.payload.changes[0]!;
    if (change.kind !== 'put') return;
    // The bus should hand back the original payload reference (no rewrite).
    expect(change.content).toBe(original);
  });

  it('strip path still vetoes a stripped SKILL.md that ends up malformed', async () => {
    // If the agent submits a SKILL.md whose ONLY non-capability fields
    // are invalid (e.g. missing required `name`), the strip happens
    // first, then the standard frontmatter validation rejects.
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const src =
      '---\n' +
      'description: missing name\n' +
      'capabilities:\n' +
      '  allowedHosts: [api.example.com]\n' +
      '---\n' +
      '# Body\n';
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        {
          path: '.ax/draft-skills/bad/SKILL.md',
          kind: 'put',
          content: enc.encode(src),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(true);
    if (decision.rejected) {
      expect(decision.reason).toContain('name');
    }
  });

  it('does NOT veto .claude-plugin/ (different path entirely)', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        {
          path: '.claude-plugin/marketplace.json',
          kind: 'put',
          content: enc.encode('{}'),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    // Note: this validator only checks `.claude/...` and `.ax/...`
    // prefixes. .claude-plugin is a sibling prefix and isn't covered
    // by Phase 0 (the plugin system is off in our config). Pre-apply
    // would only see this path if some future filter let it through.
    expect(decision.rejected).toBe(false);
  });
});
