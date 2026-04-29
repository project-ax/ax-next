import { describe, it, expect } from 'vitest';
import { createTestHarness } from '../harness.js';
import {
  createTestProxyPlugin,
  decodeScript,
  type StubRunnerScript,
} from '../index.js';

interface OpenSessionOutput {
  proxyEndpoint: string;
  caCertPem: string;
  envMap: Record<string, string>;
}

const PROXY_OPEN_INPUT = {
  sessionId: 's1',
  userId: 'u1',
  agentId: 'a1',
  allowlist: ['api.anthropic.com'],
  credentials: {},
};

describe('createTestProxyPlugin', () => {
  it('registers proxy:open-session returning a dummy proxyConfig with the encoded script in envMap', async () => {
    const script: StubRunnerScript = {
      entries: [{ kind: 'finish', reason: 'end_turn' }],
    };
    const plugin = createTestProxyPlugin({ script });
    const h = await createTestHarness({ plugins: [plugin] });
    try {
      const result = await h.bus.call<unknown, OpenSessionOutput>(
        'proxy:open-session',
        h.ctx(),
        PROXY_OPEN_INPUT,
      );
      // Critical: tcp:// not http:// — the orchestrator's endpointToProxyConfig
      // rejects any other scheme. Port 1 is unassigned so nothing is ever
      // actually reached even though the sandbox subprocess gets the address.
      expect(result.proxyEndpoint).toBe('tcp://127.0.0.1:1');
      expect(typeof result.caCertPem).toBe('string');
      expect(result.caCertPem).toMatch(/BEGIN CERTIFICATE/);
      expect(result.envMap.AX_TEST_STUB_SCRIPT).toBeDefined();
      expect(typeof result.envMap.AX_TEST_STUB_SCRIPT).toBe('string');
    } finally {
      await h.close();
    }
  });

  it('registers proxy:close-session as a no-op', async () => {
    const plugin = createTestProxyPlugin({
      script: { entries: [{ kind: 'finish', reason: 'end_turn' }] },
    });
    const h = await createTestHarness({ plugins: [plugin] });
    try {
      const result = await h.bus.call<unknown, Record<string, never>>(
        'proxy:close-session',
        h.ctx(),
        { sessionId: 's1' },
      );
      expect(result).toEqual({});
    } finally {
      await h.close();
    }
  });

  it('encodes the script as base64 in envMap (round-trips through decodeScript)', async () => {
    const script: StubRunnerScript = {
      entries: [
        { kind: 'assistant-text', content: 'hello world' },
        {
          kind: 'tool-call',
          name: 'test-host-echo',
          input: { text: 'hi' },
          executesIn: 'host',
          expectPostCall: true,
        },
        { kind: 'finish', reason: 'end_turn' },
      ],
    };
    const plugin = createTestProxyPlugin({ script });
    const h = await createTestHarness({ plugins: [plugin] });
    try {
      const result = await h.bus.call<unknown, OpenSessionOutput>(
        'proxy:open-session',
        h.ctx(),
        PROXY_OPEN_INPUT,
      );
      const encoded = result.envMap.AX_TEST_STUB_SCRIPT!;
      // base64 round-trip: decodeScript handles base64 → JSON → schema parse.
      const decoded = decodeScript(encoded);
      expect(decoded).toEqual(script);
    } finally {
      await h.close();
    }
  });

  it('merges envExtra after AX_TEST_STUB_SCRIPT', async () => {
    const script: StubRunnerScript = {
      entries: [{ kind: 'finish', reason: 'end_turn' }],
    };
    const plugin = createTestProxyPlugin({
      script,
      envExtra: { AX_TEST_OTHER: 'v', AX_TEST_FLAG: '1' },
    });
    const h = await createTestHarness({ plugins: [plugin] });
    try {
      const result = await h.bus.call<unknown, OpenSessionOutput>(
        'proxy:open-session',
        h.ctx(),
        PROXY_OPEN_INPUT,
      );
      expect(result.envMap.AX_TEST_STUB_SCRIPT).toBeDefined();
      expect(result.envMap.AX_TEST_OTHER).toBe('v');
      expect(result.envMap.AX_TEST_FLAG).toBe('1');
    } finally {
      await h.close();
    }
  });
});
