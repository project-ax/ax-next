import { describe, it, expect } from 'vitest';
import type { ToolDescriptor } from '@ax/ipc-protocol';
import { createLocalDispatcher } from '../local-dispatcher.js';
import { buildSandboxToolEntries } from '../sandbox-mcp-server.js';

const sampleSandboxDescriptor: ToolDescriptor = {
  name: 'echo_local',
  description: 'echo (sandbox-executed)',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  executesIn: 'sandbox',
};

const sampleHostDescriptor: ToolDescriptor = {
  ...sampleSandboxDescriptor,
  name: 'echo_host',
  executesIn: 'host',
};

describe('buildSandboxToolEntries', () => {
  it('filters to executesIn=sandbox tools only', () => {
    const dispatcher = createLocalDispatcher();
    dispatcher.register('echo_local', async (call) => ({ echoed: call.input }));
    const entries = buildSandboxToolEntries(dispatcher, [
      sampleSandboxDescriptor,
      sampleHostDescriptor,
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('echo_local');
  });

  it('dispatches to local-dispatcher in-process (no IPC)', async () => {
    const dispatcher = createLocalDispatcher();
    let dispatched = 0;
    dispatcher.register('echo_local', async (call) => {
      dispatched += 1;
      return { input: call.input, name: call.name };
    });
    const [entry] = buildSandboxToolEntries(dispatcher, [sampleSandboxDescriptor]);

    // The SDK calls `entry.handler(args)` with the model's parsed input.
    const out = await entry.handler({ text: 'hi' }, { signal: undefined } as never);
    expect(dispatched).toBe(1);
    expect(out.content[0].type).toBe('text');
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.input).toEqual({ text: 'hi' });
    expect(parsed.name).toBe('echo_local');
    expect(out.isError ?? false).toBe(false);
  });

  it('returns isError on executor failure with the message', async () => {
    const dispatcher = createLocalDispatcher();
    dispatcher.register('echo_local', async () => {
      throw new Error('artifact-path-not-publishable: bad prefix');
    });
    const [entry] = buildSandboxToolEntries(dispatcher, [sampleSandboxDescriptor]);
    const out = await entry.handler({ text: 'x' }, { signal: undefined } as never);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('artifact-path-not-publishable');
  });

  it('errors on a sandbox descriptor with no registered executor', async () => {
    const dispatcher = createLocalDispatcher();
    // Note: no dispatcher.register for echo_local.
    const [entry] = buildSandboxToolEntries(dispatcher, [sampleSandboxDescriptor]);
    const out = await entry.handler({ text: 'x' }, { signal: undefined } as never);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/echo_local/);
  });
});
