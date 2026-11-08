import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { getPriority } from 'node:os';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { WORKER_ARG } from '../prepare-worker.js';

// Pages the transform is handed that would end the HOST if the transform ran in it, and are met by the worker instead
// (TASK-1082, third and fourth reviews). The first: an ASCII page under 4 MiB whose pass-1 output is three times as long,
// because parse5 gives every rebuilt formatting element the same attribute list and each copy writes it out again; the
// second pass tokenizes all of that, the attributes a character at a time, and the heap it needs (more than 400 MB, against
// a worker limit of 384) is not something V8 ends a worker THREAD for: it ends the PROCESS ("Reached heap limit", SIGABRT),
// every time the page is viewed. The second: 4 MiB of text inside a `<table>`, which parse5 holds a token at a time where
// nothing the transform does can read it flat, and which needs 352 to 368 MB of the 384 whatever the transform is: served
// or refused according to the garbage collector's last run, and the host ended by it when the worker was a thread and its
// limit anything under about 224.
//
// So these run the way the host runs them: through `createHtmlPreparer()` of the COMPILED package (the worker is the built
// `prepare-worker.js`, which a process cannot be started from in TypeScript), in a child process that stands for the host,
// so that a page that does end the host is an exit code to read and not the end of the test run. Each is run three times:
// the crash was 4 or 5 in 5, then 12 of 21.

const packageDir = fileURLToPath(new URL('../..', import.meta.url));
const distWorker = fileURLToPath(new URL('../../dist/prepare-worker.js', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/pool-shape.mjs', import.meta.url));
const orphan = fileURLToPath(new URL('./fixtures/orphan.mjs', import.meta.url));

beforeAll(() => {
  // Under CI the pipeline has built every package already (`pnpm typecheck` is `tsc --build`). Anywhere else the build
  // runs, so that what is tested is the source as it is now and not a build from before an edit; it takes a second.
  if (process.env.CI === undefined || process.env.CI === '') {
    const built = spawnSync('pnpm', ['exec', 'tsc', '--build'], { cwd: packageDir, encoding: 'utf8' });
    if (built.status !== 0) throw new Error(`building @ax/frame-guard failed (exit ${built.status}):\n${built.stdout}${built.stderr}`);
  }
  if (!existsSync(distWorker)) {
    throw new Error(`${distWorker} does not exist. These tests run the compiled package; build it first: pnpm --filter @ax/frame-guard build`);
  }
}, 120_000);

interface Outcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  answer: { shape: string; ok: boolean; reason: string | null; bytes: number; ms: number; faults: string[] } | undefined;
}

/**
 * Runs a shape through the pool in a process that stands for the host. `hostNodeOptions` is that host's NODE_OPTIONS, and
 * `containerMib` the memory limit of the container it is to think it is in (none by default, whatever machine this runs on).
 */
function run(shape: string, heapMb?: number, hostNodeOptions?: string, containerMib?: number): Outcome {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CONTAINER_MIB;
  if (hostNodeOptions !== undefined) env.NODE_OPTIONS = hostNodeOptions;
  if (containerMib !== undefined) env.CONTAINER_MIB = String(containerMib);
  const child = spawnSync(process.execPath, [fixture, shape, ...(heapMb === undefined ? [] : [String(heapMb)])], {
    cwd: packageDir,
    encoding: 'utf8',
    timeout: 90_000,
    env,
  });
  const last = child.stdout.trim().split('\n').pop() ?? '';
  let answer: Outcome['answer'];
  try {
    answer = JSON.parse(last) as Outcome['answer'];
  } catch {
    answer = undefined;
  }
  return { status: child.status, signal: child.signal, stderr: child.stderr, answer };
}

/** What a failed run says, so the failure reads as what happened: "ended by SIGABRT: FATAL ERROR: Reached heap limit...". */
const how = (o: Outcome): string => `${o.signal ?? `exit ${o.status}`}: ${o.stderr.split('\n').find((l) => l.includes('FATAL')) ?? o.stderr.slice(-200)}`;

describe('pages that are written out as a multiple of themselves, through the compiled pool', () => {
  // The five the third review found, the two it said were alike (more and fewer elements; the same page in two-byte
  // characters), and the ones in between: every one is refused as too large, none ends the host. (amp1 is the page written
  // out twice, 8.4 million characters, which the transform lets through now that a result may be 8 MiB, and the worker
  // refuses as bytes, being just over; the others are refused by the transform after its first pass.)
  it.each(['amp1', 'amp2', 'amp3', 'amp2_x10', 'amp2_x40', 'amp3_x50', 'amp3_twobyte'])(
    '%s is refused as too large, three times in three processes, and none of them ends',
    { timeout: 90_000 },
    (shape) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const outcome = run(shape);
        expect(outcome.status, `attempt ${attempt} was ended by ${how(outcome)}`).toBe(0);
        expect(outcome.answer, `attempt ${attempt}: ${outcome.stderr.slice(-200)}`).toMatchObject({ ok: false, reason: 'output_too_large', faults: [] });
        // Refused after the first parse and the weighing (amp1: after the second, and the bytes), not after reading the
        // whole of a result three or four times the page.
        expect(outcome.answer!.ms, `attempt ${attempt}`).toBeLessThan(2000);
      }
    },
  );

  it('serves the most a page can be let through at (half a heavy script, half attributes written out once more: 1.5 times the page), 6.3 MB, and the process is fine', { timeout: 90_000 }, () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const outcome = run('mixed');
      expect(outcome.status, `attempt ${attempt} was ended by ${how(outcome)}`).toBe(0);
      expect(outcome.answer, `attempt ${attempt}`).toMatchObject({ ok: true, faults: [] });
      expect(outcome.answer!.bytes).toBeGreaterThan(6_000_000);
    }
  });
});

