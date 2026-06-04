import { spawn } from 'node:child_process';
import * as net from 'node:net';
import type { ServiceDescriptorParsed } from '@ax/sandbox-protocol';

// ---------------------------------------------------------------------------
// Descriptor → `docker compose` translation (TASK-152)
//
// The subprocess sandbox backend renders the SAME neutral ServiceDescriptor the
// k8s backend will schedule as native sidecars — but via `docker compose` on a
// per-session project for local/CLI dev. This module is the pure, daemon-free
// translation plus a thin INJECTABLE command-runner layer over `docker compose`
// so the translation can be unit-tested without a real Docker daemon (mirrors
// the gitOnce/gitWithRetry injectable-runner seam elsewhere in the repo).
//
// Locked posture (must match k8s, where docker allows):
//   - I4  — published ports bind ONLY to 127.0.0.1 (loopback).
//   - I10 — NO host bind mounts (writablePaths → tmpfs, ephemeral),
//           NO `privileged`, NO host networking (default bridge),
//           NO host pid/ipc sharing.
//   - I8  — images are digest-pinned (re-asserted here, defense in depth).
//
// The descriptor is untrusted (built from a connector's model/admin-authored
// capabilities). It is zod-validated at the wire (@ax/sandbox-protocol) AND
// re-asserted here; env values flow ONLY into the service container's env, never
// into our argv or a shell — we spawn `docker` with a fixed argv array and put
// the generated YAML/JSON on stdin (no compose file on disk, no shell).
// ---------------------------------------------------------------------------

/** Loopback host every published port binds to (I4). */
export const LOOPBACK_HOST = '127.0.0.1';

/** Service name shape — re-asserted from the canonical descriptor schema. */
const SERVICE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
/** Digest-pinned image (I8) — re-asserted at this hop. */
const DIGEST_PINNED_IMAGE_RE = /.+@sha256:[0-9a-f]{64}$/;

// Compose healthcheck cadence for descriptor-supplied `exec` probes. Modest,
// bounded values — a service that never becomes healthy is caught by the
// host-side bring-up deadline, not an unbounded compose retry loop.
const HEALTHCHECK_INTERVAL = '2s';
const HEALTHCHECK_TIMEOUT = '5s';
const HEALTHCHECK_RETRIES = 30;
const HEALTHCHECK_START_PERIOD = '2s';

/**
 * Derive a `docker compose` project name from the sessionId. Compose project
 * names are restricted to `[a-z0-9_-]` (lowercase) and must start with a letter
 * or number; we prefix `ax-svc-` and sanitize the sessionId to that charset so
 * an arbitrary sessionId can't produce an invalid (or argv-injecting) project
 * name. Bounded length keeps container/network names within Docker limits.
 */
export function composeProjectName(sessionId: string): string {
  const sanitized = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48);
  // `sanitized` may be empty (sessionId was all-symbols) — fall back to a stable
  // marker so the project name is always valid.
  return `ax-svc-${sanitized.length > 0 ? sanitized : 'session'}`;
}

/** A single service entry in the generated compose project. Plain JSON — we
 *  hand it to `docker compose -f -` on stdin, which accepts YAML *or* JSON. */
interface ComposeServiceEntry {
  image: string;
  // `restart: 'no'` — a dev sidecar that dies should surface as an error, not
  // silently respawn (and never outlive its session).
  restart: 'no';
  environment?: Record<string, string>;
  ports?: string[];
  tmpfs?: string[];
  healthcheck?: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
    start_period: string;
  };
}

export interface ComposeProject {
  services: Record<string, ComposeServiceEntry>;
}

/**
 * Translate the neutral descriptors into a `docker compose` project object.
 * Pure + daemon-free. The output deliberately contains NONE of:
 *   - a host bind mount (`volumes: ./host:/x`) — writablePaths → `tmpfs`
 *   - `privileged: true`
 *   - `network_mode: host` (or any host pid/ipc sharing)
 * so a reviewer (and the unit test) can assert the locked posture structurally.
 */
export function descriptorsToComposeProject(
  services: readonly ServiceDescriptorParsed[],
): ComposeProject {
  const out: ComposeProject = { services: {} };
  for (const svc of services) {
    // Defense in depth — the wire schema already validated these, but a drifted
    // host must not be able to smuggle a bad name/image past this translation.
    if (!SERVICE_NAME_RE.test(svc.name)) {
      throw new Error(`invalid service name: ${svc.name}`);
    }
    if (!DIGEST_PINNED_IMAGE_RE.test(svc.image)) {
      throw new Error(`service '${svc.name}' image must be digest-pinned: ${svc.image}`);
    }

    const entry: ComposeServiceEntry = {
      image: svc.image,
      restart: 'no',
    };

    if (Object.keys(svc.env).length > 0) {
      entry.environment = { ...svc.env };
    }

    if (svc.ports.length > 0) {
      // Loopback-only publish (I4): `127.0.0.1:<port>:<port>`. Same container
      // port is published on the same host port on loopback — the runner reaches
      // it at 127.0.0.1:<port>.
      entry.ports = svc.ports.map((p) => {
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
          throw new Error(`service '${svc.name}' has invalid port: ${String(p)}`);
        }
        return `${LOOPBACK_HOST}:${p}:${p}`;
      });
    }

    if (svc.writablePaths.length > 0) {
      // Ephemeral scratch via tmpfs — NEVER a host bind mount (I10). Each entry
      // is an absolute in-container path (the wire schema enforced `^/`).
      entry.tmpfs = svc.writablePaths.map((wp) => {
        if (!wp.startsWith('/')) {
          throw new Error(`service '${svc.name}' writablePath must be absolute: ${wp}`);
        }
        return wp;
      });
    }

    // Only `exec` healthchecks become a compose `healthcheck:` block — the image
    // author supplied a command we can run in-container. A `tcp` descriptor is
    // gated host-side (waitForTcpPorts) instead: we can't assume a probe binary
    // (nc/bash-/dev/tcp) exists in an arbitrary service image.
    if (svc.healthcheck !== undefined && svc.healthcheck.kind === 'exec') {
      entry.healthcheck = {
        test: ['CMD', ...svc.healthcheck.command],
        interval: HEALTHCHECK_INTERVAL,
        timeout: HEALTHCHECK_TIMEOUT,
        retries: HEALTHCHECK_RETRIES,
        start_period: HEALTHCHECK_START_PERIOD,
      };
    }

    out.services[svc.name] = entry;
  }
  return out;
}

