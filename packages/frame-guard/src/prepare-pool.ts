import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GUARD_MARKER, isPrepareRefusal, MAX_PREPARED_BYTES, type PrepareRefusal } from './prepare-html.js';
import { WORKER_ARG } from './prepare-worker.js';

// `prepareArtifactHtml` is synchronous and its limits are measured, not proven: it runs a
// third-party parser over bytes an agent chose, and a shape nobody has found can hold the
// thread, or need more memory than anyone thought of. The host serves every user from one
// thread and one process, so that is not where it should run. This runs it in a PROCESS of
// its own, one page at a time, and answers a page the worker could not handle with a
// refusal instead of an error:
//
//   - the worker has a heap limit that V8 enforces on it (`--max-old-space-size`, with the
//     young generation pinned so that the limit is the same on every machine). A page that
//     needs more ends the worker: V8 aborts the process with "Reached heap limit" and the
//     pool answers `worker_oom`. Nothing else is touched by that. The container's memory
//     limit is another matter, because it is the host's too: under `memory.oom.group`
//     (Kubernetes sets it on cgroup v2) the kernel ends every process in the container when
//     it is met, whichever one was using the memory. So the heap is sized from the limit, a
//     share of it that leaves the host the rest (`oldGenerationFor`). (This used to be a thread. A thread
//     that runs out of memory takes its whole process with it when the need is far over the
//     limit, which it did at 384 MB for a page of 4 MiB that the transform wrote out at three
//     times its length, and the plausible page that needs most, text inside a table, which
//     parse5 holds a token at a time, needs 352 to 368 MB of the 384 given here: a limit is a
//     thing a page can meet, and what happens then must not depend on how far over it went.)
//     The worker says what limit it really has when it starts, and one that is not the
//     limit asked for is not used;
//   - it has a wall-clock deadline, so a page that holds the worker where nothing in the
//     transform can look at a clock is ended from outside (`worker_timeout`);
//   - it is handed nothing of the host's: an empty environment, none of its flags, no
//     standard streams, and only the page over the channel. (Handed: it is the same user,
//     and a worker that has been taken over can read the host's environment from /proc.)
//     It is ended when the host lets go of the channel, and when nothing has been asked of
//     it for a while, which gives its memory back (a worker that has prepared a heavy page
//     holds 250 to 380 MB until it ends, measured);
//   - pages wait in a line bounded by how many there are and how much text they hold (each
//     is a string the caller has made and the worker has not read yet), and a page that
//     finds it full, or that arrives when the worker has been busy for half of the last ten
//     seconds, is turned away at once (`busy`) instead of queueing behind work nobody is
//     waiting for.
//
// A worker that was ended is started again for the next page. The transform's own limits (and
// its CPU-time budget) still apply inside the worker: they are what refuses most hostile pages
// in milliseconds, and the process is what is left when they don't.
//
// What this holds against is a worker that FAILS: runs out of its heap, hangs, crashes, or says
// something wrong. It is not a sandbox and does not hold against one that has been TAKEN OVER:
// same user, same pod, and a channel whose reader is Node's, which a worker can feed bytes that
// end the host (prepare-worker.ts has the particulars, and what would close it).

/** Why a page was not prepared, beyond the reasons the transform itself gives (`PrepareRefusal`). */
export type PoolRefusal =
  /** The worker did not answer in time and was ended. (The transform's budget is CPU time; this is the wall clock.) */
  | 'worker_timeout'
  /** The worker ran out of memory, or was killed for it, and is gone. */
  | 'worker_oom'
  /**
   * The worker ended while it had the page, and not by running out of memory or the deadline: a crash (a signal that is
   * not one of memory, an exit it chose, an exception it did not catch, something said that is not an answer). The page's, as
   * far as anyone can tell: a page can crash a parser, and the same bytes will again. It does not count toward
   * `failureLimit`, which is for what no page can cause.
   */
  | 'worker_crashed'
  /** The worker could not start, or was not there for the page, for a reason the page does not explain. Not the page's fault. */
  | 'worker_failed'
  /** Not tried: too many pages are waiting, or the worker has been busy for too much of the last few seconds. Not the page's fault. */
  | 'busy';

/** A page prepared, as UTF-8 bytes, or the code for why it was not. */
export type PreparedPage = { ok: true; bytes: Uint8Array } | { ok: false; reason: PrepareRefusal | PoolRefusal };

export interface HtmlPreparer {
  /** Never rejects. The page is text decoded as a browser decodes it; see `prepareArtifactHtml`. */
  prepare(html: string): Promise<PreparedPage>;
  /** Ends the worker. Pages still waiting are answered `worker_failed`. */
  close(): Promise<void>;
}

