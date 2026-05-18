import { describe, it, expect, vi } from 'vitest';
import {
  type AgentContext,
  type HookBus,
  type ToolDescriptor,
} from '@ax/core';
import { createToolArtifactPublishPlugin } from '../plugin.js';
import { ARTIFACT_PUBLISH_TOOL_NAME } from '../descriptor.js';

function fakeBus(): {
  bus: HookBus;
  calls: Array<{ hook: string; payload: unknown }>;
} {
  const calls: Array<{ hook: string; payload: unknown }> = [];
  const bus = {
    call: vi.fn(async (hook: string, _ctx: AgentContext, payload: unknown) => {
      calls.push({ hook, payload });
      return { ok: true };
    }),
    registerService: vi.fn(),
    subscribe: vi.fn(),
    fire: vi.fn(),
  } as unknown as HookBus;
  return { bus, calls };
}

describe('createToolArtifactPublishPlugin', () => {
  it('declares manifest with tool:register in calls', () => {
    const plugin = createToolArtifactPublishPlugin();
    expect(plugin.manifest.name).toBe('@ax/tool-artifact-publish');
    expect(plugin.manifest.calls).toContain('tool:register');
    expect(plugin.manifest.registers ?? []).not.toContain(
      `tool:execute:${ARTIFACT_PUBLISH_TOOL_NAME}`,
    );
  });

  it('registers the descriptor on init', async () => {
    const plugin = createToolArtifactPublishPlugin();
    const { bus, calls } = fakeBus();
    await plugin.init({ bus, config: {} as never });
    const registerCall = calls.find((c) => c.hook === 'tool:register');
    expect(registerCall).toBeDefined();
    const desc = registerCall!.payload as ToolDescriptor;
    expect(desc.name).toBe(ARTIFACT_PUBLISH_TOOL_NAME);
    expect(desc.executesIn).toBe('sandbox');
  });
});
