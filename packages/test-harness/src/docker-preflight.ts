import { execFile } from 'node:child_process';
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

async function probe(
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', args, {
      encoding: 'utf8',
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
    throw new Error(
      `Docker daemon readiness probe failed (${args[0]}). Check the Docker context or restart Docker before retrying.`,
    );
  }
}

export async function preflightDocker(
  options: DockerPreflightOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DOCKER_PREFLIGHT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DOCKER_PREFLIGHT_TIMEOUT_MS) {
    throw new RangeError(`Docker preflight timeout must be an integer from 1 to ${DOCKER_PREFLIGHT_TIMEOUT_MS} ms.`);
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const version = await probe(VERSION_ARGS, signal, timeoutMs);
  if (version.length === 0) {
    throw new Error(
      'Docker daemon returned no server version. Start or restart Docker, then retry the Docker-backed tests.',
    );
  }
  const info = await probe(INFO_ARGS, signal, timeoutMs);
  const counts = /^(\d+)\s+(\d+)$/.exec(info);
  const total = Number(counts?.[1]);
  const running = Number(counts?.[2]);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(running) || running > total) {
    throw new Error(
      'Docker daemon returned unusable container counts. Check Docker before retrying the Docker-backed tests.',
    );
  }
  if (running >= DOCKER_BUSY_CONTAINER_COUNT) {
    (options.warn ?? console.warn)(
      `Docker daemon is responding but reports ${running} running containers (${total} total). The host may be loaded; container startup can time out before assertions run.`,
    );
  }
}

export async function startTestContainer<T>(
  container: StartableTestContainer<T>,
  options: DockerPreflightOptions = {},
): Promise<T> {
  await preflightDocker(options);
  return container.start();
}
