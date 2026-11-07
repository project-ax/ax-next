import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHtmlPreparer, prepareArtifactHtml, type HtmlPreparer, type HtmlPreparerOptions, type PreparedPage } from '../index.js';
import { answerJob, WORKER_BUDGET_MS } from '../prepare-worker.js';
import { escapeAmplification } from './hostile-pages.js';

// Watches the transform, so a test can see with what limits the worker's part calls it.
vi.mock('../prepare-html.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../prepare-html.js')>();
  return { ...real, prepareArtifactHtml: vi.fn(real.prepareArtifactHtml) };
});

// The pool runs the transform on a worker thread, and says what became of each page. Its machinery is
// tested here with stand-in workers (fixtures/pool-worker.mjs: the page says what the worker does), on real
// threads with real limits and a real deadline, so a worker that is ended, runs out of memory or crashes is
// the real thing. The real worker's own part (`answerJob`) is tested below, in this thread, and end to end
// where the package is used from its compiled form (@ax/attachments' content origin tests).

const WORKER = new URL('./fixtures/pool-worker.mjs', import.meta.url);
const MiB = 1024 * 1024;

const open: HtmlPreparer[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

function preparer(options: HtmlPreparerOptions = {}): HtmlPreparer {
  const p = createHtmlPreparer({ workerUrl: WORKER, ...options });
  open.push(p);
  return p;
}

/** What a page came to, as a string. */
function said(page: PreparedPage): string {
  return page.ok ? new TextDecoder().decode(page.bytes) : `refused:${page.reason}`;
}
/** The thread a stand-in worker ran on: its `echo` answers `thread:argument`. */
const thread = (page: PreparedPage): string => said(page).split(':')[0] ?? '';
const refusal = (page: PreparedPage): string => (page.ok ? 'answered' : page.reason);

/** Faults the pool reports, as codes (the worker's own errors carry them). */
function faults(): { seen: unknown[]; report: (fault: unknown) => void } {
  const seen: unknown[] = [];
  return { seen, report: (fault) => void seen.push(fault) };
}

describe('a page goes to the worker and comes back as bytes', () => {
  it('answers with what the worker made', async () => {
    const page = await preparer().prepare('echo:hello');
    expect(page.ok).toBe(true);
    expect(page.ok && page.bytes).toBeInstanceOf(Uint8Array);
    expect(said(page)).toMatch(/^\d+:hello$/);
  });

  it('does not keep the process alive once its pages are answered: an idle worker lets a process end', { timeout: 40_000 }, () => {
    // A worker that was not unref-ed would hold a command, a test run or a server that is shutting down open for good.
    const fixture = fileURLToPath(new URL('./fixtures/idle-pool.ts', import.meta.url));
    const child = spawnSync(process.execPath, ['--import', 'tsx', fixture], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(child.error, 'the child did not end by itself').toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('"ok":true');
  });

  it('keeps the one worker for the pages that follow', async () => {
    const p = preparer();
    const first = thread(await p.prepare('echo:1'));
    expect(thread(await p.prepare('echo:2'))).toBe(first);
    expect(thread(await p.prepare('echo:3'))).toBe(first);
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

  it('gives the worker nothing of this process: no environment, none of its flags', async () => {
    process.env.AX_POOL_TEST_SECRET = 'do-not-leak';
    try {
      expect(said(await preparer().prepare('env:'))).toBe('[] []');
    } finally {
      delete process.env.AX_POOL_TEST_SECRET;
    }
  });
});

describe('a worker that is held, out of memory, or gone', () => {
  it('ends a page that outstays the deadline, and the next page gets a new worker', async () => {
    const f = faults();
    const p = preparer({ deadlineMs: 150, onFault: f.report });
    const before = thread(await p.prepare('echo:before'));
    const started = performance.now();
    expect(await p.prepare('spin:')).toEqual({ ok: false, reason: 'worker_timeout' });
    // The deadline, not something that takes much longer than it.
    expect(performance.now() - started).toBeLessThan(1500);
    // The worker that was ended says it has gone while the pool is idle: that is what was done to it, not a fault.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(f.seen).toEqual([]);
    const after = await p.prepare('echo:after');
    expect(said(after)).toMatch(/:after$/);
    expect(thread(after)).not.toBe(before);
  });

  it('really ends the worker it gives up on: nothing is left spinning', async () => {
    // A worker that was "ended" but still runs would hold a core for good. This process's CPU time is the sum of
    // its threads', so a spinning one shows as most of a second of CPU in a second of waiting.
    const p = preparer({ deadlineMs: 100 });
    expect(await p.prepare('spin:')).toEqual({ ok: false, reason: 'worker_timeout' });
    const before = process.cpuUsage();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const used = process.cpuUsage(before);
    expect((used.user + used.system) / 1000).toBeLessThan(150);
  });

  it('answers a page that runs the worker out of memory as that, and the process, and the next page, are fine', async () => {
    const f = faults();
    const p = preparer({ maxOldGenerationSizeMb: 64, onFault: f.report });
    const before = thread(await p.prepare('echo:before'));
    expect(await p.prepare('oom:')).toEqual({ ok: false, reason: 'worker_oom' });
    const after = await p.prepare('echo:after');
    expect(thread(after)).not.toBe(before);
    // Running out of memory is what a page can do to it, not a fault of the worker's.
    expect(f.seen).toEqual([]);
  });

  it('answers a worker that throws as failed, tells onFault what it was, and starts another for the next page', async () => {
    const f = faults();
    const p = preparer({ onFault: f.report });
    const before = thread(await p.prepare('echo:before'));
    expect(await p.prepare('throw:')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]).toBeInstanceOf(Error);
    expect((f.seen[0] as Error).message).toBe('the worker broke');
    expect(thread(await p.prepare('echo:after'))).not.toBe(before);
  });

  it('answers a worker that exits as failed, and tells onFault', async () => {
    const f = faults();
    const p = preparer({ onFault: f.report });
    expect(await p.prepare('exit:')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(f.seen).toHaveLength(1);
    expect(said(await p.prepare('echo:after'))).toMatch(/:after$/);
  });

  it('answers a worker that cannot be made at all (Node refuses its options) as failed, tells onFault, and does not throw', async () => {
    const f = faults();
    const p = preparer({ execArgv: ['--there-is-no-such-flag'], onFault: f.report });
    expect(await p.prepare('echo:1')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(await p.prepare('echo:2')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(f.seen.map((e) => (e as NodeJS.ErrnoException).code)).toEqual(['ERR_WORKER_INVALID_EXEC_ARGV', 'ERR_WORKER_INVALID_EXEC_ARGV']);
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
      { ok: false, reason: 'worker_failed' },
      { ok: false, reason: 'worker_failed' },
      { ok: false, reason: 'worker_failed' },
    ]);
    expect(f.seen).toHaveLength(3); // the worker that exited, and the two that could not be made
  });

  it('answers a worker that cannot start as failed (not a hang), and keeps answering', async () => {
    const f = faults();
    const p = preparer({ workerUrl: new URL('./fixtures/there-is-no-such-worker.mjs', import.meta.url), onFault: f.report });
    expect(await p.prepare('echo:1')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(await p.prepare('echo:2')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(f.seen).toHaveLength(2);
    expect((f.seen[0] as NodeJS.ErrnoException).code).toMatch(/MODULE_NOT_FOUND$/);
  });

  it('does not trust what is not an answer: a message with no id is ignored, one with no answer in it ends the worker', async () => {
    const f = faults();
    const p = preparer({ onFault: f.report });
    const before = thread(await p.prepare('echo:before'));
    expect(await p.prepare('nonsense:')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(f.seen).toHaveLength(1);
    expect(thread(await p.prepare('echo:after'))).not.toBe(before);
  });

  it('does not take a refusal code it does not know: that is a worker that is not working', async () => {
    const f = faults();
    const p = preparer({ onFault: f.report });
    expect(await p.prepare('refuse:made_up_code')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(f.seen).toHaveLength(1);
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

describe('options that would end the process are refused when the pool is made', () => {
  // Node ends the whole process, not the worker, for a heap limit of 0, 1, 2 bytes... of MB, or a negative or non-numeric one (measured).
  it.each([0, 1, 2, 4, 15, -5, Number.NaN, Number.POSITIVE_INFINITY])('a heap limit of %s', (limit) => {
    expect(() => createHtmlPreparer({ maxOldGenerationSizeMb: limit })).toThrow(RangeError);
  });

  it.each([
    ['deadlineMs', 0],
    ['maxQueued', -1],
    ['maxQueuedChars', -1],
    ['busyWindowMs', 0],
    ['maxBusyMs', Number.NaN],
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
  it('answers the pages waiting, and the one running, as failed, and stops the worker', async () => {
    const p = preparer({ deadlineMs: 60_000 });
    const running = p.prepare('spin:');
    const waiting = p.prepare('echo:a');
    const closed = p.close();
    expect(await running).toEqual({ ok: false, reason: 'worker_failed' });
    expect(await waiting).toEqual({ ok: false, reason: 'worker_failed' });
    await closed;
    // Nothing is taken after it, and closing again is harmless.
    expect(await p.prepare('echo:late')).toEqual({ ok: false, reason: 'worker_failed' });
    await p.close();
  });

  it('is fine before any page has started a worker', async () => {
    await preparer().close();
  });
});

describe("the real worker's part: what it makes of a page", () => {
  // `answerJob` is all there is to the worker but the line that hands it a message; the thread itself is
  // exercised through the compiled package by @ax/attachments' tests.
  const decode = (answer: ReturnType<typeof answerJob>['answer']): string => (answer.ok ? new TextDecoder().decode(answer.bytes) : '');

  it('answers with the page the transform makes, as UTF-8, and hands the buffer over whole', () => {
    const html = '<!doctype html><title>t</title><p>héllo 日本語 😀 &amp; <b>x</b></p>';
    const { answer, transfer } = answerJob({ id: 7, html });
    const expected = prepareArtifactHtml(html);
    expect(answer.id).toBe(7);
    expect(answer.ok).toBe(true);
    expect(expected.ok && decode(answer)).toBe(expected.ok ? expected.html : '');
    expect(answer.ok && transfer).toEqual([answer.bytes.buffer]);
    expect(answer.ok && answer.bytes.byteOffset).toBe(0);
    expect(answer.ok && answer.bytes.byteLength).toBe(answer.ok ? answer.bytes.buffer.byteLength : -1);
  });

  it('gives the transform the worker\'s budget as an argument: 1.5 s, where anything else that calls it gets 500 ms', () => {
    // The only caller that runs the transform for longer than its short default is this thread, which holds
    // nothing but pages. The number is pinned so that changing it is a choice.
    expect(WORKER_BUDGET_MS).toBe(1500);
    const spy = vi.mocked(prepareArtifactHtml);
    spy.mockClear();
    answerJob({ id: 9, html: '<p>x</p>' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('<p>x</p>', { budgetMs: WORKER_BUDGET_MS });
  });

  it("answers with the transform's refusal, and hands nothing over", () => {
    expect(answerJob({ id: 1, html: '<plaintext>x' })).toEqual({ answer: { id: 1, ok: false, reason: 'plaintext' }, transfer: [] });
    expect(answerJob({ id: 2, html: 'a\u0000b' }).answer).toEqual({ id: 2, ok: false, reason: 'nul' });
  });

  it('refuses the page that ended the host (200 KiB of quotes, 80 times over) in the worker too, without making it', () => {
    const { answer } = answerJob({ id: 3, html: escapeAmplification(4 * MiB, 3) });
    expect(answer).toEqual({ id: 3, ok: false, reason: 'output_too_large' });
  });
});
