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

  it('end-to-end: chat:run with llm-mock loaded completes with "hello"', async () => {
    const h = await createTestHarness({ plugins: [llmMockPlugin()] });
    const outcome = await h.bus.call('chat:run', h.ctx(), {
      message: { role: 'user', content: 'anything' },
    });
    expect(outcome).toMatchObject({ kind: 'complete' });
    if (outcome.kind === 'complete') {
      const last = outcome.messages[outcome.messages.length - 1];
      expect(last).toEqual({ role: 'assistant', content: 'hello' });
    }
  });
});
