import { TEST_PROXY_AUTH_TOKEN } from '@ax/test-harness';

// Minimal VALID per-session proxy blob (TASK-838: `proxyConfig` is required on
// the `sandbox:open-session` input, so a session opened without one is refused
// before it is minted). Port 1 is unassigned: the stub runners never dial it.
// A test whose point is a REJECTION must spread this in, so the call is refused
// for its own reason and not merely because proxyConfig is missing.
export const TEST_PROXY_CONFIG = {
  endpoint: 'http://127.0.0.1:1',
  caCertPem: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n',
  envMap: {},
  proxyAuthToken: TEST_PROXY_AUTH_TOKEN,
};