/**
 * The set of host loopback ports a `tcp`-healthcheck service publishes — the
 * host-side readiness gate. `exec`-healthcheck services are waited on by
 * compose `--wait`; a service with no healthcheck at all is gated only by
 * `up -d` returning (best-effort, same as compose's default).
 */
export function tcpHealthPorts(services: readonly ServiceDescriptorParsed[]): number[] {
  const ports: number[] = [];
  for (const svc of services) {
    if (svc.healthcheck !== undefined && svc.healthcheck.kind === 'tcp') {
      ports.push(svc.healthcheck.port);
    }
  }
  return ports;
}

// ---------------------------------------------------------------------------
// Injectable command-runner layer over `docker compose`.
// ---------------------------------------------------------------------------

export interface ComposeRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `docker <args>` with optional `stdin`. Injectable so unit tests can
 * assert the exact argv + stdin WITHOUT a real Docker daemon. The default
 * impl ({@link defaultComposeRunner}) spawns the real `docker` binary.
 */
export type ComposeRunner = (
  args: string[],
  opts?: { stdin?: string },
) => Promise<ComposeRunResult>;

/** Real runner — spawns `docker` (shell:false, fixed argv), pipes stdin. */
export const defaultComposeRunner: ComposeRunner = (args, opts) =>
  new Promise<ComposeRunResult>((resolve, reject) => {
    const child = spawn('docker', args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    if (opts?.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
  });

/**
 * Is `docker compose` usable? Probes `docker compose version`. Returns false on
 * any non-zero exit or spawn error (so a missing/stopped Docker is a clean
 * `false`, never a throw — the caller decides whether that's fatal).
 */
export async function composeAvailable(run: ComposeRunner): Promise<boolean> {
  try {
    const res = await run(['compose', 'version']);
    return res.code === 0;
  } catch {
    return false;
  }
}

/**
 * Bring the project up: `docker compose -p <project> -f - up -d --wait` with the
 * compose JSON on stdin. `--wait` blocks until services with a healthcheck are
 * healthy (or fail). Throws on non-zero exit (stderr in the message).
 */
export async function composeUp(
  run: ComposeRunner,
  args: { projectName: string; composeJson: string },
): Promise<void> {
  const res = await run(
    ['compose', '-p', args.projectName, '-f', '-', 'up', '-d', '--wait'],
    { stdin: args.composeJson },
  );
  if (res.code !== 0) {
    throw new Error(
      `docker compose up failed (exit ${String(res.code)}): ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
}

/**
 * Tear the project down: `docker compose -p <project> -f - down -v` with the
 * same compose JSON on stdin (so compose can resolve service/volume defs).
 * Best-effort — returns the result; callers in cleanup paths ignore failures.
 */
export async function composeDown(
  run: ComposeRunner,
  args: { projectName: string; composeJson: string },
): Promise<ComposeRunResult> {
  return run(['compose', '-p', args.projectName, '-f', '-', 'down', '-v'], {
    stdin: args.composeJson,
  });
}

/**
 * Wait until every `127.0.0.1:<port>` accepts a TCP connection or the deadline
 * passes. The host-side readiness gate for `tcp`-healthcheck services. Throws if
 * any port is still closed at the deadline.
 */
export async function waitForTcpPorts(
  ports: readonly number[],
  opts?: { host?: string; deadlineMs?: number; intervalMs?: number },
): Promise<void> {
  if (ports.length === 0) return;
  const host = opts?.host ?? LOOPBACK_HOST;
  const deadline = Date.now() + (opts?.deadlineMs ?? 60_000);
  const intervalMs = opts?.intervalMs ?? 250;

  const probe = (port: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const done = (ok: boolean): void => {
        socket.destroy();
        resolve(ok);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.setTimeout(2_000, () => done(false));
    });

  const pending = new Set(ports);
  while (pending.size > 0) {
    for (const port of [...pending]) {
      if (await probe(port)) pending.delete(port);
    }
    if (pending.size === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `services not ready: ports ${[...pending].join(', ')} did not open on ${host} within deadline`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
