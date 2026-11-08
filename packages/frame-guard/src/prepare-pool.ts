import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isPrepareRefusal, type PrepareRefusal } from './prepare-html.js';
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
//     pool answers `worker_oom`. Nothing else is touched. (This used to be a thread. A thread
//     that runs out of memory takes its whole process with it when the need is far over the
//     limit, which it did at 384 MB for a page of 4 MiB that the transform wrote out at three
//     times its length, and the pages that need most, such as text inside a table, which
//     parse5 holds a token at a time, need 352 to 368 MB of the 384 given here: a limit is a
//     thing a page can meet, and what happens then must not depend on how far over it went.)
//     The worker says what limit it really has when it starts, and one that is not the
//     limit asked for is not used;
//   - it has a wall-clock deadline, so a page that holds the worker where nothing in the
//     transform can look at a clock is ended from outside (`worker_timeout`);
//   - it is given nothing of the host's: an empty environment, none of its flags, no
//     standard streams, and only the page over the channel. It is ended when the host lets
//     go of the channel, and when nothing has been asked of it for a while, which gives its
//     memory back (a worker that has prepared a heavy page holds 300 MB or more until it
//     ends, measured);
//   - pages wait in a line bounded by how many there are and how much text they hold (each
//     is a string the caller has made and the worker has not read yet), and a page that
//     finds it full, or that arrives when the worker has been busy for half of the last ten
//     seconds, is turned away at once (`busy`) instead of queueing behind work nobody is
//     waiting for.
//
// A worker that was ended is started again for the next page. The transform's own limits (and
// its CPU-time budget) still apply inside the worker: they are what refuses most hostile pages
// in milliseconds, and the process is what is left when they don't. It is not a sandbox
// (same user, same files); see prepare-worker.ts.

/** Why a page was not prepared, beyond the reasons the transform itself gives (`PrepareRefusal`). */
export type PoolRefusal =
  /** The worker did not answer in time and was ended. (The transform's budget is CPU time; this is the wall clock.) */
  | 'worker_timeout'
  /** The worker ran out of memory, or was killed for it, and is gone. */
  | 'worker_oom'
  /** The worker could not start, or ended, for a reason the page does not explain. Not the page's fault. */
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
  /** Heap the worker may use before it is ended, in MB: 16 or more. Default 384. */
  maxOldGenerationSizeMb?: number;
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
 * The heaviest there are (4 MiB of text inside a `<table>`, which parse5 holds a token at a time, 56 bytes
 * each) need 352 to 368, and are served or refused according to how the garbage collector's last run went:
 * a refusal as `worker_oom` is the answer to those, and it is remembered only for a little while for that
 * reason. 384 is 2.4 times the 160. The pod it runs in has 1 GiB to share with the host, which is what
 * keeps this from being larger.
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
const YOUNG_GENERATION_MB = 3 * SEMI_SPACE_MB;
/** How far the heap limit a worker reports may be from `old + young`: V8 rounds to pages. */
const LIMIT_TOLERANCE_MB = 2;
const DEFAULT_DEADLINE_MS = 6000;
/** A burst a person can make (the browser tests load sixteen pages at once) fits; the line is for the rest. */
const DEFAULT_MAX_QUEUED = 32;
const DEFAULT_MAX_QUEUED_CHARS = 32 * 1024 * 1024;
const DEFAULT_BUSY_WINDOW_MS = 10_000;
const DEFAULT_MAX_BUSY_MS = 5000;
const DEFAULT_IDLE_MS = 20_000;
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
 *   worker_spawn_failed      the process could not be made
 *   worker_start_exit_<n>    it ended with exit code <n> before it said it was ready (a bad flag is 9, a
 *                            module it could not load is 1)
 *   worker_start_signal_<S>  it was ended by signal <S> before it said it was ready
 *   worker_exit_<n>          it ended with exit code <n> while it had a page, or stopped being there with none
 *   worker_signal_<S>        it was ended by signal <S> that is not one of memory (a crash)
 *   worker_killed            it was killed from outside, which in a pod is the kernel running out of memory;
 *                            the page is answered `worker_oom`
 *   worker_limit_mismatch    its heap limit is not the one it was asked for
 *   worker_bad_ready         the first thing it said was not what a worker says when it starts
 *   worker_bad_message       it said something that is not an answer
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

