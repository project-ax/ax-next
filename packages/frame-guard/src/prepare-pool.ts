import { Worker, type ResourceLimits } from 'node:worker_threads';
import { isPrepareRefusal, type PrepareRefusal } from './prepare-html.js';

// `prepareArtifactHtml` is synchronous and its limits are measured, not proven: it
// runs a third-party parser over bytes an agent chose, and a shape nobody has found
// can hold the thread or end the process. The host serves every user from one
// thread, so that is not where it should run. This runs it on a worker thread, one
// page at a time, and answers a page the worker could not handle with a refusal
// instead of an error:
//
//   - it has a heap limit, so a page that makes the transform run out of memory ends
//     the worker (`worker_oom`) and not the process;
//   - it has a wall-clock deadline, so a page that holds it where nothing in the
//     transform can look at a clock is ended from outside (`worker_timeout`);
//   - pages wait in a line bounded by how many there are and how much text they
//     hold (each is a string the caller has made and the worker has not read yet),
//     and a page that finds it full, or that arrives when the worker has been busy
//     for half of the last ten seconds, is turned away at once (`busy`) instead of
//     queueing behind work nobody is waiting for.
//
// A worker that was ended is started again for the next page. The transform's own
// limits (and its CPU-time budget) still apply inside the worker: they are what
// refuses most hostile pages in milliseconds, and the worker is what is left when
// they don't.

/** Why a page was not prepared, beyond the reasons the transform itself gives (`PrepareRefusal`). */
export type PoolRefusal =
  /** The worker did not answer in time and was ended. (The transform's budget is CPU time; this is the wall clock.) */
  | 'worker_timeout'
  /** The worker ran out of memory and was ended. */
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
  /** Heap the worker may use before it is ended, in MB: 16 or more (a smaller limit would end the process). Default 384. */
  maxOldGenerationSizeMb?: number;
  /** Milliseconds, on the wall clock, a page may take before the worker is ended. Default 6000. */
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
  /** Told when the worker fails in a way the page does not explain (a crash, a worker that cannot start). Never given a page. */
  onFault?: (fault: unknown) => void;
  /** For tests: the clock the busy window is kept on, in milliseconds. */
  now?: () => number;
  /** For tests: options the worker's Node is started with (a TypeScript loader, to run the worker from source). Default none. */
  execArgv?: string[];
}

const DEFAULT_WORKER_URL = new URL('./prepare-worker.js', import.meta.url);
/**
 * What the transform may use of heap before the worker is ended. The biggest real
 * page measured (a 4 MiB page, 4.1 MB on disk) needs about 270 MB, nearly all of it
 * the tokenizer's text: parse5 appends a character at a time, which is a string
 * join each until something flattens the result (the parse of that page holds 125 MB
 * of them). 256 MB refuses it, 288 serves it; this leaves it half again.
 */
const DEFAULT_OLD_GENERATION_MB = 384;
/**
 * The least heap limit the pool will start a worker with. Node does not end the worker for a limit
 * that is too small, it ends the PROCESS: measured, 0, 1, 2, a negative number and NaN abort it with
 * "Fatal JavaScript out of memory: GC during deserialization" while the worker is being made, 4 gives
 * a worker that runs out of memory at once, and 8 and up work. A limit is a thing the code that makes
 * the pool writes down, so a bad one is refused when the pool is made and not with the first page.
 */
const MIN_OLD_GENERATION_MB = 16;
const DEFAULT_DEADLINE_MS = 6000;
/** A burst a person can make (the browser tests load sixteen pages at once) fits; the line is for the rest. */
const DEFAULT_MAX_QUEUED = 32;
const DEFAULT_MAX_QUEUED_CHARS = 32 * 1024 * 1024;
const DEFAULT_BUSY_WINDOW_MS = 10_000;
const DEFAULT_MAX_BUSY_MS = 5000;

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

/** Reads a worker's answer. Anything that is not exactly one of the two answers it sends is a worker that is not working. */
function readAnswer(message: unknown, id: number): PreparedPage | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as { id?: unknown; ok?: unknown; bytes?: unknown; reason?: unknown };
  if (m.id !== id) return null;
  if (m.ok === true && m.bytes instanceof Uint8Array) return { ok: true, bytes: m.bytes };
  if (m.ok === false && isPrepareRefusal(m.reason)) return refused(m.reason);
  return refused('worker_failed');
}

class WorkerPreparer implements HtmlPreparer {
  private worker: Worker | null = null;
  /** Which worker is the current one: events from an older one (ended on purpose, or crashing late) are ignored. */
  private generation = 0;
  private running: Running | null = null;
  private readonly waiting: Job[] = [];
  private nextId = 1;
  private closed = false;
  /** When each finished page ended and how long it kept the worker, newest last, for the busy window. */
  private readonly spent: Array<{ endedAt: number; ms: number }> = [];

