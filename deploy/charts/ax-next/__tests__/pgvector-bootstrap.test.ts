// The embedded-postgres pgvector bootstrap (templates/postgresql-init-job.yaml).
//
// TASK-458. The Job used to end `CREATE EXTENSION ... && echo ok || echo "not
// available (non-fatal)"`, which made success and failure the same exit code,
// and nothing anywhere checked which one happened. The card's first question was
// whether the chart's postgres image ships pgvector at all; it does (0.8.0 in
// bitnamilegacy/postgresql:17.6.0-debian-12-r4, measured 2026-09-26), so the
// decision is: the extension is REQUIRED on the embedded path and the Job fails
// the install when it cannot be enabled.
//
// Two layers, because each catches what the other cannot:
//
//   1. Render (helm): the script's shape — strict shell, no `||` swallow, the
//      post-create `pg_extension` check — and that the Job's image IS the
//      chart's postgres image.
//   2. Behaviour (helm + Docker): run the RENDERED script, in the rendered image,
//      against (a) a server from the chart's own image, which must succeed and
//      leave `vector` installed — this is what catches an image bump to a tag
//      without pgvector; and (b) a server with no pgvector, which must FAIL.
//      (b) is the anti-swallow proof: the pre-TASK-458 script exits 0 there.

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { load, loadAll } from 'js-yaml';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  DOCKER_REQUIRED_MESSAGE,
  resolveDockerGate,
  type DockerGate,
} from './docker-required.js';
import { HELM_REQUIRED_MESSAGE, resolveHelmGate } from './helm-required.js';

const here = dirname(fileURLToPath(import.meta.url));
const chartDir = resolve(here, '..');

const RELEASE = 'ax-test';
const JOB_NAME = `${RELEASE}-ax-next-pg-init`;

const REQUIRED = [
  '--set',
  'credentials.key=test',
  '--set',
  'anthropic.apiKey=test',
  '--set',
  'http.cookieKey=0000000000000000000000000000000000000000000000000000000000000000',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type K8sDoc = { kind?: string; metadata?: { name?: string; annotations?: Record<string, string> } } & Record<string, any>;

function findHelm(): string | null {
  return spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0 ? 'helm' : null;
}

const HELM = findHelm();
const HELM_GATE = resolveHelmGate(HELM, process.env.AX_REQUIRE_HELM);

function helmTemplate(extraArgs: readonly string[] = []): K8sDoc[] {
  if (!HELM) throw new Error('helm not available');
  const out = execFileSync(
    HELM,
    ['template', RELEASE, chartDir, '--namespace', 'default', ...REQUIRED, ...extraArgs],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return (loadAll(out) as Array<K8sDoc | null>).filter(
    (d): d is K8sDoc => d != null && typeof d === 'object',
  );
}

function findJob(docs: K8sDoc[]): K8sDoc | undefined {
  return docs.find((d) => d.kind === 'Job' && d.metadata?.name === JOB_NAME);
}

type Rendered = {
  image: string;
  command: string[];
  args: string[];
  script: string;
  pgHost: string;
  database: string;
};

function renderedJob(extraArgs: readonly string[] = []): Rendered {
  const job = findJob(helmTemplate(extraArgs));
  if (!job) throw new Error(`${JOB_NAME} did not render`);
  const containers = job.spec?.template?.spec?.containers as Array<Record<string, unknown>>;
  expect(containers).toHaveLength(1);
  const c = containers[0]!;
  const command = c.command as string[];
  const args = c.args as string[];
  const script = args[args.length - 1]!;
  const host = /^\s*PG_HOST="([^"]+)"\s*$/m.exec(script);
  const db = /-d "([^"]+)"/.exec(script);
  if (!host || !db) throw new Error('could not find PG_HOST / -d in the rendered script');
  return { image: c.image as string, command, args, script, pgHost: host[1]!, database: db[1]! };
}

type ChartPostgresValues = {
  postgresql: {
    image: { registry: string; repository: string; tag: string };
    auth: { username: string };
  };
};

function chartValues(): ChartPostgresValues {
  return load(readFileSync(join(chartDir, 'values.yaml'), 'utf8')) as ChartPostgresValues;
}

/** The chart's own postgres image, read from values.yaml — the source of truth. */
function chartPostgresImage(): string {
  const { registry, repository, tag } = chartValues().postgresql.image;
  return `${registry}/${repository}:${tag}`;
}

const describeIfHelm = HELM_GATE.mode === 'run' ? describe : describe.skip;