describe('a page that needs more memory than the worker has ends the worker, and the host is fine', () => {
  // The fourth review's pages: 4 MiB of text inside a `<table>`, and the same inside a `<template>`. They need 352 to 368
  // MB; with the worker given 128, 160 or 192 V8 aborts the worker's PROCESS, which is the thing it does when a need is far
  // over the limit and which, to the host, is the worker's exit code and a refusal. With a worker that was a thread of the
  // host's, each of these ended the host with SIGABRT.
  it.each(['ttext', 'template_ttext'])('%s, with the worker given 128, 160 and 192 MB, is a refusal as out of memory, and the host exits 0', { timeout: 90_000 }, (shape) => {
    for (const heapMb of [128, 160, 192]) {
      const outcome = run(shape, heapMb);
      expect(outcome.status, `with ${heapMb} MB the host was ended by ${how(outcome)}`).toBe(0);
      // V8 aborted the worker, which is out of memory and which the fault's code says (its streams are ignored).
      expect(outcome.answer, `with ${heapMb} MB`).toMatchObject({ ok: false, reason: 'worker_oom', faults: ['worker_aborted'] });
    }
  });

  it('whatever becomes of 4 MiB of text inside a table with the default limit, it is an answer, and the host exits 0', { timeout: 90_000 }, () => {
    // At 384 these need 352 to 368: served or refused from one run to the next (`too_slow` when the collector has
    // worked hard enough, and the deadline on a machine that is slow). The test is that it is never the end of the host.
    for (const shape of ['ttext', 'template_ttext']) {
      const outcome = run(shape);
      expect(outcome.status, `${shape} was ended by ${how(outcome)}`).toBe(0);
      expect(outcome.answer, shape).toBeDefined();
      expect(['served', 'worker_oom', 'too_slow', 'worker_timeout']).toContain(outcome.answer!.ok ? 'served' : outcome.answer!.reason);
    }
  });

  it("is not changed by the host's own NODE_OPTIONS: a host given a heap of 96 MB gives the worker its own limit, and a worker given less is still only the worker that is ended", { timeout: 90_000 }, () => {
    // A NODE_OPTIONS of the host's with --max-old-space-size was what cut the worker THREAD's limit (the reviewer's probe:
    // 192 gave a limit of 384, an old generation of half what was asked for), and a worker process is given none of the
    // host's environment or flags. The page needs 144 to 160 MB: more than the host has, less than the worker.
    const served = run('script4', undefined, '--max-old-space-size=96');
    expect(served.status, `the host was ended by ${how(served)}`).toBe(0);
    expect(served.answer).toMatchObject({ ok: true, faults: [] });
    // ...and a page that needs more than the worker has, under the same host, is the worker's end and not the host's.
    const refused = run('ttext', 128, '--max-old-space-size=96');
    expect(refused.status, `the host was ended by ${how(refused)}`).toBe(0);
    expect(refused.answer).toMatchObject({ ok: false, reason: 'worker_oom', faults: ['worker_aborted'] });
  });
});