export interface HtmlPreparerOptions {
  /** The worker's entry. Default: `prepare-worker.js` next to this file, which exists in the compiled package. */
  workerUrl?: URL;
  /**
   * Heap the worker may use before it is ended, in MB: 16 or more. Default 384. The most it is given: in a container with a
   * memory limit it is given less when this would not fit beside the host (see `containerMemoryBytes`).
   */
  maxOldGenerationSizeMb?: number;
  /**
   * The memory limit of the container the host is in, in bytes, or undefined if there is none. Read each time a worker is
   * started, and the worker's heap is sized from it (`oldGenerationFor`): a worker is a process of the same container, and a
   * limit on the container's memory is not the worker's alone to meet, because under `memory.oom.group` (which Kubernetes sets on
   * cgroup v2) the kernel ends every process in the container, the host with it. Default: what Node reads of the container's
   * cgroup (`readContainerMemoryLimit`). For tests.
   */
  containerMemoryBytes?: () => number | undefined;
  /** Milliseconds, on the wall clock, a page may take, starting the worker included, before the worker is ended. Default 6000. */
  deadlineMs?: number;
  /** Pages that may wait behind the one being prepared; the next is turned away as busy. Default 32. */
  maxQueued?: number;
  /**
   * Characters of page the worker may be holding and waiting on at once, the one being prepared and the ones
   * behind it; a page that would take it past that is turned away as busy (unless nothing else is waiting).
   * Default 32 Mi: eight 4 MiB pages.
   */
  maxQueuedChars?: number;
  /** The window, in milliseconds, over which the worker's busy time is added up. Default 10000. */
  busyWindowMs?: number;
  /** Milliseconds of work the worker may do in a window before new pages are turned away as busy. Default 5000. */
  maxBusyMs?: number;
  /**
   * Milliseconds with no page to prepare after which the worker is ended, so that the memory it holds is given
   * back; the next page starts another (about 60 ms). Default 20000.
   */
  idleMs?: number;
  /**
   * Workers in a row that failed in a way NO PAGE CAN CAUSE (a process that could not be made, one that ended before it said
   * it was ready, one that has not the heap limit it was asked for) after which pages are turned away as busy for
   * `coolDownMs`, instead of starting another worker for each. What a page can do (run the worker out of memory, hold it,
   * crash it) is that page's, remembered with it, and does not count: or a few pages that crash the parser would turn
   * every other page away. One answer from a worker puts the count back to none. Default 5.
   */
  failureLimit?: number;
  /** Milliseconds, on the clock of the busy window, pages are turned away for after `failureLimit` failures; then one is tried. Default 30000. */
  coolDownMs?: number;
  /**
   * Told when the worker fails in a way the page does not explain (a crash, a worker that cannot start, one that
   * does not have the heap limit it was asked for, one that says something that is not an answer). The fault is
   * an Error whose `code` says which, in the form of an identifier. Never given a page.
   */
  onFault?: (fault: unknown) => void;
  /** For tests: the clock the busy window is kept on, in milliseconds. */
  now?: () => number;
  /** For tests: options the worker's Node is started with, after the pool's own (a TypeScript loader, to run the worker from source). Default none. */
  execArgv?: string[];
}

const DEFAULT_WORKER_URL = new URL('./prepare-worker.js', import.meta.url);
/**
 * What the transform may use of heap before the worker is ended. The heaviest pages that are plausible (4 MiB
 * in one token: a script, a data URI, a tag with 200 long attributes) need between 144 and 160 MB, nearly all
 * of it the joins parse5 makes while it builds the token a character at a time (about 32 bytes a character).
 * Text inside a `<table>`, which parse5 holds a token at a time (56 bytes each), is the heaviest: 4 MiB of it
 * needs 352 to 368 MB, and is refused whichever way it goes (as out of memory under a smaller limit; at this one as too
 * slow, because the collector's work near the limit uses up the transform's CPU budget: measured, six times in six). A
 * tag whose name is 4 MiB would need more, and is refused as too long before it is read. 384 is 2.4 times the 160. It is
 * the most a worker is given: in a container with a memory limit it is given less when this would not fit beside
 * the host (`oldGenerationFor`).
 */
const DEFAULT_OLD_GENERATION_MB = 384;
/**
 * The least heap limit the pool will start a worker with: below this a Node process does not start at all.
 * A limit is a thing the code that makes the pool writes down, so a bad one is refused when the pool is
 * made and not with the first page.
 */