if (HELM_GATE.mode === 'require-missing') {
  describe('pgvector bootstrap: helm required', () => {
    it('helm must be installed when AX_REQUIRE_HELM is set', () => {
      throw new Error(HELM_REQUIRED_MESSAGE);
    });
  });
}

describeIfHelm('pgvector bootstrap Job — render (TASK-458)', () => {
  it('renders by default (embedded postgres) as a post-install/upgrade hook', () => {
    const job = findJob(helmTemplate());
    expect(job, `${JOB_NAME} should render in the default embedded mode`).toBeDefined();
    expect(job!.metadata!.annotations!['helm.sh/hook']).toBe('post-install,post-upgrade');
  });

  it('does not render in external mode (the operator bootstraps their own DB)', () => {
    const docs = helmTemplate([
      '--set',
      'postgres.external.enabled=true',
      '--set',
      'postgres.external.existingSecret=ext-db',
      '--set',
      'postgres.embedded.enabled=false',
    ]);
    expect(findJob(docs)).toBeUndefined();
  });

  it("runs the chart's own postgres image, so the Job and the server cannot drift", () => {
    expect(renderedJob().image).toBe(chartPostgresImage());
  });

  it('runs strict: set -euo pipefail before anything else', () => {
    const firstLine = renderedJob().script.split('\n').find((l) => l.trim() !== '');
    expect(firstLine?.trim()).toBe('set -euo pipefail');
  });

  it('has no `||` anywhere — the fallback that turned failure into success is gone', () => {
    expect(renderedJob().script).not.toContain('||');
    expect(renderedJob().script).not.toMatch(/non-fatal/i);
  });

  it('creates the extension with ON_ERROR_STOP and then proves it from pg_extension', () => {
    const { script } = renderedJob();
    const create = script.indexOf('CREATE EXTENSION IF NOT EXISTS vector');
    const verify = script.indexOf("FROM pg_extension WHERE extname = 'vector'");
    expect(create).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(create);
    for (const line of script.split('\n').filter((l) => /\bpsql\b/.test(l) && !/SELECT 1/.test(l))) {
      expect(line, 'every psql after the readiness probe must stop on error').toContain('ON_ERROR_STOP=1');
    }
  });
});