  private readonly workerUrl: URL;
  private readonly limits: ResourceLimits;
  private readonly deadlineMs: number;
  private readonly maxQueued: number;
  private readonly maxQueuedChars: number;
  private readonly busyWindowMs: number;
  private readonly maxBusyMs: number;
  private readonly now: () => number;
  private readonly execArgv: string[];
  private readonly onFault: (fault: unknown) => void;

  constructor(options: HtmlPreparerOptions) {
    this.workerUrl = options.workerUrl ?? DEFAULT_WORKER_URL;
    this.limits = {
      maxOldGenerationSizeMb: atLeast('maxOldGenerationSizeMb', options.maxOldGenerationSizeMb ?? DEFAULT_OLD_GENERATION_MB, MIN_OLD_GENERATION_MB),
    };
    this.deadlineMs = atLeast('deadlineMs', options.deadlineMs ?? DEFAULT_DEADLINE_MS, 1);
    this.maxQueued = atLeast('maxQueued', options.maxQueued ?? DEFAULT_MAX_QUEUED, 0);
    this.maxQueuedChars = atLeast('maxQueuedChars', options.maxQueuedChars ?? DEFAULT_MAX_QUEUED_CHARS, 0);
    this.busyWindowMs = atLeast('busyWindowMs', options.busyWindowMs ?? DEFAULT_BUSY_WINDOW_MS, 1);
    this.maxBusyMs = atLeast('maxBusyMs', options.maxBusyMs ?? DEFAULT_MAX_BUSY_MS, 0);
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

  /** Sends the next waiting page to the worker, if it is free. */
  private next(): void {
    if (this.running !== null) return;
    const job = this.waiting.shift();
    if (job === undefined) return;
    const id = this.nextId++;
    let worker: Worker;
    try {
      worker = this.worker ?? this.start();
    } catch (err) {
      this.onFault(err);
      job.resolve(refused('worker_failed'));
      this.next();
      return;
    }
    const generation = this.generation;
    this.running = {
      job,
      id,
      startedAt: this.now(),
      // Not unref'd: while a page is being prepared the process has something to wait for.
      timer: setTimeout(() => this.timedOut(generation, id), this.deadlineMs),
    };
    worker.postMessage({ id, html: job.html });
  }

  private start(): Worker {
    const generation = ++this.generation;
    const worker = new Worker(this.workerUrl, {
      resourceLimits: this.limits,
      // Nothing of ours for it to read: no environment, none of this process's flags.
      env: {},
      execArgv: this.execArgv,
    });
    worker.on('message', (message: unknown) => this.answered(generation, message));
    worker.on('error', (err: Error & { code?: string }) =>
      this.ended(generation, err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'worker_oom' : 'worker_failed', err),
    );
    worker.on('exit', () => this.ended(generation, 'worker_failed', undefined));
    // After the listeners, not before: a 'message' listener takes hold of the worker's port again (measured: a
    // worker unref-ed first and given its listeners after kept an idle process from ever ending). While a page is
    // being prepared it is the deadline timer that keeps the process open, which is what is wanted.
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private answered(generation: number, message: unknown): void {
    const running = this.running;
    if (generation !== this.generation || running === null) return;
    const page = readAnswer(message, running.id);
    if (page === null) return;
    if (!page.ok && page.reason === 'worker_failed') {
      // Something other than an answer: it is not to be trusted again. Ended BEFORE the page is finished, as
      // finishing starts the next waiting page, which must go to a worker that is not the one just ended.
      this.onFault(new Error('prepare worker sent a message that is not an answer'));
      this.discard();
      this.finish(running, page);
      return;
    }
    this.finish(running, page);
  }

  /** The worker ended by itself: out of memory, a crash, or it exited. */
  private ended(generation: number, reason: PoolRefusal, err: unknown): void {
    if (generation !== this.generation) return;
    this.worker = null;
    this.generation++;
    // Running out of memory is what a page can do to it; the rest is the worker, not the page.
    if (reason !== 'worker_oom') this.onFault(err ?? new Error('prepare worker exited'));
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
    if (worker !== null) worker.terminate().catch(() => undefined);
  }

  private async end(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.generation++;
    if (worker !== null) await worker.terminate().catch(() => undefined);
  }

  private finish(running: Running, page: PreparedPage): void {
    clearTimeout(running.timer);
    this.running = null;
    this.note(running.startedAt);
    running.job.resolve(page);
    this.next();
  }
}

/**
 * A preparer that runs `prepareArtifactHtml` on a worker thread (see above). The
 * thread is started with the first page and again after any that ended it; close
 * it when the owner goes away.
 */
export function createHtmlPreparer(options: HtmlPreparerOptions = {}): HtmlPreparer {
  return new WorkerPreparer(options);
}
