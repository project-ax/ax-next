import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHtmlPreparer, prepareArtifactHtml, type HtmlPreparer, type HtmlPreparerOptions, type PreparedPage } from '../index.js';
import { GUARD_MARKER, MAX_PREPARED_BYTES } from '../prepare-html.js';
import { oldGenerationFor, readContainerMemoryLimit } from '../prepare-pool.js';
import { answerJob, handleJob, WORKER_ARG, WORKER_BUDGET_MS, type WorkerAnswer } from '../prepare-worker.js';
import { escapeAmplification } from './hostile-pages.js';

// Watches the transform, so a test can see with what limits the worker's part calls it.
vi.mock('../prepare-html.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../prepare-html.js')>();
  return { ...real, prepareArtifactHtml: vi.fn(real.prepareArtifactHtml) };
});

// The pool runs the transform in a process of its own, and says what became of each page. Its machinery is
// tested here with stand-in workers (fixtures/pool-worker.mjs: the page says what the worker does), in real
// processes with real limits and a real deadline, so a worker that is ended, runs out of memory or crashes is
// the real thing. The real worker's own part (`answerJob`) is tested below, in this process, and end to end
// where the package is used from its compiled form (prepare-pool-shapes.test.ts, and @ax/attachments' content
// origin tests).

const WORKER = new URL('./fixtures/pool-worker.mjs', import.meta.url);
const STARTS = new URL('./fixtures/pool-worker-start.mjs', import.meta.url);
const MiB = 1024 * 1024;

