import { writeFileSync } from 'node:fs';
import { getPriority, setPriority } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { prepareArtifactHtml, type PrepareRefusal } from './prepare-html.js';

// The entry of the worker PROCESS `createHtmlPreparer` (prepare-pool.ts) starts: it runs
// `prepareArtifactHtml` on the pages it is sent, one at a time, over the channel the pool
// forked it with, and answers with the page as UTF-8 bytes or the transform's refusal code.
// It reads no file, uses no network and takes nothing from the environment after it has
// loaded, and is started with an empty one.
//
// A process, because that is the one boundary that holds. The transform runs a third-party
// parser over bytes an agent chose, and the worst such a page can do is not to be slow but
// to need more memory than anyone thought of: a thread that runs out takes the whole process
// with it (V8 aborts it rather than end the thread when the need is far over the limit), and
// so would anything else that went wrong here. This process can run out of memory, be killed
// or crash, and what the host sees is a page that was not prepared. It is not a sandbox: it
// runs as the same user, with the same files. What it buys is that the work, and the memory
// and the crashes that come with it, are somewhere the host is not.
//
// It is also the process to give up when the machine is short: it asks the kernel to kill it
// before anything else in the pod (`oom_score_adj`), and to give the host's threads the CPU
// first (a lower priority). Both are only ever a request to be treated worse, which needs no
// privilege, and both are skipped where they cannot be made.

/**
 * The CPU the transform may use on one page in this process: four times the heaviest real page measured
 * (0.35 s of CPU for 3 to 4 MiB of script, on the machine measured on), so a slower host serves it too.
 * It can be this long because nothing else runs here: the thread that serves requests is not held while
 * it is used up. It is given as an argument and not the transform's default, which is short, so no caller
 * that does not run on a worker of its own gets it. A refusal as too slow is remembered with the page, so
 * a page near this must not be near it on a slower host: that is what the factor of four is for.
 */
export const WORKER_BUDGET_MS = 1500;

/**
 * The most a prepared page may be, in bytes of UTF-8: what is sent back, kept in the origin's cache and served. The
 * transform's own ceiling is in characters (6 MiB and a little over), and a character is up to three bytes, so a
 * page of 4 MiB whose CJK attribute was rebuilt 55 times came back as 16.8 MB, a response that large and half of the
 * 32 MiB the origin keeps. Where the bytes are made is where they are counted: for ASCII the character ceiling is the
 * lower of the two and this never refuses anything; it is for the pages whose characters are wider. Twice the largest
 * page there can be as input (4 MiB), which no page that is merely written out as it was came near.
 */
export const MAX_PREPARED_BYTES = 8 * 1024 * 1024;

/**
 * The argument the pool starts this process with. The entry does nothing without it, so that
 * importing this file (a test, the pool itself) never takes hold of the channel of the process
 * that imported it, which for a test runner is the runner's own.
 */
export const WORKER_ARG = '--ax-frame-guard-worker';

/** What the pool sends. */
export interface WorkerJob {
  id: number;
  html: string;
}

/** What the worker answers: the page's bytes, or why it was refused. */
export type WorkerAnswer = { id: number; ok: true; bytes: Uint8Array } | { id: number; ok: false; reason: PrepareRefusal };

/**
 * The first thing the worker says, before it is given a page: the heap limit its V8 really has, in MB
 * (`heap_size_limit`: the old generation plus the young one). The pool asked for a limit; a worker whose
 * limit is not that one is not protecting anything, and the pool does not use it.
 */
export interface WorkerReady {
  ready: true;
  heapLimitMb: number;
}

/** The answer to one page. Exported for the tests; the process uses it below. */
export function answerJob(job: WorkerJob): WorkerAnswer {
  const result = prepareArtifactHtml(job.html, { budgetMs: WORKER_BUDGET_MS });
  if (!result.ok) return { id: job.id, ok: false, reason: result.reason };
  const bytes = new TextEncoder().encode(result.html);
  if (bytes.byteLength > MAX_PREPARED_BYTES) return { id: job.id, ok: false, reason: 'output_too_large' };
  return { id: job.id, ok: true, bytes };
}

function isJob(message: unknown): message is WorkerJob {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as { id?: unknown; html?: unknown };
  return typeof m.id === 'number' && typeof m.html === 'string';
}

/** Asks to be the process the kernel kills first, and the one that waits for the CPU. Neither is needed to work. */
function askToBeGivenUpFirst(): void {
  try {
    // Linux. 1000 is the most killable there is; a process may raise its own, whoever it is.
    writeFileSync('/proc/self/oom_score_adj', '1000');
  } catch {
    // Not Linux, or a sandbox with no /proc to write: the heap limit is still what holds.
  }
  try {
    // Ten steps below the host (the most the scheduler is asked to tell apart), whatever the host runs at.
    setPriority(Math.min(19, getPriority() + 10));
  } catch {
    // Nothing is lost by running at the priority it was given.
  }
}

// Imported anywhere but as the worker's entry, there is no argument, and nothing happens.
if (process.argv[2] === WORKER_ARG && typeof process.send === 'function') {
  const send = process.send.bind(process);
  // The host let go of the channel, or went away: there is nobody to answer, and nothing to wait for.
  process.on('disconnect', () => process.exit(0));
  process.on('message', (message: unknown) => {
    if (isJob(message)) send(answerJob(message));
  });
  askToBeGivenUpFirst();
  const ready: WorkerReady = { ready: true, heapLimitMb: getHeapStatistics().heap_size_limit / (1024 * 1024) };
  send(ready);
}
