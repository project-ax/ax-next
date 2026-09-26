// Docker-presence gate for the chart suites that run a rendered script in a
// real container (pgvector-bootstrap.test.ts). Same shape as helm-required.ts,
// for the same reason: a friendly skip locally, a hard failure in the CI lane
// that exists to run it.
//
// Two rules beyond "is docker there":
//
//   - DOCKER_HOST must be named explicitly. The repo's Docker-backed tests do
//     not use CLI contexts or endpoint discovery (see CLAUDE.md › Docker-backed
//     tests), and this suite shells out to the Docker CLI, which WOULD happily
//     pick a context. Requiring the variable keeps "which daemon" a decision
//     the runner made on purpose.
//   - `AX_REQUIRE_DOCKER=1` flips a missing daemon from skip to fail. CI's
//     helm-render lane sets it — the only lane with helm AND Docker — so a
//     regression that drops Docker from that lane reddens instead of quietly
//     turning the pgvector proof into a no-op.

import { isStrictValue } from './helm-required.js';

export type DockerGate =
  | { mode: 'run' }
  | { mode: 'skip'; reason: string }
  | { mode: 'require-missing'; reason: string };

/**
 * Pure decision. `dockerHost` is the raw `DOCKER_HOST`; `daemonReachable` is
 * whether `docker version` succeeded against it (only meaningful when
 * `dockerHost` is set).
 */
export function resolveDockerGate(
  dockerHost: string | undefined,
  daemonReachable: boolean,
  requireDockerRaw: string | undefined,
): DockerGate {
  let reason: string | null = null;
  if (dockerHost === undefined || dockerHost.trim() === '') {
    reason = 'DOCKER_HOST is not set (this suite never guesses a daemon)';
  } else if (!daemonReachable) {
    reason = `no Docker daemon answered at DOCKER_HOST=${dockerHost}`;
  }
  if (reason === null) return { mode: 'run' };
  if (isStrictValue(requireDockerRaw)) return { mode: 'require-missing', reason };
  return { mode: 'skip', reason };
}

export const DOCKER_REQUIRED_MESSAGE =
  'AX_REQUIRE_DOCKER is set but Docker is unusable — the pgvector bootstrap ' +
  'proof cannot run. Set DOCKER_HOST to a reachable daemon (CI: the ' +
  'helm-render job), or unset AX_REQUIRE_DOCKER for local skip behavior.';