const MIN_OLD_GENERATION_MB = 16;
/**
 * The size of each half of the young generation, in MB, which the worker is told and not left to choose: V8
 * picks it from the memory the machine or the container has (1 MB in a 512 MiB container, 16 in a 1 GiB one,
 * 64 on a laptop), and with it the heap limit it reports, `old + 3 x this`. Pinned, the limit is the same
 * everywhere, so what a page needs is too and the check that the worker has the limit asked for is exact.
 */
const SEMI_SPACE_MB = 16;
/**
 * V8 does its garbage collection and part of its compiling on helper threads, which exist before the worker can lower its own
 * priority, and on Linux a nice value belongs to one thread: measured (Node 24, Linux), 29 to 50% of a worker's CPU on pages
 * of 190 KB to 4 MiB ran on four helper threads at the host's priority, where its request to wait for the host's CPU did not
 * reach. `--single-threaded` keeps all of V8's work on the one thread that was lowered (0% elsewhere; prepare-pool-shapes.test.ts
 * looks). It costs nothing on a page of a few hundred bytes (1 ms), 10 ms on one of 190 KB (40 to 45, then 50), and 4 to
 * 30% of the time of the pages of 4 MiB (0.40 to 0.55 s, then 0.51 to 0.58 s); the CPU spent in all is lower. The transform's
 * budget is this thread's CPU time, so the collector's work now counts toward it, which beside it did not. The heap limit
 * the worker reports is the same.
 */
export const WORKER_V8_FLAGS: readonly string[] = ['--single-threaded'];
const YOUNG_GENERATION_MB = 3 * SEMI_SPACE_MB;
/** How far the heap limit a worker reports may be from `old + young`: V8 rounds to pages. */
const LIMIT_TOLERANCE_MB = 2;
const MiB = 1024 * 1024;
/**
 * How much of the container's memory limit a worker may take, resident, in all. The container is the host's and the worker's
 * together, and a page can fill the worker's heap, so the heap is sized to leave the host the rest: 70% of the limit is the
 * host's. At the 2 GiB the production values give the host that is 614 MB for the worker, and it took 475 at most, measured.
 */
const WORKER_SHARE_OF_CONTAINER_PERCENT = 30;
/**
 * What a worker is resident beyond its heap limit: V8's own and the runtime's (a worker with nothing to do holds 56 MB), the page's
 * bytes, the answer's, and the copy of it that the channel makes. Measured with a page that fills the heap (ending the worker) and
 * with ones that are served, at limits of 176 to 432 MB (old 128 to 384): 35 to 55 MB over the limit. 64 leaves room for an answer of
 * 8 MiB.
 */
const WORKER_OVERHEAD_MB = 64;
/** A container limit past this is not a limit (Node answers 2^64, or 2^63 less a page, where the cgroup says "max"). */
const MAX_PLAUSIBLE_LIMIT_BYTES = 2 ** 50;

/**
 * The memory limit of the container this process is in, in bytes: what Node reads of its cgroup (v2 `memory.max`, or v1
 * `memory.limit_in_bytes`, at the path `/proc/self/cgroup` names), or undefined where there is none or Node cannot tell (it
 * answers 0 where it does not know, and a number past any machine where the file says "max": neither is a limit).
 */