/** Reads a worker's answer. Anything that is not exactly one of the two answers it sends is a worker that is not working. */
function readAnswer(message: unknown, id: number): PreparedPage | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as { id?: unknown; ok?: unknown; bytes?: unknown; reason?: unknown };
  if (m.id !== id) return null;
  if (m.ok === true && m.bytes instanceof Uint8Array) return { ok: true, bytes: m.bytes };
  if (m.ok === false && isPrepareRefusal(m.reason)) return refused(m.reason);
  return refused('worker_failed');
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
  private readonly now: () => number;
  private readonly execArgv: string[];
  private readonly onFault: (fault: unknown) => void;

  constructor(options: HtmlPreparerOptions) {
    this.entry = fileURLToPath(options.workerUrl ?? DEFAULT_WORKER_URL);
    this.oldGenerationMb = atLeast('maxOldGenerationSizeMb', options.maxOldGenerationSizeMb ?? DEFAULT_OLD_GENERATION_MB, MIN_OLD_GENERATION_MB);
    this.deadlineMs = atLeast('deadlineMs', options.deadlineMs ?? DEFAULT_DEADLINE_MS, 1);
    this.maxQueued = atLeast('maxQueued', options.maxQueued ?? DEFAULT_MAX_QUEUED, 0);
    this.maxQueuedChars = atLeast('maxQueuedChars', options.maxQueuedChars ?? DEFAULT_MAX_QUEUED_CHARS, 0);
    this.busyWindowMs = atLeast('busyWindowMs', options.busyWindowMs ?? DEFAULT_BUSY_WINDOW_MS, 1);
    this.maxBusyMs = atLeast('maxBusyMs', options.maxBusyMs ?? DEFAULT_MAX_BUSY_MS, 0);
    this.idleMs = atLeast('idleMs', options.idleMs ?? DEFAULT_IDLE_MS, 1);
    this.now = options.now ?? (() => performance.now());
    this.execArgv = options.execArgv ?? [];
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

  /** Characters of page the worker has been given and has not finished: the one it is on, and the ones waiting. */
  private heldChars(): number {
    let total = this.running === null ? 0 : this.running.job.html.length;
    for (const job of this.waiting) total += job.html.length;
    return total;
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
    const id = this.nextId++;
    try {
      this.worker ??= this.start();
    } catch (err) {
      this.onFault(new PoolFault('worker_spawn_failed', `the prepare worker could not be started: ${describe(err)}`));
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
        if (err !== null) this.ended(generation, new PoolFault('worker_spawn_failed', `the page could not be sent to the prepare worker: ${describe(err)}`), 'worker_failed');
      });
    } catch (err) {
      this.ended(generation, new PoolFault('worker_spawn_failed', `the page could not be sent to the prepare worker: ${describe(err)}`), 'worker_failed');
    }
  }

  private start(): Worker {
    const generation = ++this.generation;
    const child = fork(this.entry, [WORKER_ARG], {
      // The pool's flags first, so that the limit asked for is the one given; then the caller's (for tests). None of
      // this process's own flags are passed on, whatever it was started with.
      execArgv: [`--max-old-space-size=${this.oldGenerationMb}`, `--max-semi-space-size=${SEMI_SPACE_MB}`, ...this.execArgv],
      // Nothing of ours for it to read: no environment (a NODE_OPTIONS of the host's would otherwise change the limits).
      env: {},
      // No standard streams, and the one channel it is spoken to over. `advanced` carries the page's bytes as bytes.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
    });
    const worker: Worker = { process: child, ready: false };
    child.on('message', (message: unknown) => this.heard(generation, worker, message));
    // 'error' is the process that could not be made, or told to end, or sent to. It must have a listener or it throws.
    child.on('error', (err: Error) => this.ended(generation, new PoolFault('worker_spawn_failed', `the prepare worker failed: ${describe(err)}`), 'worker_failed'));
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
    if (!page.ok && page.reason === 'worker_failed') {
      // Something other than an answer: it is not to be trusted again. Ended BEFORE the page is finished, as
      // finishing starts the next waiting page, which must go to a worker that is not the one just ended.
      this.onFault(new PoolFault('worker_bad_message', 'the prepare worker sent a message that is not an answer'));
      this.discard();
      this.finish(running, page);
      return;
    }
    this.finish(running, page);
  }

  /** The first thing a worker says: that it is ready, and with what heap limit. A worker that is not as asked is not used. */
  private becameReady(generation: number, worker: Worker, message: unknown): void {
    const limit = readReady(message);
    const expected = this.oldGenerationMb + YOUNG_GENERATION_MB;
    if (limit === null || Math.abs(limit - expected) > LIMIT_TOLERANCE_MB) {
      this.onFault(
        limit === null
          ? new PoolFault('worker_bad_ready', 'the prepare worker did not start by saying that it is ready')
          : new PoolFault('worker_limit_mismatch', `the prepare worker has a heap limit of ${limit.toFixed(0)} MB and was asked for ${expected} MB`),
      );
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
      this.ended(generation, null, 'worker_oom');
    } else if (worker.ready && signal === 'SIGKILL') {
      this.ended(generation, new PoolFault('worker_killed', `the prepare worker was killed (${how}), which in a pod is the kernel running out of memory`), 'worker_oom');
    } else if (!worker.ready) {
      const code_ = signal !== null ? `worker_start_signal_${signal}` : `worker_start_exit_${String(code)}`;
      this.ended(generation, new PoolFault(code_, `the prepare worker ended (${how}) before it said it was ready`), 'worker_failed');
    } else {
      const code_ = signal !== null ? `worker_signal_${signal}` : `worker_exit_${String(code)}`;
      this.ended(generation, new PoolFault(code_, `the prepare worker ended (${how})`), 'worker_failed');
    }
  }

  /** The worker ended by itself: out of memory, a crash, or it exited; or a message to it could not be sent. */
  private ended(generation: number, fault: PoolFault | null, reason: PoolRefusal): void {
    if (generation !== this.generation) return;
    this.discard();
    if (fault !== null) this.onFault(fault);
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