const open: HtmlPreparer[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

/** No container limit: the heap the worker is given is the one asked for, wherever these tests run (a CI job in a container has a limit). */
const NO_LIMIT = (): undefined => undefined;

function preparer(options: HtmlPreparerOptions = {}): HtmlPreparer {
  const p = createHtmlPreparer({ workerUrl: WORKER, containerMemoryBytes: NO_LIMIT, ...options });
  open.push(p);
  return p;
}

/** What a page came to, as a string. The stand-in workers put the guard in front of what they say (the pool wants it there); it is taken off here. */
function said(page: PreparedPage): string {
  if (!page.ok) return `refused:${page.reason}`;
  const text = new TextDecoder().decode(page.bytes);
  return text.startsWith(GUARD_MARKER) ? text.slice(GUARD_MARKER.length) : text;
}
/** The process a stand-in worker ran in: its `echo` answers `pid:argument`. */
const pid = (page: PreparedPage): number => Number(said(page).split(':')[0]);
const refusal = (page: PreparedPage): string => (page.ok ? 'answered' : page.reason);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (id: number): boolean => {
  try {
    process.kill(id, 0);
    return true;
  } catch {
    return false;
  }
};
/** Whether a process is gone, giving it a moment: a killed process is gone as soon as the kernel and the parent have seen to it. */
async function goneWithin(id: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (!alive(id)) return true;
  return !alive(id);
}

/** What the pool tells `onFault`: the errors, with their codes. */
function faults(): { seen: Array<Error & { code?: string }>; report: (fault: unknown) => void; codes: () => Array<string | undefined> } {
  const seen: Array<Error & { code?: string }> = [];
  return { seen, report: (fault) => void seen.push(fault as Error & { code?: string }), codes: () => seen.map((e) => e.code) };
}

describe('a page goes to the worker and comes back as bytes', () => {
  it('answers with what the worker made', async () => {
    const page = await preparer().prepare('echo:hello');
    expect(page.ok).toBe(true);
    expect(page.ok && page.bytes).toBeInstanceOf(Uint8Array);
    expect(said(page)).toMatch(/^\d+:hello$/);
  });

  it('runs it in another process, not in this one', async () => {
    const worker = pid(await preparer().prepare('echo:x'));
    expect(worker).toBeGreaterThan(0);
    expect(worker).not.toBe(process.pid);
  });

  it('does not keep the process alive once its pages are answered, and the worker does not outlive the process', { timeout: 40_000 }, async () => {
    // A worker that was not unref-ed would hold a command, a test run or a server that is shutting down open for good, and
    // so would the timer that ends an idle worker if it were not (the fixture gives it an hour); one that did not end when
    // the process that made it did would be left running for good.
    const fixture = fileURLToPath(new URL('./fixtures/idle-pool.ts', import.meta.url));
    const child = spawnSync(process.execPath, ['--import', 'tsx', fixture], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(child.error, 'the child did not end by itself').toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('"ok":true');
    const { pid: worker } = JSON.parse(child.stdout.trim().split('\n').pop() ?? '{}') as { pid: number };
    expect(worker).toBeGreaterThan(0);
    expect(await goneWithin(worker, 5000), `worker ${worker} is still running`).toBe(true);
  });

  it('keeps the one worker for the pages that follow', async () => {
    const p = preparer();
    const first = pid(await p.prepare('echo:1'));
    expect(pid(await p.prepare('echo:2'))).toBe(first);
    expect(pid(await p.prepare('echo:3'))).toBe(first);
  });

  it("passes on the transform's own refusal", async () => {
    expect(await preparer().prepare('refuse:too_deep')).toEqual({ ok: false, reason: 'too_deep' });
  });

  it('leaves no timer behind once the page is answered (the deadline is for a page that is not)', async () => {
    const p = preparer({ deadlineMs: 60_000 });
    await p.prepare('echo:warm'); // the worker is started, and any timers it needs exist
    const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = timers();
    await p.prepare('echo:x');
    expect(timers()).toBe(before);
  });

  it('prepares one page at a time, in the order they came', async () => {
    const p = preparer();
    const pages = await Promise.all([p.prepare('window:120'), p.prepare('window:10'), p.prepare('window:10')]);
    const spans = pages.map((page) => said(page).split(':').map(Number) as [number, number]);
    expect(spans[0]![1]).toBeLessThanOrEqual(spans[1]![0]);
    expect(spans[1]![1]).toBeLessThanOrEqual(spans[2]![0]);
  });

  it('gives the worker nothing of this process: no environment, none of its flags, only its own heap flags and the page', async () => {
    process.env.AX_POOL_TEST_SECRET = 'do-not-leak';
    process.env.NODE_OPTIONS = '--no-warnings';
    try {
      // The environment (a NODE_OPTIONS of the host's is the one that would change the limits the worker is given),
      // Node's flags (the pool's two, and none of ours), and the arguments (the one that says it is the worker).
      expect(said(await preparer().prepare('env:'))).toBe(
        `[] ${JSON.stringify(['--max-old-space-size=384', '--max-semi-space-size=16'])} ${JSON.stringify([WORKER_ARG])}`,
      );
    } finally {
      delete process.env.AX_POOL_TEST_SECRET;
      delete process.env.NODE_OPTIONS;
    }
  });

  it('gives the worker no standard streams: all three are /dev/null, so nothing it writes is anywhere and nothing is read from the host', async () => {
    expect(said(await preparer().prepare('stdio:'))).toBe('[true,true,true]');
  });

  it('gives the worker the heap limit it was asked for, and pins the young generation', async () => {
    expect(said(await preparer({ maxOldGenerationSizeMb: 200 }).prepare('env:'))).toContain('"--max-old-space-size=200","--max-semi-space-size=16"');
  });
});

describe('a worker that is held, out of memory, or gone', () => {
  it('ends a page that outstays the deadline, and the next page gets a new worker', async () => {
    const f = faults();
    const p = preparer({ deadlineMs: 150, onFault: f.report });
    const before = pid(await p.prepare('echo:before'));
    const started = performance.now();
    expect(await p.prepare('spin:')).toEqual({ ok: false, reason: 'worker_timeout' });
    // The deadline, not something that takes much longer than it.
    expect(performance.now() - started).toBeLessThan(1500);
    // The worker that was ended says it has gone while the pool is idle: that is what was done to it, not a fault.
    await sleep(150);
    expect(f.seen).toEqual([]);
    const after = await p.prepare('echo:after');
    expect(said(after)).toMatch(/:after$/);
    expect(pid(after)).not.toBe(before);
  });

  it('really ends the worker it gives up on: nothing is left running', async () => {
    // A worker that was "ended" but still ran would hold a core for good.
    const p = preparer({ deadlineMs: 150 });
    const worker = pid(await p.prepare('echo:who'));
    expect(await p.prepare('spin:')).toEqual({ ok: false, reason: 'worker_timeout' });
    expect(await goneWithin(worker, 3000), `worker ${worker} is still running`).toBe(true);
  });

  it('answers a page that runs the worker out of memory as that, and the process, and the next page, are fine', async () => {
    const f = faults();
    const p = preparer({ maxOldGenerationSizeMb: 64, onFault: f.report });
    const before = pid(await p.prepare('echo:before'));
    expect(await p.prepare('oom:')).toEqual({ ok: false, reason: 'worker_oom' });
    const after = await p.prepare('echo:after');
    expect(pid(after)).not.toBe(before);
    // V8's message is nowhere (the worker's streams are ignored): the fault's code is the trace that it was an abort.
    expect(f.codes()).toEqual(['worker_aborted']);
    expect(alive(before)).toBe(false);
  });

  it('answers a worker that V8 aborts as out of memory (that is the only way V8 ends a process for its heap), and says it aborted', async () => {
    const f = faults();
    const p = preparer({ onFault: f.report });
    expect(await p.prepare('abort:')).toEqual({ ok: false, reason: 'worker_oom' });
    expect(f.codes()).toEqual(['worker_aborted']);
    expect(f.seen[0]!.message).toContain('signal SIGABRT');
    expect(said(await p.prepare('echo:after'))).toMatch(/:after$/);
  });

  it('answers a worker that ends with exit code 134 (a shell\'s way of saying SIGABRT, and a process that reports it so) as out of memory too', async () => {
    const f = faults();
    const p = preparer({ onFault: f.report });
    expect(await p.prepare('exit:134')).toEqual({ ok: false, reason: 'worker_oom' });
    expect(f.codes()).toEqual(['worker_aborted']);
    expect(f.seen[0]!.message).toContain('exit code 134');
    // ...and any other code, with a page in hand, is a crash on that page
    expect(await p.prepare('exit:135')).toEqual({ ok: false, reason: 'worker_crashed' });
    expect(f.codes()).toEqual(['worker_aborted', 'worker_exit_135']);
  });

  it('answers a worker that was killed from outside as out of memory (in a pod it is the kernel), and tells onFault', async () => {
    const f = faults();
    const p = preparer({ onFault: f.report });
    expect(await p.prepare('signal:SIGKILL')).toEqual({ ok: false, reason: 'worker_oom' });
    expect(f.codes()).toEqual(['worker_killed']);
    expect(said(await p.prepare('echo:after'))).toMatch(/:after$/);
  });

  it('answers a worker that another signal ended, with a page in hand, as crashed (the page\'s), with the signal in the fault code', async () => {
    const f = faults();
    const p = preparer({ onFault: f.report });
    expect(await p.prepare('signal:SIGTERM')).toEqual({ ok: false, reason: 'worker_crashed' });
    expect(f.codes()).toEqual(['worker_signal_SIGTERM']);
  });

  it('answers a worker that throws, with a page in hand, as crashed, tells onFault what happened to it, and starts another for the next page', async () => {
    const f = faults();
    const p = preparer({ onFault: f.report });
    const before = pid(await p.prepare('echo:before'));
    expect(await p.prepare('throw:')).toEqual({ ok: false, reason: 'worker_crashed' });
    expect(f.codes()).toEqual(['worker_exit_1']);
    expect(f.seen[0]).toBeInstanceOf(Error);
    expect(f.seen[0]!.message).toContain('exit code 1');
    expect(pid(await p.prepare('echo:after'))).not.toBe(before);
  });

  it('answers a worker that exits, with a page in hand, as crashed, and tells onFault with the exit code', async () => {
    const f = faults();
    const p = preparer({ onFault: f.report });
    expect(await p.prepare('exit:')).toEqual({ ok: false, reason: 'worker_crashed' });
    expect(f.codes()).toEqual(['worker_exit_3']);
    expect(said(await p.prepare('echo:after'))).toMatch(/:after$/);
  });

  it('answers a worker that cannot be made at all (Node refuses its options) as failed, tells onFault, and does not throw', async () => {
    const f = faults();
    const p = preparer({ execArgv: ['--there-is-no-such-flag'], onFault: f.report });
    expect(await p.prepare('echo:1')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(await p.prepare('echo:2')).toEqual({ ok: false, reason: 'worker_failed' });
    // Node ends with 9 for an option it does not know.
    expect(f.codes()).toEqual(['worker_start_exit_9', 'worker_start_exit_9']);
  });

  it('does not strand the pages waiting behind one when no worker can be made for them', async () => {
    // The worker starts fine for the first page; then Node starts refusing to make one (here: the options the pool
    // reads each time it does are changed under it). The page that ends the first worker, and the two waiting, must
    // each be answered, not left waiting for a worker that is never made.
    const f = faults();
    const argv: string[] = [];
    const p = preparer({ execArgv: argv, onFault: f.report });
    expect(said(await p.prepare('echo:warm'))).toMatch(/:warm$/);
    argv.push('--there-is-no-such-flag');
    const pages = [p.prepare('exit:'), p.prepare('echo:b'), p.prepare('echo:c')];
    expect(await Promise.all(pages)).toEqual([
      { ok: false, reason: 'worker_crashed' }, // the worker that exited had the page
      { ok: false, reason: 'worker_failed' }, // and the two that could not be made did not
      { ok: false, reason: 'worker_failed' },
    ]);
    expect(f.codes()).toEqual(['worker_exit_3', 'worker_start_exit_9', 'worker_start_exit_9']);
  });

  it('answers a worker that cannot start (its file is not there) as failed, not a hang, and keeps answering', async () => {
    const f = faults();
    const p = preparer({ workerUrl: new URL('./fixtures/there-is-no-such-worker.mjs', import.meta.url), onFault: f.report });
    expect(await p.prepare('echo:1')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(await p.prepare('echo:2')).toEqual({ ok: false, reason: 'worker_failed' });
    // Node ends with 1 for a module it cannot load.
    expect(f.codes()).toEqual(['worker_start_exit_1', 'worker_start_exit_1']);
  });

  it('does not trust what is not an answer: a message with no id is ignored, one with no answer in it ends the worker', async () => {
    const f = faults();
    const p = preparer({ onFault: f.report });
    const before = pid(await p.prepare('echo:before'));
    expect(await p.prepare('nonsense:')).toEqual({ ok: false, reason: 'worker_crashed' });
    expect(f.codes()).toEqual(['worker_bad_message']);
    const after = pid(await p.prepare('echo:after'));
    expect(after).not.toBe(before);
    expect(await goneWithin(before, 2000), `worker ${before} is still running`).toBe(true);
  });

  it('gives the pages waiting behind a worker that sent nonsense to a new worker, not the one it ended', async () => {
    const p = preparer();
    const before = pid(await p.prepare('echo:before'));
    const pages = [p.prepare('nonsense:'), p.prepare('echo:b'), p.prepare('echo:c')];
    const [first, second, third] = await Promise.all(pages);
    expect(first).toEqual({ ok: false, reason: 'worker_crashed' });
    expect(said(second!)).toMatch(/:b$/);
    expect(said(third!)).toMatch(/:c$/);
    // Both on the one new worker, which is not the one that was ended.
    expect(pid(second!)).not.toBe(before);
    expect(pid(third!)).toBe(pid(second!));
  });

  it.each(['made_up_code', 'constructor', 'toString', '__proto__', ''])(
    'does not take a refusal code it does not know (%j, names on the prototype included): that is a worker that is not working',
    async (code) => {
      const f = faults();
      const p = preparer({ onFault: f.report });
      expect(await p.prepare(`refuse:${code}`)).toEqual({ ok: false, reason: 'worker_crashed' });
      expect(f.codes()).toEqual(['worker_bad_message']);
    },
  );

  describe('an answer that the transform cannot have made is not served', () => {
    // What the worker says is looked at before it is served: how much of it there is, and that the guard is in it. That is a check
    // that the answer is the worker's work, so a worker that is wrong (a file left behind by an old build, a bug that returns the page
    // as it came) is not served as if it were right. It is not a defense against a worker that has been taken over: that one
    // can write the guard, and anything else beside it.
    const unguarded = '<html><body><iframe srcdoc="x"></iframe>no guard</body></html>';

    it('refuses a page with no guard in it as crashed (the page\'s), says why, and does not use that worker again', async () => {
      const f = faults();
      const p = preparer({ onFault: f.report });
      const before = pid(await p.prepare('echo:before'));
      expect(await p.prepare(`unguarded:${unguarded}`)).toEqual({ ok: false, reason: 'worker_crashed' });
      expect(f.codes()).toEqual(['worker_bad_answer']);
      expect(pid(await p.prepare('echo:after'))).not.toBe(before);
      expect(await goneWithin(before, 2000), `worker ${before} is still running`).toBe(true);
    });

    it('refuses an empty page', async () => {
      const f = faults();
      expect(await preparer({ onFault: f.report }).prepare('unguarded:')).toEqual({ ok: false, reason: 'worker_crashed' });
      expect(f.codes()).toEqual(['worker_bad_answer']);
    });

    it('looks for the guard in the page and not around it: a message with the guard on both sides of a page without it is refused', async () => {
      // The bytes a worker sends arrive as a view onto the whole message, so the search is of the view and not of the buffer it is in.
      const f = faults();
      expect(await preparer({ onFault: f.report }).prepare(`smuggled:${unguarded}`)).toEqual({ ok: false, reason: 'worker_crashed' });
      expect(f.codes()).toEqual(['worker_bad_answer']);
    });

    it('refuses a page of more than a page is let be (8 MiB), with the guard in it, and takes one of exactly that size', async () => {
      const f = faults();
      const p = preparer({ onFault: f.report });
      expect(await p.prepare(`bytes:${MAX_PREPARED_BYTES + 1}`)).toEqual({ ok: false, reason: 'worker_crashed' });
      expect(f.codes()).toEqual(['worker_bad_answer']);
      const exact = await p.prepare(`bytes:${MAX_PREPARED_BYTES}`);
      expect(exact.ok && exact.bytes.byteLength).toBe(MAX_PREPARED_BYTES);
      expect(f.codes()).toEqual(['worker_bad_answer']);
    });
  });
});

describe('a worker that starts wrongly is not used', () => {
  // What a worker says when it starts is the pool's one check on it. `--title` is a flag Node takes and a worker can read back.
  const starts = (how: string, options: HtmlPreparerOptions = {}): HtmlPreparer => preparer({ workerUrl: STARTS, execArgv: [`--title=${how}`], ...options });

  it('takes a worker that says it is ready with the heap limit the pool asked for', async () => {
    const f = faults();
    expect(said(await starts('right', { onFault: f.report }).prepare('anything'))).toBe('answered');
    expect(f.seen).toEqual([]);
  });

  it.each(['limit-high', 'limit-low'])('refuses a worker whose heap limit is not the one asked for (%s), tells onFault, and ends it', async (how) => {
    const f = faults();
    expect(await starts(how, { onFault: f.report }).prepare('anything')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(f.codes()).toEqual(['worker_limit_mismatch']);
    expect(f.seen[0]!.message).toMatch(/heap limit of \d+ MB and was asked for 432 MB/);
  });

  it('refuses a worker whose heap limit really is not the one asked for: a flag of the caller\'s that comes after the pool\'s', async () => {
    // The stand-in reports the limit its V8 really has. Asked for 384 MB and given 1024 by a flag, it is not protecting anything.
    const f = faults();
    const p = preparer({ execArgv: ['--max-old-space-size=1024'], onFault: f.report });
    expect(await p.prepare('echo:x')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(f.codes()).toEqual(['worker_limit_mismatch']);
  });

  it.each(['talks', 'answers', 'bad-limit'])('refuses a worker whose first message is not "ready" with a number (%s)', async (how) => {
    const f = faults();
    expect(await starts(how, { onFault: f.report }).prepare('anything')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(f.codes()).toEqual(['worker_bad_ready']);
  });

  it('gives a worker that never says it is ready the deadline, which starting it counts against', async () => {
    const f = faults();
    const started = performance.now();
    expect(await starts('silent', { deadlineMs: 300, onFault: f.report }).prepare('anything')).toEqual({ ok: false, reason: 'worker_timeout' });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(f.seen).toEqual([]);
  });

  it('starts another worker for the next page, and that one is checked too', async () => {
    const f = faults();
    const p = starts('limit-high', { onFault: f.report });
    expect(refusal(await p.prepare('one'))).toBe('worker_failed');
    expect(refusal(await p.prepare('two'))).toBe('worker_failed');
    expect(f.codes()).toEqual(['worker_limit_mismatch', 'worker_limit_mismatch']);
  });
});

describe("the worker's heap is sized from the container's memory limit", () => {
  // The worker is a process of the container the host is in. A V8 heap abort ends the worker alone, but a limit on the container's
  // memory does not: under `memory.oom.group` (Kubernetes sets it on cgroup v2 by default) the kernel ends EVERY process in the container,
  // the host with them, and `oom_score_adj` only chooses who is first. Measured: a container of 600 MiB, the host holding 300 MB,
  // 4 MiB of text inside a table: the container exits 137, with the default heap and with a larger one. So the heap a page can fill
  // is a share of the limit (30%, less the young generation's 48 MB and the 64 MB a worker is resident beyond its heap).
  const mib = (n: number): number => n * MiB;
  /** The old generation the pool started the stand-in with. The stand-in says its real heap limit, which the pool has to find as it asked. */
  const startedWith = async (p: HtmlPreparer): Promise<number> => Number(/--max-old-space-size=(\d+)/.exec(said(await p.prepare('env:')))?.[1]);

  it.each([
    [undefined, 384], // no limit: what was asked for
    [mib(64 * 1024), 384],
    [mib(2048), 384], // the host of gke-values.yaml and kind-dev-values.yaml: 614 MB for the worker, 502 of old generation would fit
    [mib(1654), 384], // the least that gives all of 384
    [mib(1653), 383],
    [mib(1536), 348],
    [mib(1024), 195], // the chart's default host (values.yaml)
    [mib(768), 118],
    [mib(600), 68],
    [mib(512), 41],
    [mib(427), 16], // the least a worker can be given is what is left
    [mib(256), 16], // ...and where nothing is
  ])('a container of %s bytes gives the worker %s MB of old generation', (limit, expected) => {
    expect(oldGenerationFor(384, limit).oldMb).toBe(expected);
  });

  it('says where the share cannot be met: the least a worker can be given is more than the container leaves it', () => {
    expect(oldGenerationFor(384, mib(427)).budgetMet).toBe(true);
    expect(oldGenerationFor(384, mib(426))).toEqual({ oldMb: 16, budgetMet: false });
    expect(oldGenerationFor(384, undefined).budgetMet).toBe(true);
  });

  it('keeps a smaller heap that was asked for, and never gives more than was asked for', () => {
    expect(oldGenerationFor(100, mib(8192)).oldMb).toBe(100);
    expect(oldGenerationFor(100, mib(1024)).oldMb).toBe(100);
    expect(oldGenerationFor(250, mib(1024)).oldMb).toBe(195);
  });

  it('starts the worker with the heap the container leaves it, and takes it only if it has that', async () => {
    const f = faults();
    expect(await startedWith(preparer({ containerMemoryBytes: () => mib(1024), onFault: f.report }))).toBe(195);
    expect(f.codes()).toEqual([]);
  });

  it('reads the limit for each worker it starts: a container that is given more memory gets the bigger worker when the next one starts', async () => {
    let limit = mib(1024);
    const p = preparer({ containerMemoryBytes: () => limit });
    expect(await startedWith(p)).toBe(195);
    limit = mib(2048);
    expect(await startedWith(p)).toBe(195); // the worker that is running is kept
    expect(await p.prepare('exit:')).toEqual({ ok: false, reason: 'worker_crashed' });
    expect(await startedWith(p)).toBe(384);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 64, 2 ** 63 - 4096, '1073741824' as unknown as number])(
    'takes %s for no limit (Node says 2^64 where the cgroup says "max", and 0 where it cannot tell)',
    async (nonsense) => {
      expect(await startedWith(preparer({ containerMemoryBytes: () => nonsense }))).toBe(384);
    },
  );

  it('takes a reader that throws for no limit', async () => {
    const throws = (): never => {
      throw new Error('no cgroup');
    };
    expect(await startedWith(preparer({ containerMemoryBytes: throws }))).toBe(384);
  });

  it('tells onFault once, and still serves what fits, where the container leaves the worker less than the least it can be given', async () => {
    const f = faults();
    const p = preparer({ containerMemoryBytes: () => mib(200), onFault: f.report });
    expect(await startedWith(p)).toBe(16);
    expect(await p.prepare('exit:')).toEqual({ ok: false, reason: 'worker_crashed' });
    expect(await startedWith(p)).toBe(16); // a second worker
    expect(f.codes().filter((code) => code === 'worker_budget_too_small')).toEqual(['worker_budget_too_small']);
  });

  describe('the limit Node reads of the real container', () => {
    const cgroupMax = ((): string | undefined => {
      try {
        return readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
      } catch {
        return undefined; // not Linux, or cgroup v1
      }
    })();

    it('is a limit or none, and never a number that is not one', () => {
      const limit = readContainerMemoryLimit();
      expect(limit === undefined || (Number.isFinite(limit) && limit > 0 && limit < 2 ** 50)).toBe(true);
    });

    it.skipIf(cgroupMax === undefined || cgroupMax === 'max')("is the container's memory.max when it has one (run in a container with --memory)", () => {
      expect(readContainerMemoryLimit()).toBe(Number(cgroupMax));
    });

    it.skipIf(cgroupMax !== 'max')('is none where memory.max says "max"', () => {
      expect(readContainerMemoryLimit()).toBeUndefined();
    });
  });
});

describe('turning pages away', () => {
  it('answers busy at once when pages are already waiting, and serves the ones that were let in, in order', async () => {
    const p = preparer({ maxQueued: 2 });
    // One being prepared, two waiting: the most it lets in.
    const running = p.prepare('window:300');
    const waiting = [p.prepare('echo:a'), p.prepare('echo:b')];
    const turnedAway = await Promise.race([p.prepare('echo:c'), new Promise<string>((resolve) => setTimeout(() => resolve('too slow'), 200))]);
    expect(turnedAway).toEqual({ ok: false, reason: 'busy' });
    expect(refusal(await running)).toBe('answered');
    expect((await Promise.all(waiting)).map(said)).toEqual([expect.stringMatching(/:a$/), expect.stringMatching(/:b$/)]);
    // ...and with the line gone it takes pages again.
    expect(said(await p.prepare('echo:d'))).toMatch(/:d$/);
  });

  it('turns away a page that would take the text it is holding past maxQueuedChars, takes a small one, and takes any page when it holds nothing', async () => {
    // Each page is a string the caller made and the worker has not read, so the line is bounded by how much text is in it too.
    const p = preparer({ maxQueuedChars: 1000 });
    const page = (letter: string, chars: number): string => `echo:${letter.repeat(chars - 5)}`;
    const first = p.prepare(page('a', 600));
    expect(await p.prepare(page('b', 600))).toEqual({ ok: false, reason: 'busy' }); // 600 + 600 > 1000
    const small = p.prepare(page('c', 300)); // 600 + 300 <= 1000
    expect(refusal(await first)).toBe('answered');
    expect(refusal(await small)).toBe('answered');
    // With nothing held, a page bigger than the whole bound is taken: the bound is on the line, not on a page.
    expect(refusal(await p.prepare(page('d', 5000)))).toBe('answered');
  });

  it('with no line at all (maxQueued 0) takes one page at a time', async () => {
    const p = preparer({ maxQueued: 0 });
    const running = p.prepare('window:150');
    expect(await p.prepare('echo:x')).toEqual({ ok: false, reason: 'busy' });
    expect(refusal(await running)).toBe('answered');
    expect(said(await p.prepare('echo:y'))).toMatch(/:y$/);
  });

  describe('when the worker has been busy for too much of the last few seconds', () => {
    // The pool keeps its own clock for this, so a test can move it: a page "takes" as long as the clock
    // moves between the pool handing it over and the answer coming back.
    function clock(): { now: () => number; set: (t: number) => void } {
      let t = 0;
      return { now: () => t, set: (to) => void (t = to) };
    }
    const BUSY = { maxBusyMs: 5000, busyWindowMs: 10_000 };

    it('turns the next page away, until the busy time has left the window', async () => {
      const c = clock();
      const p = preparer({ ...BUSY, now: c.now });
      const first = p.prepare('echo:a');
      c.set(3000); // the first page took 3 s
      expect(refusal(await first)).toBe('answered');
      const second = p.prepare('echo:b');
      c.set(6000); // and the second 3 s more: 6 s in the window, over the 5 s
      expect(refusal(await second)).toBe('answered');
      expect(await p.prepare('echo:c')).toEqual({ ok: false, reason: 'busy' });
      // At 14 s the first page's 3 s (it ended at 3 s) is out of the 10 s window, the second's (ended at 6 s) is not: 3 s left.
      c.set(14_000);
      expect(said(await p.prepare('echo:d'))).toMatch(/:d$/);
    });

    it('counts the page being prepared now, not only the ones that are done', async () => {
      const c = clock();
      const p = preparer({ ...BUSY, maxQueued: 4, now: c.now });
      const running = p.prepare('window:200');
      c.set(6000); // it has had the worker for 6 s of the window already
      expect(await p.prepare('echo:x')).toEqual({ ok: false, reason: 'busy' });
      expect(refusal(await running)).toBe('answered');
    });

    it('is not tripped by pages that are quick', async () => {
      const c = clock();
      const p = preparer({ ...BUSY, now: c.now });
      for (let i = 0; i < 20; i++) {
        c.set(i * 100);
        expect(refusal(await p.prepare(`echo:${i}`))).toBe('answered');
      }
    });
  });
});

describe('when workers keep failing', () => {
  // `worker_failed` is not remembered with a page, so a machine that cannot make a worker (no memory to fork, a file that is gone)
  // had every view start a process and write an error to the log. After `failureLimit` of them in a row pages are turned away as
  // busy, with no worker made for them, for `coolDownMs`; then one is tried. ONLY a failure no page can cause counts: the count is
  // global, and a page that crashes the worker is that page's refusal (remembered with it), or a few such pages would turn every
  // tenant's pages away.
  function clock(): { now: () => number; set: (t: number) => void } {
    let t = 0;
    return { now: () => t, set: (to) => void (t = to) };
  }
  const BAD = '--there-is-no-such-flag';
  /**
   * A pool whose workers cannot be started while it is broken (the options are read each time one is made). `crash` ends the
   * worker that is running, by a page that makes it exit (its refusal, which does not count), so that the next page has to start one.
   */
  function breakable(options: HtmlPreparerOptions = {}): { p: HtmlPreparer; broken: (on: boolean) => void; crash: () => Promise<void> } {
    const argv: string[] = [];
    const p = preparer({ execArgv: argv, ...options });
    return {
      p,
      broken: (on) => {
        argv.length = 0;
        if (on) argv.push(BAD);
      },
      crash: async () => void (await p.prepare('exit:')),
    };
  }
  const fail = async (p: HtmlPreparer, times: number): Promise<void> => {
    for (let i = 0; i < times; i++) expect(await p.prepare('echo:x')).toEqual({ ok: false, reason: 'worker_failed' });
  };

  it('turns pages away as busy after five workers in a row that could not be started, makes no worker for them, and tries one when the cool-down is over', async () => {
    const f = faults();
    const c = clock();
    const { p, broken } = breakable({ now: c.now, onFault: f.report });
    broken(true);
    await fail(p, 5);
    expect(f.codes()).toEqual(Array(5).fill('worker_start_exit_9'));
    const started = performance.now();
    for (let i = 0; i < 3; i++) expect(await p.prepare('echo:x')).toEqual({ ok: false, reason: 'busy' });
    expect(performance.now() - started).toBeLessThan(500); // no process is started for a page that is turned away
    expect(f.seen).toHaveLength(5); // nothing failed, so nothing was logged
    broken(false);
    c.set(29_999);
    expect(refusal(await p.prepare('echo:x'))).toBe('busy');
    c.set(30_000);
    expect(said(await p.prepare('echo:again'))).toMatch(/:again$/);
  });

  it('puts the count back to none on an answer: four failures, a page, and four failures are not five in a row', async () => {
    const { p, broken, crash } = breakable({ now: clock().now });
    broken(true);
    await fail(p, 4);
    broken(false);
    expect(said(await p.prepare('echo:between'))).toMatch(/:between$/);
    await crash(); // it is running: ended, so that the next page has to start one
    broken(true);
    await fail(p, 4);
    broken(false);
    expect(said(await p.prepare('echo:after'))).toMatch(/:after$/);
  });

  it('counts the refusal of a page as an answer too: the worker did what it is for', async () => {
    const { p, broken, crash } = breakable({ now: clock().now });
    broken(true);
    await fail(p, 4);
    broken(false);
    expect(await p.prepare('refuse:too_deep')).toEqual({ ok: false, reason: 'too_deep' });
    await crash();
    broken(true);
    await fail(p, 4);
    broken(false);
    expect(refusal(await p.prepare('echo:x'))).toBe('answered');
  });

  it('tries one page after the cool-down, and at the first failure of that one turns pages away again at once', async () => {
    const c = clock();
    const f = faults();
    const { p, broken, crash } = breakable({ now: c.now, onFault: f.report });
    broken(true);
    await fail(p, 5);
    c.set(30_000);
    await fail(p, 1); // the one that is tried
    expect(refusal(await p.prepare('echo:x'))).toBe('busy'); // not five more: one
    expect(f.seen).toHaveLength(6);
    broken(false);
    c.set(59_999);
    expect(refusal(await p.prepare('echo:x'))).toBe('busy');
    c.set(60_000);
    expect(said(await p.prepare('echo:ok'))).toMatch(/:ok$/);
    await crash();
    broken(true);
    await fail(p, 4); // and a worker that answered started the count again from none
    broken(false);
    expect(said(await p.prepare('echo:fine'))).toMatch(/:fine$/);
  });

  it('does NOT count what a page can do to the worker: pages that abort it, hold it, crash it or break its protocol, any number of them, turn nobody away', async () => {
    // The count is global. If a crash on a page were a failure of the pool, N pages that crash the parser would put every
    // other tenant's uncached page into 'busy'. Each of these is that page's refusal, and the next page is served.
    const f = faults();
    const p = preparer({ now: clock().now, deadlineMs: 150, onFault: f.report });
    for (let i = 0; i < 8; i++) expect(await p.prepare('abort:')).toEqual({ ok: false, reason: 'worker_oom' });
    for (let i = 0; i < 6; i++) expect(await p.prepare('sleep:')).toEqual({ ok: false, reason: 'worker_timeout' });
    for (let i = 0; i < 8; i++) expect(await p.prepare('exit:')).toEqual({ ok: false, reason: 'worker_crashed' });
    for (let i = 0; i < 8; i++) expect(await p.prepare('throw:')).toEqual({ ok: false, reason: 'worker_crashed' });
    for (let i = 0; i < 8; i++) expect(await p.prepare('signal:SIGTERM')).toEqual({ ok: false, reason: 'worker_crashed' });
    for (let i = 0; i < 8; i++) expect(await p.prepare('nonsense:')).toEqual({ ok: false, reason: 'worker_crashed' });
    for (let i = 0; i < 8; i++) expect(await p.prepare('unguarded:no guard')).toEqual({ ok: false, reason: 'worker_crashed' });
    expect(said(await p.prepare('echo:fine'))).toMatch(/:fine$/);
    // ...and each was told to onFault, so that it is in the log
    expect(f.seen.length).toBeGreaterThanOrEqual(8 * 6);
  });

  it('DOES count a worker that has not the limit it was asked for, one whose first word is not "ready", and one that cannot be forked: no page was sent to any of them', async () => {
    const f = faults();
    const wrong = preparer({ now: clock().now, workerUrl: STARTS, execArgv: ['--title=limit-high'], onFault: f.report });
    for (let i = 0; i < 5; i++) expect(refusal(await wrong.prepare('x'))).toBe('worker_failed');
    expect(refusal(await wrong.prepare('x'))).toBe('busy');
    expect(f.codes()).toEqual(Array(5).fill('worker_limit_mismatch'));

    const g = faults();
    const mute = preparer({ now: clock().now, workerUrl: STARTS, execArgv: ['--title=talks'], onFault: g.report });
    for (let i = 0; i < 5; i++) expect(refusal(await mute.prepare('x'))).toBe('worker_failed');
    expect(refusal(await mute.prepare('x'))).toBe('busy');
    expect(g.codes()).toEqual(Array(5).fill('worker_bad_ready'));

    // fork itself throws for an argument with a NUL in it
    const h = faults();
    const unmade = preparer({ now: clock().now, execArgv: ['--title=a\u0000b'], onFault: h.report });
    for (let i = 0; i < 5; i++) expect(await unmade.prepare('x')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(refusal(await unmade.prepare('x'))).toBe('busy');
    expect(h.codes()).toEqual(Array(5).fill('worker_spawn_failed'));
  });

  it('answers the pages waiting behind the fifth failure as busy, and does not start a worker for each', async () => {
    const f = faults();
    const { p, broken } = breakable({ now: clock().now, onFault: f.report });
    broken(true);
    const answers = await Promise.all(Array.from({ length: 8 }, () => p.prepare('echo:x')));
    expect(answers.map(refusal)).toEqual([...Array(5).fill('worker_failed'), ...Array(3).fill('busy')]);
    expect(f.seen).toHaveLength(5);
  });

  it('has its own limit and cool-down to set', async () => {
    const c = clock();
    const { p, broken } = breakable({ now: c.now, failureLimit: 2, coolDownMs: 1000 });
    broken(true);
    await fail(p, 2);
    expect(refusal(await p.prepare('echo:x'))).toBe('busy');
    broken(false);
    c.set(1000);
    expect(said(await p.prepare('echo:y'))).toMatch(/:y$/);
  });
});

describe('the worker is ended when nothing has been asked of it for a while, to give its memory back', () => {
  it('ends it after idleMs, and the next page starts another', async () => {
    const p = preparer({ idleMs: 150 });
    const first = pid(await p.prepare('echo:one'));
    expect(await goneWithin(first, 3000), `worker ${first} was not ended`).toBe(true);
    const second = await p.prepare('echo:two');
    expect(said(second)).toMatch(/:two$/);
    expect(pid(second)).not.toBe(first);
  });

  it('keeps it for pages that come sooner than that, whatever the pages add up to', async () => {
    const p = preparer({ idleMs: 600 });
    const first = pid(await p.prepare('echo:one'));
    for (let i = 0; i < 4; i++) {
      await sleep(250);
      expect(pid(await p.prepare(`echo:${i}`))).toBe(first);
    }
  });

  it('does not end a worker that is in the middle of a page', async () => {
    const p = preparer({ idleMs: 100 });
    const first = pid(await p.prepare('echo:one'));
    // A page that takes longer than idleMs: the worker is not idle while it has it.
    const page = await p.prepare('window:400');
    expect(refusal(page)).toBe('answered');
    expect(pid(await p.prepare('echo:two'))).toBe(first);
  });
});

describe('options that would not make a worker are refused when the pool is made', () => {
  // A Node process does not start with a heap limit this small, or one that is negative or not a number.
  it.each([0, 1, 2, 4, 15, -5, Number.NaN, Number.POSITIVE_INFINITY])('a heap limit of %s', (limit) => {
    expect(() => createHtmlPreparer({ maxOldGenerationSizeMb: limit })).toThrow(RangeError);
  });

  it.each([
    ['deadlineMs', 0],
    ['maxQueued', -1],
    ['maxQueuedChars', -1],
    ['busyWindowMs', 0],
    ['maxBusyMs', Number.NaN],
    ['idleMs', 0],
    ['failureLimit', 0],
    ['coolDownMs', 0],
  ] as const)('%s of %s', (name, value) => {
    expect(() => createHtmlPreparer({ [name]: value })).toThrow(new RegExp(`${name} must be a number`));
  });

  it('takes the least that works, and the defaults', async () => {
    const small = preparer({ maxOldGenerationSizeMb: 16 });
    expect(said(await small.prepare('echo:ok'))).toMatch(/:ok$/);
    expect(() => createHtmlPreparer()).not.toThrow();
  });
});

describe('closing', () => {
  it('answers the pages waiting, and the one running, as failed, and ends the worker', async () => {
    const p = preparer({ deadlineMs: 60_000 });
    const worker = pid(await p.prepare('echo:who'));
    const running = p.prepare('spin:');
    const waiting = p.prepare('echo:a');
    const closed = p.close();
    expect(await running).toEqual({ ok: false, reason: 'worker_failed' });
    expect(await waiting).toEqual({ ok: false, reason: 'worker_failed' });
    await closed;
    // It is gone when close has returned, not only on its way.
    expect(alive(worker)).toBe(false);
    // Nothing is taken after it, and closing again is harmless.
    expect(await p.prepare('echo:late')).toEqual({ ok: false, reason: 'worker_failed' });
    await p.close();
  });

  it('is fine before any page has started a worker', async () => {
    await preparer().close();
  });

  it('is fine after the worker is already gone', async () => {
    const p = preparer({ idleMs: 100 });
    const worker = pid(await p.prepare('echo:one'));
    expect(await goneWithin(worker, 3000)).toBe(true);
    await p.close();
  });
});

describe("the real worker's part: what it makes of a page", () => {
  // `answerJob` is all there is to the worker but the lines that hand it a message and say that it is ready; the
  // process itself is exercised through the compiled package by prepare-pool-shapes.test.ts and by @ax/attachments' tests.
  const decode = (answer: ReturnType<typeof answerJob>): string => (answer.ok ? new TextDecoder().decode(answer.bytes) : '');

  it('answers with the page the transform makes, as UTF-8', () => {
    const html = '<!doctype html><title>t</title><p>héllo 日本語 😀 &amp; <b>x</b></p>';
    const answer = answerJob({ id: 7, html });
    const expected = prepareArtifactHtml(html);
    expect(answer.id).toBe(7);
    expect(answer.ok).toBe(true);
    expect(expected.ok && decode(answer)).toBe(expected.ok ? expected.html : '');
    expect(answer.ok && answer.bytes).toBeInstanceOf(Uint8Array);
  });

  it("gives the transform the worker's budget as an argument: 1.5 s, where anything else that calls it gets 500 ms", () => {
    // The only caller that runs the transform for longer than its short default is this process, which holds
    // nothing but pages. The number is pinned so that changing it is a choice.
    expect(WORKER_BUDGET_MS).toBe(1500);
    const spy = vi.mocked(prepareArtifactHtml);
    spy.mockClear();
    answerJob({ id: 9, html: '<p>x</p>' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('<p>x</p>', { budgetMs: WORKER_BUDGET_MS });
  });

  it("answers with the transform's refusal", () => {
    expect(answerJob({ id: 1, html: '<plaintext>x' })).toEqual({ id: 1, ok: false, reason: 'plaintext' });
    expect(answerJob({ id: 2, html: 'a\u0000b' })).toEqual({ id: 2, ok: false, reason: 'nul' });
  });

  it('refuses the page that ended the host (200 KiB of quotes, 80 times over) in the worker too, without making it', () => {
    expect(answerJob({ id: 3, html: escapeAmplification(4 * MiB, 3) })).toEqual({ id: 3, ok: false, reason: 'output_too_large' });
  });

  describe('whatever goes wrong with a page, the worker answers it', () => {
    // An exception that left the worker would end it, and the pool would call that a crash on this page: true, and slower, and with
    // a process started again. The transform does not throw, nor does encoding what it made, nor does the channel refuse a small
    // answer; if one does, it is an answer about this page.
    it('answers a page for which the transform throws as a refusal of that page (the parser threw), and does not throw', () => {
      vi.mocked(prepareArtifactHtml).mockImplementationOnce(() => {
        throw new Error('boom');
      });
      expect(answerJob({ id: 11, html: '<p>x</p>' })).toEqual({ id: 11, ok: false, reason: 'parse_error' });
    });

    it('answers a page the same way when encoding what the transform made throws', () => {
      const spy = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementationOnce(() => {
        throw new RangeError('Array buffer allocation failed');
      });
      try {
        expect(answerJob({ id: 12, html: '<p>x</p>' })).toEqual({ id: 12, ok: false, reason: 'parse_error' });
      } finally {
        spy.mockRestore();
      }
    });

    it('sends the answer, once, when all goes well', () => {
      const sent: WorkerAnswer[] = [];
      handleJob({ id: 13, html: '<p>x</p>' }, (answer) => void sent.push(answer), () => expect.unreachable('it did not give up'));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ id: 13, ok: true });
    });

    it('sends a refusal when the channel will not take the answer, which is small', () => {
      const sent: WorkerAnswer[] = [];
      let calls = 0;
      handleJob(
        { id: 14, html: '<p>x</p>' },
        (answer) => {
          if (++calls === 1) throw new Error('the answer was too big for the channel');
          sent.push(answer);
        },
        () => expect.unreachable('it did not give up'),
      );
      expect(sent).toEqual([{ id: 14, ok: false, reason: 'parse_error' }]);
    });

    it('gives up (the process ends) only when not even the refusal can be sent, and does not throw', () => {
      let gaveUp = 0;
      handleJob(
        { id: 15, html: '<p>x</p>' },
        () => {
          throw new Error('the channel is closed');
        },
        () => void (gaveUp += 1),
      );
      expect(gaveUp).toBe(1);
    });
  });

  describe('the bytes of a prepared page are counted where they are made', () => {
    // The transform's ceiling is on characters, and a character is up to three bytes of UTF-8: a page of 4 MiB with a
    // CJK attribute (3 bytes a character) on a formatting element that a following tag brings back 55 times came back as
    // 16.8 MB in 350 ms, the fourth review found, which is half of the 32 MiB the origin keeps and 16.8 MB to send.
    const cjkPage = (copies: number): string => {
      const page = `<div><b x='${'\u4e00'.repeat(100_000)}'></div>${'<div><span></div>'.repeat(copies)}`;
      // `</x>` is read and dropped, so it pads the page to 4 MiB without being in what comes back.
      const room = 4 * MiB - Buffer.byteLength(page);
      return '</x>'.repeat(Math.floor(room / 4)) + page;
    };

    it('refuses a page whose characters are within the ceiling and whose bytes are not', () => {
      const html = cjkPage(55);
      expect(Buffer.byteLength(html)).toBeLessThanOrEqual(4 * MiB);
      // As characters it is allowed: 5.5 million of 6.3.
      const made = prepareArtifactHtml(html, { budgetMs: 60_000 });
      expect(made.ok).toBe(true);
      expect(made.ok && made.html.length).toBeLessThan(6 * MiB);
      expect(made.ok && Buffer.byteLength(made.html)).toBeGreaterThan(MAX_PREPARED_BYTES);
      // As bytes it is not, and the worker says so instead of sending 16 MB. (Said in two small expectations: a failure of
      // one that compared the whole answer would try to print a diff of 16 million numbers.)
      const answer = answerJob({ id: 4, html });
      expect(answer.id).toBe(4);
      expect(answer.ok ? `${answer.bytes.byteLength} bytes were made` : answer.reason).toBe('output_too_large');
    });

    it('serves a page of the same characters that comes back at the size it went in', () => {
      const html = `<!doctype html><p>${'\u4e00'.repeat(1_200_000)}</p>`; // 3.6 MB
      const answer = answerJob({ id: 5, html });
      expect(answer.ok).toBe(true);
      expect(answer.ok && answer.bytes.byteLength).toBeGreaterThan(3 * MiB);
      expect(answer.ok && answer.bytes.byteLength).toBeLessThan(MAX_PREPARED_BYTES);
    });

    it('is twice the largest page there can be as input, so that no page that is only written out as it was comes near', () => {
      expect(MAX_PREPARED_BYTES).toBe(2 * 4 * MiB);
    });
  });

  it('does nothing when it is imported: it takes hold of no channel unless it is started as the worker', () => {
    // This test file is run in a process that may have a channel of its own (the test runner's). The worker's lines
    // must not be what answers on it.
    expect(process.argv[2]).not.toBe(WORKER_ARG);
    expect(process.listeners('message').some((l) => String(l).includes('answerJob'))).toBe(false);
  });
});