export function readContainerMemoryLimit(): number | undefined {
  try {
    const bytes = process.constrainedMemory();
    return Number.isFinite(bytes) && bytes > 0 && bytes < MAX_PLAUSIBLE_LIMIT_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The old generation to give a worker, in MB: the one asked for, or less when the container's memory limit cannot hold it beside
 * the host. A V8 heap abort ends the worker alone, but a container limit does not: under `memory.oom.group` (Kubernetes sets it on
 * cgroup v2, since 1.28) the kernel ends EVERY process in the container when the limit is met, and `oom_score_adj` only chooses who
 * is first. Measured: a container of 600 MiB, the host holding 300 MB, a page of table text: the container exits 137, host and
 * all, with the default heap and with a larger one. So the worker may take a share of the limit (`WORKER_SHARE_OF_CONTAINER_PERCENT`),
 * and its heap is what that leaves after the young generation and the overhead; a page that needs more than that is refused as
 * `worker_oom`, which is an answer, and not the end of the container. At a 1 GiB limit that is 195 MB (every heavy page measured but
 * the table text is served with 192); at 2 GiB it is the 384 asked for. `budgetMet` is false where even the least a worker can be
 * given (`MIN_OLD_GENERATION_MB`) takes more than the share, and the host is on its own.
 */
export function oldGenerationFor(requestedMb: number, limitBytes: number | undefined): { oldMb: number; budgetMet: boolean } {
  if (limitBytes === undefined) return { oldMb: requestedMb, budgetMet: true };
  const fits = Math.floor(((limitBytes / MiB) * WORKER_SHARE_OF_CONTAINER_PERCENT) / 100) - YOUNG_GENERATION_MB - WORKER_OVERHEAD_MB;
  return { oldMb: Math.max(MIN_OLD_GENERATION_MB, Math.min(requestedMb, fits)), budgetMet: fits >= MIN_OLD_GENERATION_MB };
}
const DEFAULT_DEADLINE_MS = 6000;
/** A burst a person can make (the browser tests load sixteen pages at once) fits; the line is for the rest. */
const DEFAULT_MAX_QUEUED = 32;
const DEFAULT_MAX_QUEUED_CHARS = 32 * 1024 * 1024;
const DEFAULT_BUSY_WINDOW_MS = 10_000;
const DEFAULT_MAX_BUSY_MS = 5000;
const DEFAULT_IDLE_MS = 20_000;
/**
 * A machine that cannot make a worker (no memory to fork, a file that is gone, a flag Node does not take, a heap limit it does
 * not give) fails to start one for every page, and `worker_failed` is not remembered with a page, so without this every view
 * would fork a process (35 ms of CPU) and write an error to the log, for as long as it lasted. Only a failure that no page can
 * cause counts, because the count is global: a page that crashes the worker is that page's refusal (`worker_crashed`), and if
 * crashes counted, a few such pages would turn every tenant's pages away. Five in a row is not a page: one answer in between
 * ends the count.
 */
const DEFAULT_FAILURE_LIMIT = 5;
const DEFAULT_COOL_DOWN_MS = 30_000;
/** How long `close` waits for the worker to be gone after it has been killed, which takes milliseconds. */
const CLOSE_WAIT_MS = 2000;

/** The most busy periods remembered, however short: a window cannot grow without bound. */
const MAX_REMEMBERED = 1024;

interface Job {
  html: string;
  resolve: (page: PreparedPage) => void;
}

interface Running {
  job: Job;
  id: number;
  startedAt: number;
  timer: NodeJS.Timeout;
  /** Whether the page has been handed to the worker, which has to have said it is ready first. */
  sent: boolean;
}

/** A number option that must be usable as it is. */
function atLeast(name: string, value: number, min: number): number {
  if (!Number.isFinite(value) || value < min) {
    throw new RangeError(`@ax/frame-guard: ${name} must be a number of at least ${min} (got ${String(value)})`);
  }
  return value;
}

function refused(reason: PrepareRefusal | PoolRefusal): PreparedPage {
  return { ok: false, reason };
}

/**
 * What `onFault` is given: an error with an identifier for a `code`, which is all a log line is to carry of
 * it (the code is the part of an error that is safe to write down; the message may say more, for a person).
 * The ones there are:
 *   worker_spawn_failed      the process could not be made (counts toward the failure limit)
 *   worker_send_failed       the page could not be sent to a worker that had said it was ready (the page is
 *                            answered `worker_failed`: it was not delivered)
 *   worker_start_exit_<n>    it ended with exit code <n> before it said it was ready (a bad flag is 9, a
 *                            module it could not load is 1); counts toward the failure limit
 *   worker_start_signal_<S>  it was ended by signal <S> before it said it was ready; counts too
 *   worker_exit_<n>          it ended with exit code <n> while it had a page (answered `worker_crashed`), or
 *                            stopped being there with none
 *   worker_signal_<S>        it was ended by signal <S> that is not one of memory (a crash: the same)
 *   worker_aborted           it aborted (SIGABRT, or exit code 134), which V8 does at its heap limit; the page is
 *                            answered `worker_oom`. The worker's streams are ignored, so this is the only trace
 *   worker_killed            it was killed from outside, which is the kernel running out of memory where it chooses
 *                            the worker alone (where the container's limit ends every process in it, the host goes
 *                            too, and nothing is told; see `oldGenerationFor`); the page is answered `worker_oom`
 *   worker_limit_mismatch    its heap limit is not the one it was asked for (counts toward the failure limit)
 *   worker_bad_ready         the first thing it said was not what a worker says when it starts (counts too)
 *   worker_bad_message       it said something that is not an answer to the page it had (`worker_crashed`)
 *   worker_bad_answer        it answered ok, with bytes this transform cannot have made: more than a page is let be, or
 *                            without the guard in them (`worker_crashed`)
 *   worker_budget_too_small  the container's memory limit leaves the worker less than the least heap it can be started
 *                            with: it is given that least, which is more than its share, and the host is at risk (told
 *                            once; the worker still runs)
 */
class PoolFault extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PoolFault';
  }
}

