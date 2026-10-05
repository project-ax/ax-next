import { TEST_PROXY_AUTH_TOKEN } from '@ax/test-harness';

// Minimal VALID per-session proxy blobs (TASK-838: `proxyConfig` is required on
// the `sandbox:open-session` input, so a session opened without one is refused
// before it is minted). A test whose point is a REJECTION must carry one, so
// the call is refused for its own reason and not merely because proxyConfig is
// missing.
const CA_PEM = '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n';

/** Unix-socket posture (kind / hostPath) — the default plugin config. */
export const TEST_PROXY_CONFIG = {
  unixSocketPath: '/var/run/ax/proxy.sock',
  caCertPem: CA_PEM,
  envMap: {},
  proxyAuthToken: TEST_PROXY_AUTH_TOKEN,
};

/** TCP-Service posture — for configs that set `proxyEndpoint` (agent-sandbox). */
export function testProxyConfigTcp(endpoint: string) {
  return {
    endpoint,
    caCertPem: CA_PEM,
    envMap: {},
    proxyAuthToken: TEST_PROXY_AUTH_TOKEN,
  };
}
