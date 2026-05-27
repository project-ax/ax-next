import { PluginError } from '@ax/core';

const PLUGIN_NAME = '@ax/host-grants';

// Exact-match allowlist hostnames only: no wildcards, no ports, no schemes,
// no uppercase. Re-implemented here (NOT imported from @ax/credential-proxy)
// per invariant I2 — each trust boundary validates independently.
const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function assertValidHost(host: string): void {
  if (typeof host !== 'string' || !HOST_RE.test(host)) {
    throw new PluginError({
      code: 'invalid-host',
      plugin: PLUGIN_NAME,
      message: `invalid host: ${String(host)}`,
    });
  }
}