/** The guard's marker as the bytes a worker answers in. */
const GUARD_MARKER_BYTES = Buffer.from(GUARD_MARKER, 'utf8');

/** Whether the guard is in a page, by a search of its bytes (a view, not a copy; found in the first few kilobytes of a real one). */
function carriesGuard(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(GUARD_MARKER_BYTES);
}

/**
 * Reads a worker's answer: the page, or the fault if it is not exactly one of the two answers it sends (a worker that is not
 * working), or null for a message that is not for this page. What is checked of an `ok` answer is what the transform
 * guarantees of what it makes: no more than a page is let be (the worker refuses a result over it too), and the guard
 * in it. That is a check that this is the worker's work, which stops a worker that is wrong from being served. It does
 * not stop one that has been taken over: it can write the guard, and anything else.
 */
function readAnswer(message: unknown, id: number): PreparedPage | PoolFault | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as { id?: unknown; ok?: unknown; bytes?: unknown; reason?: unknown };
  if (m.id !== id) return null;
  if (m.ok === true && m.bytes instanceof Uint8Array) {
    if (m.bytes.byteLength > MAX_PREPARED_BYTES) {
      return new PoolFault('worker_bad_answer', `the prepare worker answered with ${m.bytes.byteLength} bytes, more than the ${MAX_PREPARED_BYTES} a page is let be`);
    }
    if (!carriesGuard(m.bytes)) return new PoolFault('worker_bad_answer', 'the prepare worker answered with a page that has no guard in it');
    return { ok: true, bytes: m.bytes };
  }
  if (m.ok === false && isPrepareRefusal(m.reason)) return refused(m.reason);
  return new PoolFault('worker_bad_message', 'the prepare worker sent a message that is not an answer');
}

/** The heap limit, in MB, in a worker's first message, if that is what it is. */
function readReady(message: unknown): number | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as { ready?: unknown; heapLimitMb?: unknown };
  if (m.ready !== true || typeof m.heapLimitMb !== 'number' || !Number.isFinite(m.heapLimitMb)) return null;
  return m.heapLimitMb;
}

interface Worker {
  process: ChildProcess;
  /** Whether it has said that it is ready, and has the heap limit it was asked for. */
  ready: boolean;
  /** The heap limit, in MB, that it was started with and has to say it has: its old generation and the young one. */
  expectedLimitMb: number;
}

