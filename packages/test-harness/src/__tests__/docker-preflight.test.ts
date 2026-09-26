import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as harness from '../index.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const consumer = join(repo, 'packages/storage-postgres/src/__tests__/plugin.test.ts');
const source = ts.createSourceFile(consumer, readFileSync(consumer, 'utf8'), ts.ScriptTarget.Latest, true);
const expressions: string[] = [];
function visit(node: ts.Node): void {
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'PostgreSqlContainer') {
    let parent: ts.Node | undefined = node;
    while (parent !== undefined && !ts.isAwaitExpression(parent)) parent = parent.parent;
    if (parent !== undefined && ts.isAwaitExpression(parent)) expressions.push(parent.expression.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (expressions.length !== 1) throw new Error('Expected exactly one awaited Postgres startup expression in the consumer fixture.');
const startupExpression = expressions[0]!;

type Startable = { start(): Promise<unknown> };
type CheckedStart = (container: Startable, options: { timeoutMs: number; warn: (message: string) => void }) => Promise<unknown>;

// The probe budget every test gets unless it is asserting the timeout branch itself.
// (TASK-549)
//
// It used to be 3_000. That is a wall-clock deadline inside the test, and the package
// `testTimeout` in vitest.config.ts cannot reach it. On CI run 36225259523 (main at
// be8fc794) the overflow tests got the timeout branch ("did not answer its readiness
// probes within 3000 ms") instead of the failed-probe branch they assert. The stub's
// overflow modes `exec node`, and a node child under CI contention can take seconds to
// start: the same package has a measured 9087ms spawn-and-answer on CI (TASK-537).
// Stalling only the stub's node child by 3500ms reproduces the CI error exactly. The
// "stalled probe child" test below pins that.
//
// Why 20_000: it has to stay under the 30_000 `testTimeout`, so a genuine hang in a
// test that does not expect one still fails with the helper's own named message
// instead of vitest's generic timeout. Within that ceiling, more room is better. 20s is
// ~2.2x the worst CI subprocess stall measured in this package. It also leaves 10s for
// the rest of the test. This is the TEST's budget, not production's:
// DOCKER_PREFLIGHT_TIMEOUT_MS (45s) is unchanged.
//
// The two `hang-*` tests still pass 1_000 explicitly, because the timeout branch is
// what they assert. They cannot flake the wrong way: a slow child only makes the
// timeout more certain.
const PROBE_BUDGET_MS = 20_000;

async function startConsumer(start: () => Promise<unknown>, warn: (message: string) => void, timeoutMs = PROBE_BUDGET_MS): Promise<unknown> {
  const checked = Reflect.get(harness, 'startTestContainer') as CheckedStart | undefined;
  class StubPostgres {
    start(): Promise<unknown> { return start(); }
  }
  return runInNewContext(startupExpression, {
    PostgreSqlContainer: StubPostgres,
    startTestContainer: (container: Startable) => {
      if (checked === undefined) throw new Error('startTestContainer must be exported by the test harness.');
      return checked(container, { timeoutMs, warn });
    },
  }, { timeout: 1_000 }) as Promise<unknown>;
}

for (const shell of ['bash', 'zsh']) {
  const available = process.platform !== 'win32' && spawnSync(shell, ['-c', 'exit 0'], { timeout: 5_000 }).status === 0;
  describe.skipIf(!available)(`Docker preflight through a ${shell} stub`, () => {
    let dir: string | undefined;
    let trace: string;
    const warn = vi.fn<(message: string) => void>();
    const started = { started: true };
    const start = vi.fn(async () => started);

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'ax-docker-preflight-'));
      trace = join(dir, 'trace');
      vi.stubEnv('PATH', `${dir}:${process.env.PATH ?? ''}`);
      vi.stubEnv('BASH_ENV', '');
      vi.stubEnv('ZDOTDIR', dir);
      vi.stubEnv('NODE_OPTIONS', '');
      vi.stubEnv('HOME', dir);
      vi.stubEnv('USERPROFILE', dir);
      vi.stubEnv('DOCKER_HOST', 'unix:///ax-preflight-test.sock');
      vi.stubEnv('DOCKER_CONTEXT', 'different-daemon');
      vi.stubEnv('DOCKER_TLS', undefined);
      vi.stubEnv('DOCKER_TLS_VERIFY', undefined);
      vi.stubEnv('DOCKER_CERT_PATH', undefined);
      vi.stubEnv('AX_TESTCONTAINERS_STRICT_ENDPOINT', undefined);
      vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', undefined);
      vi.stubEnv('AX_DOCKER_TEST_NODE', process.execPath);
      vi.stubEnv('AX_DOCKER_TEST_TRACE', trace);
      vi.stubEnv('AX_DOCKER_TEST_MODE', 'healthy');
      vi.stubEnv('AX_DOCKER_TEST_INFO', '0 0');
      start.mockClear();
      warn.mockClear();
      await writeFile(join(dir, 'docker'), `#!/usr/bin/env ${shell}
[ "$1" = '--host=unix:///ax-preflight-test.sock' ] || exit 9
[ "$DOCKER_HOST" = 'unix:///ax-preflight-test.sock' ] || exit 9
[ -z "$DOCKER_CONTEXT" ] || exit 9
shift
printf '%s\\n' "$*" >> "$AX_DOCKER_TEST_TRACE"
case "$1" in
  version)
    [ "$#" -eq 3 ] && [ "$2" = '--format' ] && [ "$3" = '{{.Server.Version}}' ] || exit 9
    case "$AX_DOCKER_TEST_MODE" in
      empty-version) exit 0 ;;
      failed-version) printf '%s\\n' 'PRIVATE_DIAGNOSTIC' >&2; exit 7 ;;
      overflow-stdout) exec "$AX_DOCKER_TEST_NODE" -e 'process.stdout.write("PRIVATE_DIAGNOSTIC".repeat(2048))' ;;
      overflow-stderr) exec "$AX_DOCKER_TEST_NODE" -e 'process.stderr.write("PRIVATE_DIAGNOSTIC".repeat(2048))' ;;
      hang-version) exec "$AX_DOCKER_TEST_NODE" -e 'setTimeout(() => process.exit(0), 20000)' ;;
    esac
    printf '%s\\n' '26.1.0'
    ;;
  info)
    [ "$#" -eq 3 ] && [ "$2" = '--format' ] && [ "$3" = '{{.Containers}} {{.ContainersRunning}}' ] || exit 9
    if [ "$AX_DOCKER_TEST_MODE" = 'hang-info' ]; then
      exec "$AX_DOCKER_TEST_NODE" -e 'setTimeout(() => process.exit(0), 20000)'
    fi
    printf '%s\\n' "$AX_DOCKER_TEST_INFO"
    ;;
  ps) exit 0 ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
      dir = undefined;
    });

    async function calls(): Promise<string[]> {
      return existsSync(trace) ? (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean) : [];
    }

    it('starts only after version and info answer, including a genuinely empty host', async () => {
      await expect(startConsumer(start, warn)).resolves.toBe(started);
      expect(start).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      expect(await calls()).toEqual([
        'version --format {{.Server.Version}}',
        'info --format {{.Containers}} {{.ContainersRunning}}',
      ]);
    });

    it('rejects rc=0 with an empty server version before starting the container', async () => {
      vi.stubEnv('AX_DOCKER_TEST_MODE', 'empty-version');
      await expect(startConsumer(start, warn)).rejects.toThrow(/Docker daemon returned no server version/);
      expect(start).not.toHaveBeenCalled();
      expect(await calls()).toEqual(['version --format {{.Server.Version}}']);
    });

    it('names the daemon without copying failed-command diagnostics', async () => {
      vi.stubEnv('AX_DOCKER_TEST_MODE', 'failed-version');
      const error = await startConsumer(start, warn).then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('Docker daemon readiness probe failed');
      expect(String(error)).not.toContain('PRIVATE_DIAGNOSTIC');
      expect(Object.getOwnPropertyNames(error).sort()).toEqual(['message', 'stack']);
      expect(start).not.toHaveBeenCalled();
    });

    it.each(['overflow-stdout', 'overflow-stderr'])('bounds %s and does not attach raw diagnostics', async (mode) => {
      vi.stubEnv('AX_DOCKER_TEST_MODE', mode);
      const error = await startConsumer(start, warn).then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('Docker daemon readiness probe failed');
      expect(String(error)).not.toContain('PRIVATE_DIAGNOSTIC');
      expect(Object.getOwnPropertyNames(error).sort()).toEqual(['message', 'stack']);
      expect(start).not.toHaveBeenCalled();
    });

    it('keeps the failed-probe branch when the probe child stalls past the old 3000ms budget', async () => {
      // CI-sized startup stall, injected into ONLY the stub's node child: the vitest
      // worker is already running, so the preload reaches nothing else. (TASK-549)
      // Against the old 3_000 default this fails with the CI message, "did not answer
      // its readiness probes within 3000 ms".
      const stall = join(dir!, 'stall.mjs');
      await writeFile(stall, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3500);\n');
      vi.stubEnv('NODE_OPTIONS', `--import=${pathToFileURL(stall).href}`);
      vi.stubEnv('AX_DOCKER_TEST_MODE', 'overflow-stdout');
      const error = await startConsumer(start, warn).then(() => null, (reason: unknown) => reason);
      expect(String(error)).toContain('Docker daemon readiness probe failed');
      expect(String(error)).not.toContain('PRIVATE_DIAGNOSTIC');
      expect(start).not.toHaveBeenCalled();
    });

    it.each([
      ['19 19', 0],
      ['20 20', 1],
    ] as const)('keeps the advisory boundary explicit for %s', async (info, warnings) => {
      vi.stubEnv('AX_DOCKER_TEST_INFO', info);
      await expect(startConsumer(start, warn)).resolves.toBe(started);
      expect(warn).toHaveBeenCalledTimes(warnings);
      expect(start).toHaveBeenCalledTimes(1);
    });

    it.each(['hang-version', 'hang-info'])('bounds %s instead of inheriting the command hang', async (mode) => {
      vi.stubEnv('AX_DOCKER_TEST_MODE', mode);
      await expect(startConsumer(start, warn, 1_000)).rejects.toThrow(/Docker daemon.*within 1000 ms/);
      expect(start).not.toHaveBeenCalled();
    });

    it.each(['', 'not-counts', '-1 0', '1 2', '2.0 1', '1e3 1', '3 1 extra', '999999999999999999999 1'])('does not report a clean host from invalid counts %j', async (info) => {
      vi.stubEnv('AX_DOCKER_TEST_INFO', info);
      await expect(startConsumer(start, warn)).rejects.toThrow(/Docker daemon returned unusable container counts/);
      expect(start).not.toHaveBeenCalled();
    });

    it('warns with the reported high running count without rejecting a responsive daemon', async () => {
      vi.stubEnv('AX_DOCKER_TEST_INFO', '39 34');
      await expect(startConsumer(start, warn)).resolves.toBe(started);
      expect(start).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/34 running containers \(39 total\).*may be loaded/));
    });

    it('preserves a later container startup failure rather than relabeling it as Docker readiness', async () => {
      const failure = new Error('fixture startup failed');
      const fail = vi.fn(async () => { throw failure; });
      await expect(startConsumer(fail, warn)).rejects.toBe(failure);
      expect(fail).toHaveBeenCalledTimes(1);
    });
  });
}
