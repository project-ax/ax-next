import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const VERSION_ARGS = ['version', '--format', '{{.Server.Version}}'];
const INFO_ARGS = ['info', '--format', '{{.Containers}} {{.ContainersRunning}}'];
export const DOCKER_PREFLIGHT_TIMEOUT_MS = 45_000;
export const DOCKER_BUSY_CONTAINER_COUNT = 20;

export interface DockerPreflightOptions {
  timeoutMs?: number;
  warn?: (message: string) => void;
}

export interface StartableTestContainer<T> {
  start(): Promise<T>;
}

interface ProbeConfiguration {
  host: string;
  env: NodeJS.ProcessEnv;
  identity: string;
}

let startedConfiguration: string | undefined;

function configurationError(detail: string): Error {
  return new Error(`Docker test configuration: ${detail}`);
}

function configuration(): ProbeConfiguration {
  if (existsSync(join(homedir(), '.testcontainers.properties'))) {
    throw configurationError('per-home .testcontainers.properties overrides are unsupported in explicit-endpoint mode. Move Docker endpoint and TLS settings to the supported environment variables before running these tests.');
  }
  const host = process.env.DOCKER_HOST;
  if (host === undefined || host.length === 0) {
    throw configurationError('set DOCKER_HOST explicitly before running Docker-backed tests. Docker CLI contexts and automatic endpoint discovery are not used.');
  }
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw configurationError('DOCKER_HOST must be a supported explicit Docker endpoint URI.');
  }
  const tcp = url.protocol === 'tcp:' && url.hostname.length > 0 && url.port.length > 0 && (url.pathname === '' || url.pathname === '/');
  const unix = url.protocol === 'unix:' && url.hostname === '' && url.pathname.startsWith('/') && url.pathname.length > 1;
  const pipe = url.protocol === 'npipe:' && url.hostname === '' && url.pathname.startsWith('//./pipe/');
  if ((!tcp && !unix && !pipe) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || /[^\x21-\x7e]|%/.test(host)) {
    throw configurationError('DOCKER_HOST must be an unescaped unix socket, named pipe, or tcp endpoint with an explicit port, without credentials, query, or fragment.');
  }
  if ((process.env.DOCKER_TLS ?? '') !== '') {
    throw configurationError('DOCKER_TLS is CLI-only and is unsupported. Use DOCKER_TLS_VERIFY=1 with an absolute DOCKER_CERT_PATH for verified TCP TLS.');
  }
  const verify = process.env.DOCKER_TLS_VERIFY ?? '';
  if (verify !== '' && verify !== '1') {
    throw configurationError('DOCKER_TLS_VERIFY must be 1 or unset so Docker CLI and Testcontainers agree.');
  }
  const certPath = verify === '1' ? process.env.DOCKER_CERT_PATH : undefined;
  if (verify === '1' && (!tcp || certPath === undefined || !isAbsolute(certPath))) {
    throw configurationError('verified TLS requires a tcp DOCKER_HOST and an absolute DOCKER_CERT_PATH.');
  }
  const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: host };
  delete env.DOCKER_CONTEXT;
  delete env.DOCKER_TLS;
  delete env.DOCKER_TLS_VERIFY;
  delete env.DOCKER_CERT_PATH;
  if (verify === '1') {
    env.DOCKER_TLS_VERIFY = '1';
    env.DOCKER_CERT_PATH = certPath;
  }
  const identity = JSON.stringify([host, verify, certPath ?? null]);
  if (startedConfiguration !== undefined && startedConfiguration !== identity) {
    throw configurationError('the Docker endpoint or TLS configuration changed after a checked start. Run the new configuration in a fresh test process.');
  }
  return { host, env, identity };
}

async function probe(
  args: string[],
  config: ProbeConfiguration,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', [`--host=${config.host}`, ...args], {
      encoding: 'utf8',
      env: config.env,
      signal,
      killSignal: 'SIGKILL',
      maxBuffer: 8192,
    });
    return stdout.trim();
  } catch (error) {
    if (signal.aborted) {
      throw new Error(
        `Docker daemon did not answer its readiness probes within ${timeoutMs} ms. Start or restart Docker, then retry the Docker-backed tests.`,
      );
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'Docker CLI was not found, so the Docker daemon could not be checked. Install Docker or fix PATH before running Docker-backed tests.',
      );
    }
    throw new Error(`Docker daemon readiness probe failed (${args[0]}). Check the explicit Docker endpoint or restart Docker before retrying.`);
  }
}

async function checkDocker(options: DockerPreflightOptions): Promise<ProbeConfiguration> {
  const timeoutMs = options.timeoutMs ?? DOCKER_PREFLIGHT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DOCKER_PREFLIGHT_TIMEOUT_MS) {
    throw new RangeError(`Docker preflight timeout must be an integer from 1 to ${DOCKER_PREFLIGHT_TIMEOUT_MS} ms.`);
  }
  const config = configuration();
  const signal = AbortSignal.timeout(timeoutMs);
  const version = await probe(VERSION_ARGS, config, signal, timeoutMs);
  if (version.length === 0) {
    throw new Error('Docker daemon returned no server version. Start or restart Docker, then retry the Docker-backed tests.');
  }
  const info = await probe(INFO_ARGS, config, signal, timeoutMs);
  const counts = /^(\d+)\s+(\d+)$/.exec(info);
  const total = Number(counts?.[1]);
  const running = Number(counts?.[2]);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(running) || running > total) {
    throw new Error('Docker daemon returned unusable container counts. Check Docker before retrying the Docker-backed tests.');
  }
  if (running >= DOCKER_BUSY_CONTAINER_COUNT) {
    (options.warn ?? console.warn)(`Docker daemon is responding but reports ${running} running containers (${total} total). The host may be loaded; container startup can time out before assertions run.`);
  }
  if (configuration().identity !== config.identity) {
    throw configurationError('the Docker configuration changed during the preflight. Retry with stable endpoint and TLS settings.');
  }
  return config;
}

export async function preflightDocker(options: DockerPreflightOptions = {}): Promise<void> {
  await checkDocker(options);
}

export async function startTestContainer<T>(container: StartableTestContainer<T>, options: DockerPreflightOptions = {}): Promise<T> {
  const config = await checkDocker(options);
  if (configuration().identity !== config.identity) {
    throw configurationError('the Docker configuration changed before startup. Retry with stable endpoint and TLS settings.');
  }
  startedConfiguration = config.identity;
  return container.start();
}