/** `helm template` expected to FAIL; returns its stderr so the reason can be asserted. */
function helmTemplateError(extraArgs: readonly string[]): string {
  if (!HELM) throw new Error('helm not available');
  const r = spawnSync(
    HELM,
    ['template', RELEASE, chartDir, '--namespace', 'default', ...REQUIRED, ...extraArgs],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (r.status === 0) throw new Error(`helm template unexpectedly succeeded with ${extraArgs.join(' ')}`);
  return r.stderr ?? '';
}

let noSchemaChart = '';

/** A copy of the chart without values.schema.json — what a schema-skipping render sees. */
function schemaSkippedChart(): string {
  if (noSchemaChart === '') {
    noSchemaChart = mkdtempSync(join(tmpdir(), 'ax-next-chart-noschema-t563-'));
    for (const entry of ['Chart.yaml', 'Chart.lock', 'values.yaml', 'templates', 'charts']) {
      cpSync(resolve(chartDir, entry), join(noSchemaChart, entry), { recursive: true });
    }
    rmSync(join(noSchemaChart, 'values.schema.json'), { force: true });
  }
  return noSchemaChart;
}

afterAll(() => {
  if (noSchemaChart !== '') rmSync(noSchemaChart, { recursive: true, force: true });
});

type InitBounds = {readyTimeoutSeconds: number; activeDeadlineSeconds: number };

function chartInitBounds(): InitBounds {
  const v = load(readFileSync(join(chartDir, 'values.yaml'), 'utf8')) as {
    postgres: { embedded: { init: InitBounds } };
  };
  return v.postgres.embedded.init;
}

function renderedBounds(extraArgs: readonly string[] = []): { jobDeadline: unknown; scriptTimeout: number } {
  const job = findJob(helmTemplate(extraArgs));
  if (!job) throw new Error(`${JOB_NAME} did not render`);
  const { script } = renderedJob(extraArgs);
  const m = /^\s*READY_TIMEOUT_SECONDS=(\d+)\s*$/m.exec(script);
  if (!m) throw new Error('READY_TIMEOUT_SECONDS not found in the rendered script');
  return { jobDeadline: job.spec?.activeDeadlineSeconds, scriptTimeout: Number(m[1]) };
}

describeIfHelm('pg-init Job is bounded in time (TASK-563)', () => {
  it('values.yaml ships sane defaults, deadline above the readiness wait', () => {
    const { readyTimeoutSeconds, activeDeadlineSeconds } = chartInitBounds();
    expect(Number.isInteger(readyTimeoutSeconds) && readyTimeoutSeconds > 0).toBe(true);
    expect(Number.isInteger(activeDeadlineSeconds)).toBe(true);
    expect(activeDeadlineSeconds).toBeGreaterThan(readyTimeoutSeconds);
  });

  it('renders both bounds from values.yaml by default', () => {
    const { readyTimeoutSeconds, activeDeadlineSeconds } = chartInitBounds();
    expect(renderedBounds()).toEqual({ jobDeadline: activeDeadlineSeconds, scriptTimeout: readyTimeoutSeconds });
  });

  it("the template's key-absent fallback matches values.yaml (the default lives in two places)", () => {
    const { readyTimeoutSeconds, activeDeadlineSeconds } = chartInitBounds();
    expect(
      renderedBounds([
        '--set', 'postgres.embedded.init.readyTimeoutSeconds=null',
        '--set', 'postgres.embedded.init.activeDeadlineSeconds=null',
      ]),
    ).toEqual({ jobDeadline: activeDeadlineSeconds, scriptTimeout: readyTimeoutSeconds });
  });

  it('honours overrides of both bounds', () => {
    expect(
      renderedBounds([
        '--set', 'postgres.embedded.init.readyTimeoutSeconds=42',
        '--set', 'postgres.embedded.init.activeDeadlineSeconds=4242',
      ]),
    ).toEqual({ jobDeadline: 4242, scriptTimeout: 42 });
  });

  it('the readiness loop checks its deadline and fails with a FATAL naming the knob', () => {
    const { script } = renderedJob();
    const loop = /until psql [^\n]*SELECT 1[^\n]*; do\n([\s\S]*?)\n\s*done/.exec(script);
    expect(loop, 'readiness until-loop not found').not.toBeNull();
    expect(loop![1]).toMatch(/if \[ "\$SECONDS" -ge "\$READY_DEADLINE" \]; then/);
    expect(loop![1]).toContain('exit 1');
    expect(loop![1]).toContain('postgres.embedded.init.readyTimeoutSeconds');
    expect(script).toMatch(/^\s*READY_DEADLINE=\$\(\(SECONDS \+ READY_TIMEOUT_SECONDS\)\)\s*$/m);
  });

  it('bounds each connection attempt, so one black-holed connect cannot outlast the wait', () => {
    const { script } = renderedJob();
    const connect = script.search(/^\s*export PGCONNECT_TIMEOUT=\d+\s*$/m);
    expect(connect).toBeGreaterThan(-1);
    expect(connect).toBeLessThan(script.indexOf('until psql'));
  });

  it('refuses a deadline that would kill the Job before the wait can explain itself', () => {
    const err = helmTemplateError([
      '--set', 'postgres.embedded.init.readyTimeoutSeconds=300',
      '--set', 'postgres.embedded.init.activeDeadlineSeconds=300',
    ]);
    expect(err).toContain('must be greater than readyTimeoutSeconds');
  });

  it.each([
    ['readyTimeoutSeconds', '0'],
    ['activeDeadlineSeconds', '0'],
    ['readyTimeoutSeconds', '-5'],
  ])('values.schema.json rejects %s=%s', (key, value) => {
    const err = helmTemplateError(['--set', `postgres.embedded.init.${key}=${value}`]);
    expect(err).toMatch(/schema/i);
    expect(err).toContain(key);
  });

  it('values.schema.json rejects a misspelled bound instead of silently keeping the default', () => {
    const err = helmTemplateError(['--set', 'postgres.embedded.init.readyTimeoutSecond=30']);
    expect(err).toMatch(/schema/i);
    expect(err).toContain('readyTimeoutSecond');
  });

  it('the values.yaml default leaves the FATAL room to fire before helm\'s default 5m --timeout', () => {
    expect(chartInitBounds().readyTimeoutSeconds).toBeLessThan(300);
  });

  it.each(['readyTimeoutSeconds', 'activeDeadlineSeconds'])(
    'with schema validation skipped, the template still refuses %s=0 (no `default` swallowing it)',
    (key) => {
      const r = spawnSync(
        HELM!,
        ['template', RELEASE, schemaSkippedChart(), '--namespace', 'default', ...REQUIRED,
          '--set', `postgres.embedded.init.${key}=0`],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );
      expect(r.status, r.stdout).not.toBe(0);
      expect(r.stderr).toContain('must both be positive integers');
    },
  );

  it('values.schema.json rejects a quoted number', () => {
    const err = helmTemplateError(['--set-string', 'postgres.embedded.init.readyTimeoutSeconds=300']);
    expect(err).toMatch(/schema/i);
    expect(err).toContain('readyTimeoutSeconds');
  });
});

// ─── Behaviour: run the rendered script against real servers ─────────────────

function dockerReachable(): boolean {
  if (!process.env.DOCKER_HOST) return false;
  return spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' }).status === 0;
}

const DOCKER_GATE: DockerGate = resolveDockerGate(
  process.env.DOCKER_HOST,
  dockerReachable(),
  process.env.AX_REQUIRE_DOCKER,
);

if (HELM_GATE.mode === 'run' && DOCKER_GATE.mode === 'require-missing') {
  describe('pgvector bootstrap: Docker required', () => {
    it('Docker must be usable when AX_REQUIRE_DOCKER is set', () => {
      throw new Error(`${DOCKER_REQUIRED_MESSAGE} (${DOCKER_GATE.reason})`);
    });
  });
}
if (HELM_GATE.mode === 'run' && DOCKER_GATE.mode === 'skip') {
  console.warn(`pgvector bootstrap container proof skipped: ${DOCKER_GATE.reason}`);
}

const describeIfContainers =
  HELM_GATE.mode === 'run' && DOCKER_GATE.mode === 'run' ? describe : describe.skip;

/** A postgres image with no pgvector — the "image without the extension" case. */
const NO_VECTOR_IMAGE = 'postgres:16-alpine';
const SUPERUSER_PASSWORD = 'task458-superuser';

function docker(args: readonly string[], timeoutMs = 60_000): { status: number; out: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Synchronous sleep — the suite drives Docker through spawnSync, so there is no event loop to yield to. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Make `image` resident with as few registry contacts as possible. An image
 * already on the daemon is never pulled (`docker pull` would re-check the
 * manifest over the network even then — the TASK-317 flake vector). Otherwise
 * a bounded retry with backoff, and a failure that says it was the PULL, so a
 * Docker Hub blip is never mistaken for a product failure.
 */
function ensureImage(image: string): void {
  if (docker(['image', 'inspect', image]).status === 0) return;
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = docker(['pull', '--quiet', image], 300_000);
    if (r.status === 0) return;
    last = r.out;
    if (attempt < 3) sleepSync(attempt * 5_000);
  }
  throw new Error(`docker pull ${image} failed 3 times (registry, not product):\n${last}`);
}

const cleanup: Array<string[]> = [];

afterEach(() => {
  while (cleanup.length > 0) docker(cleanup.pop()!);
});

/**
 * Start `serverArgs` as a postgres server on a fresh network under the alias the
 * rendered script dials, run the rendered Job container against it, and return
 * the Job's exit status + output alongside the server's name.
 */
function runJobAgainst(
  job: Rendered,
  serverImage: string,
  serverEnv: Record<string, string>,
): { status: number; out: string; server: string } {
  const id = randomBytes(4).toString('hex');
  const net = `ax-t458-${id}`;
  const server = `ax-t458-srv-${id}`;
  const runner = `ax-t458-job-${id}`;

  expect(docker(['network', 'create', net]).status).toBe(0);
  cleanup.push(['network', 'rm', net]);

  const env = Object.entries(serverEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const started = docker(['run', '-d', '--name', server, '--network', net, '--network-alias', job.pgHost, ...env, serverImage]);
  cleanup.push(['rm', '-f', server]);
  expect(started.status, started.out).toBe(0);

  // The pod's `command` replaces the image ENTRYPOINT; mirror that exactly.
  const [entrypoint, ...commandRest] = job.command;
  cleanup.push(['rm', '-f', runner]);
  const ran = docker(
    [
      'run', '--name', runner, '--network', net,
      '-e', `POSTGRES_PASSWORD=${SUPERUSER_PASSWORD}`,
      '--entrypoint', entrypoint!,
      job.image,
      ...commandRest, ...job.args,
    ],
    180_000,
  );
  return { ...ran, server };
}

describeIfContainers('pgvector bootstrap Job — behaviour (TASK-458)', () => {
  it(
    "enables pgvector on the chart's own postgres image, and the extension is really there",
    () => {
      const job = renderedJob();
      ensureImage(job.image);
      // Mirror the subchart: a named app user plus a separate superuser password,
      // which the Job reads from `<release>-postgresql` / postgres-password.
      const result = runJobAgainst(job, chartPostgresImage(), {
        POSTGRESQL_USERNAME: chartValues().postgresql.auth.username,
        POSTGRESQL_PASSWORD: 'task458-app',
        POSTGRESQL_POSTGRES_PASSWORD: SUPERUSER_PASSWORD,
        POSTGRESQL_DATABASE: job.database,
      });
      expect(result.status, result.out).toBe(0);
      expect(result.out).toMatch(/pgvector \d+\.\d+\.\d+ enabled/);

      const probe = docker([
        'exec', '-e', `PGPASSWORD=${SUPERUSER_PASSWORD}`, result.server,
        'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', job.database, '-v', 'ON_ERROR_STOP=1', '-tA',
        '-c', "SELECT extversion FROM pg_extension WHERE extname = 'vector';",
        '-c', "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector;",
      ]);
      expect(probe.status, probe.out).toBe(0);
      expect(probe.out.trim().split('\n')).toEqual([expect.stringMatching(/^\d+\.\d+\.\d+$/), '1']);
    },
    400_000,
  );

  it(
    'FAILS the Job against a server without pgvector — no more silent success',
    () => {
      const job = renderedJob();
      ensureImage(job.image);
      ensureImage(NO_VECTOR_IMAGE);
      const result = runJobAgainst(job, NO_VECTOR_IMAGE, {
        POSTGRES_PASSWORD: SUPERUSER_PASSWORD,
        POSTGRES_DB: job.database,
      });
      expect(result.status, result.out).not.toBe(0);
      expect(result.out).toContain('FATAL: could not enable pgvector');
      expect(result.out).not.toContain('PostgreSQL initialization complete');
    },
    400_000,
  );
});

describeIfContainers('pg-init Job — bounded readiness wait (TASK-563)', () => {
  it(
    'gives up with a FATAL when postgres never answers, inside the configured bound',
    () => {
      const READY = 6;
      const job = renderedJob([
        '--set', `postgres.embedded.init.readyTimeoutSeconds=${READY}`,
        '--set', 'postgres.embedded.init.activeDeadlineSeconds=60',
      ]);
      ensureImage(job.image);
      const id = randomBytes(4).toString('hex');
      const net = `ax-t563-${id}`;
      const runner = `ax-t563-job-${id}`;
      expect(docker(['network', 'create', net]).status).toBe(0);
      cleanup.push(['network', 'rm', net]);
      // No server on this network at all, so the readiness probe can never
      // succeed. The pre-TASK-563 loop spins here forever; the CLI timeout below
      // turns that into a non-1 status instead of hanging the suite.
      const [entrypoint, ...commandRest] = job.command;
      cleanup.push(['rm', '-f', runner]);
      const started = Date.now();
      const ran = docker(
        [
          'run', '--name', runner, '--network', net,
          '-e', `POSTGRES_PASSWORD=${SUPERUSER_PASSWORD}`,
          '--entrypoint', entrypoint!,
          job.image,
          ...commandRest, ...job.args,
        ],
        90_000,
      );
      const elapsedS = (Date.now() - started) / 1000;
      expect(ran.status, ran.out).toBe(1);
      expect(ran.out).toContain(`FATAL: PostgreSQL at ${job.pgHost}:5432 was not ready after ${READY}s`);
      expect(ran.out).toContain('Waiting for PostgreSQL...');
      expect(ran.out).not.toContain('PostgreSQL is ready.');
      // Container start + the bound + one probe/sleep of slack; far below the 90s kill.
      expect(elapsedS).toBeLessThan(READY + 45);
    },
    400_000,
  );
});

describe('resolveDockerGate', () => {
  it('runs only with an explicit DOCKER_HOST and a reachable daemon', () => {
    expect(resolveDockerGate('unix:///var/run/docker.sock', true, undefined)).toEqual({ mode: 'run' });
    expect(resolveDockerGate('unix:///var/run/docker.sock', true, '1')).toEqual({ mode: 'run' });
  });

  it('never guesses a daemon: unset/blank DOCKER_HOST skips even if one would answer', () => {
    expect(resolveDockerGate(undefined, true, undefined).mode).toBe('skip');
    expect(resolveDockerGate('  ', true, undefined).mode).toBe('skip');
  });

  it('AX_REQUIRE_DOCKER turns every non-run case into a hard failure', () => {
    expect(resolveDockerGate(undefined, false, '1').mode).toBe('require-missing');
    expect(resolveDockerGate('unix:///nope.sock', false, 'true').mode).toBe('require-missing');
    expect(resolveDockerGate('unix:///nope.sock', false, '0').mode).toBe('skip');
  });
});