class WorkerPreparer implements HtmlPreparer {
  private worker: Worker | null = null;
  /** Which worker is the current one: events from an older one (ended on purpose, or ending late) are ignored. */
  private generation = 0;
  private running: Running | null = null;
  private readonly waiting: Job[] = [];
  private nextId = 1;
  private closed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Workers that failed in a row, and until when (on the busy window's clock) pages are turned away because of it. */
  private failures = 0;
  private coolUntil = Number.NEGATIVE_INFINITY;
  /** When each finished page ended and how long it kept the worker, newest last, for the busy window. */
  private readonly spent: Array<{ endedAt: number; ms: number }> = [];

  private readonly entry: string;
  private readonly oldGenerationMb: number;
  private readonly deadlineMs: number;
  private readonly maxQueued: number;
  private readonly maxQueuedChars: number;
  private readonly busyWindowMs: number;
  private readonly maxBusyMs: number;
  private readonly idleMs: number;
  private readonly failureLimit: number;
  private readonly coolDownMs: number;
  private readonly now: () => number;
  private readonly execArgv: string[];
  private readonly containerMemoryBytes: () => number | undefined;
  private readonly onFault: (fault: unknown) => void;
  /** Whether the host has been told that the container leaves the worker less than the least it can be given. */
  private toldBudgetTooSmall = false;

  constructor(options: HtmlPreparerOptions) {
    this.entry = fileURLToPath(options.workerUrl ?? DEFAULT_WORKER_URL);
    this.oldGenerationMb = atLeast('maxOldGenerationSizeMb', options.maxOldGenerationSizeMb ?? DEFAULT_OLD_GENERATION_MB, MIN_OLD_GENERATION_MB);
    this.deadlineMs = atLeast('deadlineMs', options.deadlineMs ?? DEFAULT_DEADLINE_MS, 1);
    this.maxQueued = atLeast('maxQueued', options.maxQueued ?? DEFAULT_MAX_QUEUED, 0);
    this.maxQueuedChars = atLeast('maxQueuedChars', options.maxQueuedChars ?? DEFAULT_MAX_QUEUED_CHARS, 0);
    this.busyWindowMs = atLeast('busyWindowMs', options.busyWindowMs ?? DEFAULT_BUSY_WINDOW_MS, 1);
    this.maxBusyMs = atLeast('maxBusyMs', options.maxBusyMs ?? DEFAULT_MAX_BUSY_MS, 0);
    this.idleMs = atLeast('idleMs', options.idleMs ?? DEFAULT_IDLE_MS, 1);
    this.failureLimit = atLeast('failureLimit', options.failureLimit ?? DEFAULT_FAILURE_LIMIT, 1);
    this.coolDownMs = atLeast('coolDownMs', options.coolDownMs ?? DEFAULT_COOL_DOWN_MS, 1);
    this.now = options.now ?? (() => performance.now());
    this.execArgv = options.execArgv ?? [];
    this.containerMemoryBytes = options.containerMemoryBytes ?? readContainerMemoryLimit;
    this.onFault = options.onFault ?? (() => undefined);
  }

  prepare(html: string): Promise<PreparedPage> {
    if (this.closed) return Promise.resolve(refused('worker_failed'));
    const inFlight = this.waiting.length + (this.running === null ? 0 : 1);
    if (inFlight > this.maxQueued || this.busyTime() >= this.maxBusyMs || (inFlight > 0 && this.heldChars() + html.length > this.maxQueuedChars)) {
      return Promise.resolve(refused('busy'));
    }
    return new Promise((resolve) => {
      this.waiting.push({ html, resolve });
      this.next();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.waiting.splice(0)) job.resolve(refused('worker_failed'));
    const running = this.running;
    this.running = null;
    if (running !== null) {
      clearTimeout(running.timer);
      running.job.resolve(refused('worker_failed'));
    }
    await this.end();
  }

  /** The container's memory limit, if it has one: a reader that throws, or answers what is not a limit, is no limit. */
  private limitOrNone(): number | undefined {
    try {
      const bytes = this.containerMemoryBytes();
      return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 && bytes < MAX_PLAUSIBLE_LIMIT_BYTES ? bytes : undefined;
    } catch {
      return undefined;
    }
  }

  /** Characters of page the worker has been given and has not finished: the one it is on, and the ones waiting. */
  private heldChars(): number {
    let total = this.running === null ? 0 : this.running.job.html.length;
    for (const job of this.waiting) total += job.html.length;
    return total;
  }

  /** Whether workers have failed too often in a row for another to be tried yet. */
  private cooling(): boolean {
    return this.now() < this.coolUntil;
  }

  /** A worker failed in a way that is not a page's: the count goes up, and at the limit pages are turned away for a while. */
  private failed(): void {
    this.failures += 1;
    if (this.failures >= this.failureLimit) this.coolUntil = this.now() + this.coolDownMs;
  }

  /** How long the worker has been busy in the window: the pages it finished, and the one it is on. */
  private busyTime(): number {
    const t = this.now();
    while (this.spent.length > 0 && this.spent[0]!.endedAt < t - this.busyWindowMs) this.spent.shift();
    let total = 0;
    for (const s of this.spent) total += s.ms;
    if (this.running !== null) total += t - this.running.startedAt;
    return total;
  }

  private note(startedAt: number): void {
    const t = this.now();
    this.spent.push({ endedAt: t, ms: t - startedAt });
    if (this.spent.length > MAX_REMEMBERED) this.spent.shift();
  }

  /** Takes the next waiting page, starts a worker for it if there is none, and hands it over as soon as the worker is ready. */
  private next(): void {
    if (this.running !== null) return;
    const job = this.waiting.shift();
    if (job === undefined) return;
    if (this.cooling()) {
      // Workers failed five times in a row, perhaps while this page waited: no more are made for the pages behind.
      job.resolve(refused('busy'));
      this.next();
      return;
    }
    const id = this.nextId++;
    try {
      this.worker ??= this.start();
    } catch (err) {
      this.onFault(new PoolFault('worker_spawn_failed', `the prepare worker could not be started: ${describe(err)}`));
      this.failed();
      job.resolve(refused('worker_failed'));
      this.next();
      return;
    }
    const generation = this.generation;
    this.running = {
      job,
      id,
      startedAt: this.now(),
      sent: false,
      // Not unref'd: while a page is being prepared the process has something to wait for.
      timer: setTimeout(() => this.timedOut(generation, id), this.deadlineMs),
    };
    if (this.worker.ready) this.send(this.worker, this.running);
  }

  /** Hands the page to the worker, which is ready for it. */
  private send(worker: Worker, running: Running): void {
    running.sent = true;
    const generation = this.generation;
    try {
      // `html` is the only thing the worker is told: no environment, no option, no path.
      worker.process.send({ id: running.id, html: running.job.html }, (err) => {
        if (err !== null) this.ended(generation, new PoolFault('worker_send_failed', `the page could not be sent to the prepare worker: ${describe(err)}`), 'worker_failed', false);
      });
    } catch (err) {
      this.ended(generation, new PoolFault('worker_send_failed', `the page could not be sent to the prepare worker: ${describe(err)}`), 'worker_failed', false);
    }
  }

  private start(): Worker {
    const generation = ++this.generation;
    // The container's limit is read for each worker (it may be changed while the host runs), and what it allows is what the worker is
    // told and what it has to say it has.
    const { oldMb, budgetMet } = oldGenerationFor(this.oldGenerationMb, this.limitOrNone());
    if (!budgetMet && !this.toldBudgetTooSmall) {
      this.toldBudgetTooSmall = true;
      this.onFault(
        new PoolFault(
          'worker_budget_too_small',
          `the container's memory limit leaves the prepare worker less than the ${MIN_OLD_GENERATION_MB} MB of heap it can least be given: it is given that, which is more than its share`,
        ),
      );
    }
    const child = fork(this.entry, [WORKER_ARG], {
      // The pool's flags first, so that the limit asked for is the one given; then the caller's (for tests). None of
      // this process's own flags are passed on, whatever it was started with.
      execArgv: [`--max-old-space-size=${oldMb}`, `--max-semi-space-size=${SEMI_SPACE_MB}`, ...WORKER_V8_FLAGS, ...this.execArgv],
      // No environment is handed to it (a NODE_OPTIONS of the host's would otherwise change the limits, and the host's secrets are
      // not the worker's to be given). That is what is handed, not what is out of reach: see the end of the header.
      env: {},
      // No standard streams, and the one channel it is spoken to over. `advanced` carries the page's bytes as bytes.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
    });
    const worker: Worker = { process: child, ready: false, expectedLimitMb: oldMb + YOUNG_GENERATION_MB };
    child.on('message', (message: unknown) => this.heard(generation, worker, message));
    // 'error' is the process that could not be made, or told to end, or sent to. It must have a listener or it throws.
    child.on('error', (err: Error) => this.ended(generation, new PoolFault('worker_spawn_failed', `the prepare worker failed: ${describe(err)}`), 'worker_failed', !worker.ready));
    child.on('exit', (code, signal) => this.exited(generation, worker, code, signal));
    // After the listeners, not before: a 'message' listener takes hold of the channel again (measured with threads: a
    // worker unref-ed first and given its listeners after kept an idle process from ever ending). While a page is
    // being prepared it is the deadline timer that keeps the process open, which is what is wanted.
    child.unref();
    child.channel?.unref();
    this.worker = worker;
    return worker;
  }

  private heard(generation: number, worker: Worker, message: unknown): void {
    if (generation !== this.generation) return;
    if (!worker.ready) {
      this.becameReady(generation, worker, message);
      return;
    }
    const running = this.running;
    if (running === null) return;
    const page = readAnswer(message, running.id);
    if (page === null) return;
    if (page instanceof PoolFault) {
      // Something other than an answer, to a page: it is not to be trusted again, and the page is the one that did it, as far
      // as anyone can tell (a crash is the same: `worker_crashed`, and not counted). Ended BEFORE the page is finished, as
      // finishing starts the next waiting page, which must go to a worker that is not the one just ended.
      this.onFault(page);
      this.discard();
      this.finish(running, refused('worker_crashed'));
      return;
    }
    // An answer, of either kind: the worker did what it is for, whatever it thought of the page.
    this.failures = 0;
    this.finish(running, page);
  }

  /** The first thing a worker says: that it is ready, and with what heap limit. A worker that is not as asked is not used. */
  private becameReady(generation: number, worker: Worker, message: unknown): void {
    const limit = readReady(message);
    const expected = worker.expectedLimitMb;
    if (limit === null || Math.abs(limit - expected) > LIMIT_TOLERANCE_MB) {
      this.onFault(
        limit === null
          ? new PoolFault('worker_bad_ready', 'the prepare worker did not start by saying that it is ready')
          : new PoolFault('worker_limit_mismatch', `the prepare worker has a heap limit of ${limit.toFixed(0)} MB and was asked for ${expected} MB`),
      );
      this.failed();
      this.discard();
      const running = this.running;
      if (running !== null) this.finish(running, refused('worker_failed'));
      return;
    }
    worker.ready = true;
    const running = this.running;
    if (running !== null && !running.sent && generation === this.generation) this.send(worker, running);
  }

  /** The worker is gone: out of memory, a crash, or it exited. */
  private exited(generation: number, worker: Worker, code: number | null, signal: NodeJS.Signals | null): void {
    if (generation !== this.generation) return;
    const how = signal !== null ? `signal ${signal}` : `exit code ${String(code)}`;
    // Out of memory is what V8 does at its heap limit: it aborts the process. From outside, the kernel's out-of-memory
    // killer sends SIGKILL, and nothing else is going to. Either is what a page can do to it; the rest is the worker.
    if (worker.ready && (signal === 'SIGABRT' || (signal === null && code === 134))) {
      // The worker's standard streams are ignored, so V8's "Reached heap limit" is not anywhere: this code is. An abort is the
      // page's (out of memory) as far as anyone can tell, and not a fault of the worker's that is the host's to fix, but it is
      // said, because a worker that aborted for another reason would otherwise be a quiet refusal that is remembered.
      this.ended(generation, new PoolFault('worker_aborted', `the prepare worker aborted (${how}), which V8 does at its heap limit`), 'worker_oom');
    } else if (worker.ready && signal === 'SIGKILL') {
      this.ended(generation, new PoolFault('worker_killed', `the prepare worker was killed (${how}), which in a pod is the kernel running out of memory`), 'worker_oom');
    } else if (!worker.ready) {
      // Before it said it was ready no page had been sent it: this is the machine's, and the only kind that counts.
      const code_ = signal !== null ? `worker_start_signal_${signal}` : `worker_start_exit_${String(code)}`;
      this.ended(generation, new PoolFault(code_, `the prepare worker ended (${how}) before it said it was ready`), 'worker_failed', true);
    } else {
      // With a page in hand (it is sent as soon as the worker is ready) a crash is that page's: the same bytes will do it again,
      // and it is answered and remembered like any refusal of a page, and does not count toward the failure limit. With none,
      // nobody is waiting for the answer.
      const code_ = signal !== null ? `worker_signal_${signal}` : `worker_exit_${String(code)}`;
      this.ended(generation, new PoolFault(code_, `the prepare worker ended (${how})`), this.running !== null ? 'worker_crashed' : 'worker_failed');
    }
  }

  /** The worker ended by itself: out of memory, a crash, or it exited; or a message to it could not be sent. */
  private ended(generation: number, fault: PoolFault | null, reason: PoolRefusal, counts = false): void {
    if (generation !== this.generation) return;
    this.discard();
    if (fault !== null) this.onFault(fault);
    if (counts) this.failed();
    const running = this.running;
    if (running !== null) this.finish(running, refused(reason));
  }

  /** A page took longer than the deadline: the worker is ended from outside. */
  private timedOut(generation: number, id: number): void {
    const running = this.running;
    if (generation !== this.generation || running === null || running.id !== id) return;
    this.discard();
    this.finish(running, refused('worker_timeout'));
  }

  /** Ends the current worker and forgets it: the next page starts a new one. */
  private discard(): void {
    const worker = this.worker;
    this.worker = null;
    this.generation++;
    if (worker !== null) this.kill(worker);
  }

  private kill(worker: Worker): void {
    try {
      worker.process.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  /** Ends the worker and waits until it is gone. */
  private async end(): Promise<void> {
    this.stopIdleTimer();
    const worker = this.worker;
    this.worker = null;
    this.generation++;
    if (worker === null) return;
    const child = worker.process;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const giveUp = setTimeout(resolve, CLOSE_WAIT_MS);
      child.once('exit', () => {
        clearTimeout(giveUp);
        resolve();
      });
      this.kill(worker);
    });
  }

  private finish(running: Running, page: PreparedPage): void {
    clearTimeout(running.timer);
    this.running = null;
    this.note(running.startedAt);
    running.job.resolve(page);
    this.next();
    // Nothing to do, and a worker still there: it is ended if no page comes soon.
    if (this.running === null && this.worker !== null) this.startIdleTimer();
  }

  private startIdleTimer(): void {
    this.stopIdleTimer();
    const generation = this.generation;
    // Not a reason to keep the process open.
    this.idleTimer = setTimeout(() => this.wentIdle(generation), this.idleMs).unref();
  }

  private stopIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private wentIdle(generation: number): void {
    this.idleTimer = null;
    // (A timer set before a page came is for a worker that is not idle now: `running` says so, and this does nothing.)
    if (generation !== this.generation || this.running !== null) return;
    this.discard();
  }
}

/** What an error says, for a message a person reads. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A preparer that runs `prepareArtifactHtml` in a process of its own (see above). The process is started
 * with the first page, and again after any that ended it or when it has been idle for a while; close the
 * preparer when its owner goes away.
 */
export function createHtmlPreparer(options: HtmlPreparerOptions = {}): HtmlPreparer {
  return new WorkerPreparer(options);
}
