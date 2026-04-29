import { type AgentContext, type Plugin } from '@ax/core';
import { encodeScript, type StubRunnerScript } from './script-schema.js';

const PLUGIN_NAME = '@ax/test-harness/test-proxy';

// A syntactically-shaped PEM block. Never parsed/validated — the
// chat-orchestrator just shuttles it down to the sandbox subprocess as
// `caCertPem`. The endpoint we hand back below points at port 1, so no
// TLS handshake ever happens against this cert.
const DUMMY_CA_PEM =
  '-----BEGIN CERTIFICATE-----\n' +
  'MIIBkTCB+wIJAJtest-only-never-validated\n' +
  '-----END CERTIFICATE-----\n';

interface OpenSessionOutput {
  proxyEndpoint: string;
  caCertPem: string;
  envMap: Record<string, string>;
}

export interface TestProxyPluginOpts {
  /** Stub-runner script to expose via `AX_TEST_STUB_SCRIPT` in `envMap`. */
  script: StubRunnerScript;
  /** Optional extra envMap entries (merged after the script). */
  envExtra?: Record<string, string>;
}

/**
 * Stub `proxy:open-session` / `proxy:close-session` provider for tests that
 * exercise the chat-orchestrator's proxy gate without spinning up the real
 * `@ax/credential-proxy` (which needs `AX_CREDENTIALS_KEY` + seeded creds).
 *
 * `proxy:open-session` returns a `proxyConfig`-shaped output with:
 *  - `proxyEndpoint: 'tcp://127.0.0.1:1'` — port 1 is unassigned, so the
 *    sandbox subprocess never reaches anything if it tries. The orchestrator's
 *    `endpointToProxyConfig()` translates this to `http://127.0.0.1:1` in the
 *    `ProxyConfig.endpoint` field that ships to the runner.
 *  - `caCertPem`: a never-validated PEM-shaped string.
 *  - `envMap`: the encoded stub-runner script under `AX_TEST_STUB_SCRIPT`,
 *    merged with any caller-supplied `envExtra`.
 *
 * `proxy:close-session` is a no-op returning `{}`.
 */
export function createTestProxyPlugin(opts: TestProxyPluginOpts): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['proxy:open-session', 'proxy:close-session'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      const encoded = encodeScript(opts.script);
      bus.registerService<unknown, OpenSessionOutput>(
        'proxy:open-session',
        PLUGIN_NAME,
        async (_ctx: AgentContext) => ({
          proxyEndpoint: 'tcp://127.0.0.1:1',
          caCertPem: DUMMY_CA_PEM,
          envMap: {
            AX_TEST_STUB_SCRIPT: encoded,
            ...(opts.envExtra ?? {}),
          },
        }),
      );
      bus.registerService<unknown, Record<string, never>>(
        'proxy:close-session',
        PLUGIN_NAME,
        async () => ({}),
      );
    },
  };
}