describe("in a container of 1 GiB (the chart's default host), where the worker is given 195 MB of old generation and not 384", () => {
  // A container limit ends every process in the container under `memory.oom.group`, so the worker's heap is a share of it
  // (prepare-pool.ts, `oldGenerationFor`). The heaviest pages that are plausible (4 MiB in one token) need 144 to 160 MB and are
  // still served; text inside a table (352 to 368) cannot be, and is an answer: out of memory, every time, where with 384 it is
  // served or refused according to how far the collector had got.
  it.each(['script4', 'attr4', 'bodies4', 'texts4', 'mixed'])('serves %s, and the host is fine', { timeout: 90_000 }, (shape) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const outcome = run(shape, undefined, undefined, 1024);
      expect(outcome.status, `attempt ${attempt} was ended by ${how(outcome)}`).toBe(0);
      expect(outcome.answer, `attempt ${attempt}`).toMatchObject({ ok: true, faults: [] });
    }
  });

  it('refuses 4 MiB of text inside a table as out of memory, three times in three processes, and the host exits 0', { timeout: 90_000 }, () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const outcome = run('ttext', undefined, undefined, 1024);
      expect(outcome.status, `attempt ${attempt} was ended by ${how(outcome)}`).toBe(0);
      expect(outcome.answer, `attempt ${attempt}`).toMatchObject({ ok: false, reason: 'worker_oom', faults: ['worker_aborted'] });
    }
  });
});

describe('a tag whose name is the page, with the worker at its default limit', () => {
  // The fifth review: `<a` + 4 MiB of `a` + `>` filled the worker's 384 MB (always, as out of memory) and the same with a
  // name 40 KB shorter, padded with text, was served by the transform. A name is refused as too much work after the first few
  // thousand characters of it, in a fraction of a second, and the refusal is the page's for good; the worker is not asked to
  // hold 128 MB of joins for it, and the host is fine.
  it.each(['tagname1', 'tagname_short'])('%s is refused as too much work at once, three times in three processes', { timeout: 90_000 }, (shape) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const outcome = run(shape);
      expect(outcome.status, `attempt ${attempt} was ended by ${how(outcome)}`).toBe(0);
      expect(outcome.answer, `attempt ${attempt}`).toMatchObject({ ok: false, reason: 'too_much_work', faults: [] });
      expect(outcome.answer!.ms, `attempt ${attempt}`).toBeLessThan(1500);
    }
  });
});

describe('the worker process that the pool starts, from the compiled package', () => {
  it('is below the host in priority, and asks the kernel to kill it before anything else', async () => {
    // It lowers its own priority and raises its own oom_score_adj when it starts. Started directly, the way the pool
    // starts it, so that the process can be looked at from outside.
    const { fork } = await import('node:child_process');
    const child = fork(distWorker, [WORKER_ARG], {
      execArgv: ['--max-old-space-size=128', '--max-semi-space-size=16'],
      env: {},
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
    });
    try {
      const ready = await new Promise<{ ready?: boolean; heapLimitMb?: number }>((resolve, reject) => {
        child.once('message', (m) => resolve(m as { ready?: boolean; heapLimitMb?: number }));
        child.once('exit', () => reject(new Error('the worker ended before it said it was ready')));
      });
      // It says what limit it really has: the old generation asked for and the young one the pool pins (3 x 16).
      expect(ready).toEqual({ ready: true, heapLimitMb: 128 + 48 });
      // Ten below the host, whatever the host runs at (a test runner started in the background may not be at 0).
      expect(getPriority(child.pid!)).toBe(Math.min(19, getPriority() + 10));
      if (process.platform === 'linux') expect(readFileSync(`/proc/${child.pid}/oom_score_adj`, 'utf8').trim()).toBe('1000');
    } finally {
      child.kill('SIGKILL');
    }
  });

  // The priority above is a thread's on Linux, and V8 starts helper threads (for the collector and the compiler) before the worker can
  // lower anything: measured, 29 to 50% of a worker's CPU on a heavy page ran on them, at the priority the host has, which is
  // what the lower priority was to prevent. The worker lowers every thread of its own, not only the one that asks.
  it.skipIf(process.platform !== 'linux')('has the lower priority on every one of its threads, the helper threads V8 made before it could lower anything included', async () => {
    const { fork } = await import('node:child_process');
    const child = fork(distWorker, [WORKER_ARG], {
      execArgv: ['--max-old-space-size=128', '--max-semi-space-size=16'],
      env: {},
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('exit', () => reject(new Error('the worker ended before it said it was ready')));
      });
      // Every task of the process: its nice value is field 19 of /proc/<pid>/task/<tid>/stat (fields count from the state, field 3,
      // after the command name's closing parenthesis).
      const threads = readdirSync(`/proc/${child.pid}/task`).map((tid) => {
        const stat = readFileSync(`/proc/${child.pid}/task/${tid}/stat`, 'utf8');
        return { tid, nice: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[16]) };
      });
      const lowered = Math.min(19, getPriority() + 10);
      // (V8 has four helpers of its own, a scheduler and the inspector's: the test is not about how many there are, but that it is not one.)
      expect(threads.length, JSON.stringify(threads)).toBeGreaterThan(1);
      expect(
        threads.filter((t) => t.nice !== lowered),
        `a thread of the worker is not at ${lowered}: ${JSON.stringify(threads)}`,
      ).toEqual([]);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('does not outlive the host that made it: when the host is killed, the worker goes', { timeout: 40_000 }, async () => {
    const host = spawnSync(process.execPath, [orphan], { cwd: packageDir, encoding: 'utf8', timeout: 30_000 });
    expect(host.signal, 'the fixture ends itself with SIGKILL').toBe('SIGKILL');
    const { pid } = JSON.parse(host.stdout.trim().split('\n').pop() ?? '{}') as { pid: number };
    expect(pid).toBeGreaterThan(0);
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let waited = 0; alive() && waited < 10_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alive(), `worker ${pid} is still running`).toBe(false);
  });
});

