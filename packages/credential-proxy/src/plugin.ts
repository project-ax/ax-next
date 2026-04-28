import type { Plugin } from '@ax/core';

export interface CredentialProxyConfig {
  listen: { kind: 'unix'; path: string } | { kind: 'tcp'; host?: string; port?: number };
  caDir?: string;
}

export function createCredentialProxyPlugin(_config: CredentialProxyConfig): Plugin {
  return {
    manifest: {
      name: '@ax/credential-proxy',
      version: '0.0.0',
      registers: ['proxy:open-session', 'proxy:rotate-session', 'proxy:close-session'],
      calls: ['credentials:get'],
      subscribes: [],
    },
    init() {
      throw new Error('not implemented');
    },
  };
}
