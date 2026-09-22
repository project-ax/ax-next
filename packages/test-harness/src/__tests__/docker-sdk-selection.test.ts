import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const consumerRequire = createRequire(join(repo, 'packages/storage-postgres/package.json'));
const sdkRequire = createRequire(consumerRequire.resolve('@testcontainers/postgresql'));
const build = dirname(sdkRequire.resolve('testcontainers'));
const clientSource = readFileSync(join(build, 'container-runtime/clients/client.js'), 'utf8');
const strategySource = readFileSync(join(build, 'container-runtime/strategies/configuration-strategy.js'), 'utf8');
const endpoint = 'unix:///explicit/docker.sock';

type RuntimeClient = { container: { dockerode: { options: { socketPath: string } } } };

function runtime(opts: { strict: boolean; failExplicit?: boolean; cachedHost?: string; changeDuringInit?: boolean }) {
  const env: NodeJS.ProcessEnv = { DOCKER_HOST: endpoint };
  if (opts.strict) env.AX_TESTCONTAINERS_STRICT_ENDPOINT = 'true';
  const attempts: string[] = [];
  const configRead = vi.fn(async () => ({ dockerHost: opts.cachedHost ?? endpoint }));
  function moduleOf(source: string, dependencies: Record<string, unknown>): Record<string, unknown> {
    const module = { exports: {} as Record<string, unknown> };
    runInNewContext(source, {
      module,
      exports: module.exports,
      process: { env, version: process.version, arch: process.arch, platform: process.platform },
      Buffer,
      require: (name: string) => {
        if (!(name in dependencies)) throw new Error(`Unexpected dependency in SDK fixture: ${name}`);
        return dependencies[name];
      },
    }, { timeout: 1000 });
    return module.exports;
  }
  const strategy = moduleOf(strategySource, {
    'fs/promises': { readFile: vi.fn(async () => Buffer.from('fixture')) },
    path: { resolve: (...parts: string[]) => parts.join('/') },
    url: { URL },
    './utils/config': { getContainerRuntimeConfig: configRead },
  });
  class EmptyStrategy {
    getName() { return 'unused'; }
    async getResult() { return undefined; }
  }
  class FallbackStrategy {
    getName() { return 'fallback'; }
    async getResult() {
      return { uri: 'unix:///fallback/docker.sock', dockerOptions: { socketPath: '/fallback/docker.sock' }, composeEnvironment: {}, allowUserOverrides: true };
    }
  }
  class FakeDocker {
    constructor(readonly options: { socketPath: string }) {}
    async info() {
      attempts.push(this.options.socketPath);
      if (opts.changeDuringInit) env.DOCKER_HOST = 'unix:///changed/docker.sock';
      if (opts.failExplicit && this.options.socketPath === '/explicit/docker.sock') throw new Error('explicit endpoint unavailable');
      return { ServerVersion: '26.1.0', OperatingSystem: 'fixture', OSType: 'linux', IndexServerAddress: 'fixture' };
    }
  }
  class ClientWrapper {
    constructor(readonly dockerode: FakeDocker) {}
  }
  const client = moduleOf(clientSource, {
    dockerode: FakeDocker,
    '../../common': { log: { debug() {}, trace() {} }, isDefined: (v: unknown) => v !== undefined, isEmptyString: (v: unknown) => v === '' },
    '../../version': { LIB_VERSION: '11.14.0' },
    '../strategies/configuration-strategy': strategy,
    '../strategies/testcontainers-host-strategy': { TestcontainersHostStrategy: EmptyStrategy },
    '../strategies/unix-socket-strategy': { UnixSocketStrategy: FallbackStrategy },
    '../strategies/rootless-unix-socket-strategy': { RootlessUnixSocketStrategy: EmptyStrategy },
    '../strategies/npipe-socket-strategy': { NpipeSocketStrategy: EmptyStrategy },
    '../utils/lookup-host-ips': { lookupHostIps: async () => [] },
    '../utils/remote-container-runtime-socket-path': { getRemoteContainerRuntimeSocketPath: () => '/fixture.sock' },
    '../utils/resolve-host': { resolveHost: async () => 'fixture' },
    './compose/compose-client': { getComposeClient: async () => ({}) },
    './container/docker-container-client': { DockerContainerClient: ClientWrapper },
    './image/docker-image-client': { DockerImageClient: ClientWrapper },
    './network/docker-network-client': { DockerNetworkClient: ClientWrapper },
  });
  return { env, attempts, configRead, get: client.getContainerRuntimeClient as () => Promise<RuntimeClient> };
}

describe('installed SDK explicit-endpoint selection', () => {
  it('does not consult cached file configuration in strict mode', async () => {
    const sdk = runtime({ strict: true, cachedHost: 'unix:///cached/docker.sock' });
    const client = await sdk.get();
    expect(client.container.dockerode.options.socketPath).toBe('/explicit/docker.sock');
    expect(sdk.configRead).not.toHaveBeenCalled();
    expect(sdk.attempts).toEqual(['/explicit/docker.sock']);
  });

  it('fails explicit initialization rather than selecting an available fallback daemon', async () => {
    const sdk = runtime({ strict: true, failExplicit: true });
    await expect(sdk.get()).rejects.toThrow(/Could not find a working container runtime strategy/);
    expect(sdk.attempts).toEqual(['/explicit/docker.sock']);
  });

  it('retains normal fallback behavior without the opt-in strict flag', async () => {
    const sdk = runtime({ strict: false, failExplicit: true });
    const client = await sdk.get();
    expect(client.container.dockerode.options.socketPath).toBe('/fallback/docker.sock');
    expect(sdk.attempts).toEqual(['/explicit/docker.sock', '/fallback/docker.sock']);
  });

  it('does not reuse a client initialized outside strict mode', async () => {
    const sdk = runtime({ strict: false, cachedHost: 'unix:///cached/docker.sock' });
    await sdk.get();
    sdk.env.AX_TESTCONTAINERS_STRICT_ENDPOINT = 'true';
    await expect(sdk.get()).rejects.toThrow(/initialized outside strict mode/);
    expect(sdk.attempts).toEqual(['/cached/docker.sock']);
  });

  it('does not reuse a strict client after endpoint changes', async () => {
    const sdk = runtime({ strict: true });
    await sdk.get();
    sdk.env.DOCKER_HOST = 'unix:///changed/docker.sock';
    await expect(sdk.get()).rejects.toThrow(/configuration changed/);
    expect(sdk.attempts).toEqual(['/explicit/docker.sock']);
  });

  it('does not cache a client if endpoint settings change during initialization', async () => {
    const sdk = runtime({ strict: true, changeDuringInit: true });
    await expect(sdk.get()).rejects.toThrow(/Could not find a working container runtime strategy/);
    expect(sdk.attempts).toEqual(['/explicit/docker.sock']);
  });

  it('requires the explicit host even if strict mode is called outside the shared wrapper', async () => {
    const sdk = runtime({ strict: true });
    delete sdk.env.DOCKER_HOST;
    await expect(sdk.get()).rejects.toThrow(/requires DOCKER_HOST/);
    expect(sdk.attempts).toEqual([]);
  });
});
