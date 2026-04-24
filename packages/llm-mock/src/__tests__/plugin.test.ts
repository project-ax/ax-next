import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import type { LlmRequest, LlmResponse } from '@ax/core';
import { llmMockPlugin } from '../plugin.js';

describe('@ax/llm-mock', () => {
  it('registers llm:call and returns the canned response', async () => {
    const h = await createTestHarness({ plugins: [llmMockPlugin()] });
    expect(h.bus.hasService('llm:call')).toBe(true);

    const res = await h.bus.call<LlmRequest, LlmResponse>(
      'llm:call',
      h.ctx(),
      { messages: [{ role: 'user', content: 'ignored' }] },
    );
    expect(res.assistantMessage).toEqual({ role: 'assistant', content: 'hello' });
    expect(res.toolCalls).toEqual([]);
  });

  it('manifest names @ax/llm-mock as the registering plugin', () => {
    const p = llmMockPlugin();
    expect(p.manifest.name).toBe('@ax/llm-mock');
    expect(p.manifest.registers).toContain('llm:call');
    expect(p.manifest.calls).toEqual([]);
    expect(p.manifest.subscribes).toEqual([]);
  });

  // NOTE: the Week 1-2 "chat:run + llm-mock end-to-end" case lived here
  // because the kernel provided chat:run. In 6.5a chat:run is the
  // @ax/chat-orchestrator plugin's service hook and drives a runner
  // subprocess — llm-mock no longer participates in a host-side loop. The
  // equivalent acceptance lands in Task 15 (subprocess topology).
});