describe('the heap the heaviest pages need, against the one the worker is given (384 MB)', () => {
  // The transform reads each string flat as it arrives, so the joins parse5 makes while it builds a token go as the parse
  // goes: the heap it needs follows the biggest token, not the page. Measured, with that: the 1.5 times page needs under
  // 96 MB (256 to 288 before); a page of 4 MiB in tokens of 20 to 40 KB of any kind under 48; one token that is the
  // whole page (a 4 MiB script, a data URI, a tag with 200 long attributes, which is what the second pass sees of
  // 200 repeated <body> tags) 144 to 160 (the last, 136 to 144), which is the joins of that one token and cannot be
  // less. The one thing the reads cannot reach is text inside a `<table>`, which parse5 holds a token at a time: 352 to
  // 368 for 4 MiB, in the tests above. (The page of repeated <body> tags that is SERVED cannot tell whether the attributes
  // the repeated tags add are read flat in the FIRST pass: the second pass holds them all as one tag either way, and the
  // build before the reads served it with 160 as well. The one that tells is the same page refused after its first
  // parse, the last test here.) These run with well over those and well under the default, so a change that brings the
  // old figures back is seen here and not by a person with a host that has ended. (A limit far below the need ends the
  // worker, which the pool answers as out of memory, and the harness that stands for the host is fine.)
  it('serves the 1.5 times page with a third of the default heap (128 MB)', { timeout: 90_000 }, () => {
    const outcome = run('mixed', 128);
    expect(outcome.status, `was ended by ${how(outcome)}`).toBe(0);
    expect(outcome.answer).toMatchObject({ ok: true, faults: [] });
  });

  it.each(['texts4', 'comments4', 'names4', 'fostered4'])('serves 4 MiB in tokens of 20 to 40 KB (%s) with 96 MB', { timeout: 90_000 }, (shape) => {
    const outcome = run(shape, 96);
    expect(outcome.status, `was ended by ${how(outcome)}`).toBe(0);
    expect(outcome.answer).toMatchObject({ ok: true, faults: [] });
  });

  it.each([
    ['script4', 224],
    ['attr4', 224],
    // The one big tag of the second pass: served every time from 144 MB (18 runs in 18) and only some of the time at 140 and below.
    ['bodies4', 192],
  ] as const)('serves 4 MiB in one token (%s) with %i MB, well under the default', { timeout: 90_000 }, (shape, heapMb) => {
    const outcome = run(shape, heapMb);
    expect(outcome.status, `was ended by ${how(outcome)}`).toBe(0);
    expect(outcome.answer).toMatchObject({ ok: true, faults: [] });
  });

  // 200 repeated <body> tags with a quote in every character of their values (4 MiB; each quote is written as six characters,
  // so the page is refused as too large after its FIRST parse and the second never reads it). What it needs is what the first
  // parse holds of the attributes the repeated tags added to the first <body>, a value at a time: flat as they arrive, under
  // 32 MB; as the joins parse5 built them, all of them at once, about 122 MB. At 64 the first is refused and the second is
  // out of memory (the worker is ended, and the pool says so): this is the test that fails when `adoptAttributes` stops
  // reading what it adds.
  it('refuses 4 MiB of attributes that repeated <body> tags add, six times as long written out, as too large with 64 MB', { timeout: 90_000 }, () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const outcome = run('bodies4q', 64);
      expect(outcome.status, `attempt ${attempt} was ended by ${how(outcome)}`).toBe(0);
      expect(outcome.answer, `attempt ${attempt}`).toMatchObject({ ok: false, reason: 'output_too_large', faults: [] });
    }
  });
});
