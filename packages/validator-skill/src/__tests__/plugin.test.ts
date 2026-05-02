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
          path: '.ax/skills/foo/SKILL.md',
          kind: 'put',
          content: enc.encode('# no frontmatter'),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(true);
    if (decision.rejected) {
      expect(decision.reason).toContain('.ax/skills/foo/SKILL.md');
      expect(decision.reason).toContain('frontmatter');
    }
  });

  it('vetoes a SKILL.md add missing required name', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        {
          path: '.ax/skills/bar/SKILL.md',
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
          path: '.ax/skills/foo/SKILL.md',
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
      changes: [{ path: '.ax/skills/foo/SKILL.md', kind: 'delete' }],
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
          path: '.ax/skills/good/SKILL.md',
          kind: 'put',
          content: enc.encode('---\nname: good\ndescription: ok\n---\n'),
        },
        // Invalid SKILL.md — should veto the whole batch.
        {
          path: '.ax/skills/bad/SKILL.md',
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
      expect(decision.reason).toContain('.ax/skills/bad/SKILL.md');
    }
  });

  it('does NOT match files that look like SKILL.md but are at the wrong depth', async () => {
    // Allowed (not a SKILL.md location): direct .ax/skills/SKILL.md
    // (no skill-name segment) doesn't match the pattern.
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        {
          path: '.ax/skills/SKILL.md', // no skill-name segment
          kind: 'put',
          content: enc.encode('# not a real SKILL.md location'),
        },
      ],
      parent: null,
      reason: 'turn',
    });
    expect(decision.rejected).toBe(false);
  });

  it('does NOT match files that look like SKILL.md outside .ax/skills/', async () => {
    const { bus, ctx } = await bootstrapWith([createValidatorSkillPlugin()]);
    const decision = await bus.fire('workspace:pre-apply', ctx, {
      changes: [
        // Different namespace — pre-apply already filtered to .ax/, but
        // even within .ax/, only .ax/skills/<name>/SKILL.md matches.
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
          path: '.ax/skills/foo/SKILL.md',
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
});
