import { readdirSync, writeFileSync } from 'node:fs';
import { getPriority, setPriority } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { MAX_PREPARED_BYTES, prepareArtifactHtml, type PrepareRefusal } from './prepare-html.js';

// The entry of the worker PROCESS `createHtmlPreparer` (prepare-pool.ts) starts: it runs
// `prepareArtifactHtml` on the pages it is sent, one at a time, over the channel the pool
// forked it with, and answers with the page as UTF-8 bytes or the transform's refusal code.
// It reads no file, uses no network and takes nothing from the environment after it has
// loaded, and is started with an empty one.
//
// A process, because that is the boundary that holds against a worker that FAILS. The
// transform runs a third-party parser over bytes an agent chose, and the worst such a page
// can do is not to be slow but to need more memory than anyone thought of: a thread that
// runs out takes the whole process with it (V8 aborts it rather than end the thread when the
// need is far over the limit), and so would anything else that went wrong here. This process
// can run out of its heap (not the container's memory: see below), hang or crash, and what
// the host sees is a page that was not prepared. What it buys is that the work, and the memory and the crashes that come with it,
// are somewhere the host is not.
//
// It is not a sandbox, and it holds against nothing that has been TAKEN OVER (a flaw in the
// JavaScript engine that a page's bytes reach, say). It runs as the same user in the same
// pod: it can signal the host, read the host's environment from /proc (measured, in a
// container with every capability dropped), and write to the channel what the host's Node
// cannot read, which ends the host with an uncaught exception. (Measured: it is thrown from
// the channel's read callback, so no handler on the child sees it, and only a process-wide
// `uncaughtException` handler does, which a library must not install; `serialization: 'json'`
// throws the same way, and a frame that announces gigabytes makes the host hold them first.)
// The host checks what it is sent (an answer's shape, its length, that the guard is in it),
// which stops a worker that is wrong and not one that is hostile. Against that the way is the
// worker's own user or pod, a syscall filter, or a channel the host reads itself with a
// bound; none of them is here.
//
// It is also the process to give up when the machine is short: it asks the kernel to end it
// first when it must end one (`oom_score_adj`), and to give the host's threads the CPU first (a
// lower priority, which on Linux belongs to a thread, so it is set on each of the process's
// threads, V8's helpers included). Both are only ever a request to be treated worse, which needs
// no privilege, and both are skipped where they cannot be made.
//
// Neither is what keeps the host alive when the CONTAINER's memory limit is met. `oom_score_adj`
// only chooses who is first; under `memory.oom.group` (Kubernetes sets it on cgroup v2 by default) the
// kernel ends every process in the container, the host with them. Measured: a container of
// 600 MiB, the host holding 300 MB and a heavy page, exits 137 whatever heap the worker was
// given. A V8 heap abort ends this process alone; the container's limit does not. So the pool
// sizes the heap from the container's limit, a share of it, and a page that needs more than
// that is refused as out of memory, which is an answer (prepare-pool.ts, `oldGenerationFor`).

/**
 * The CPU the transform may use on one page in this process: four times the heaviest real page measured
 * (0.35 s of CPU for 3 to 4 MiB of script, on the machine measured on), so a slower host serves it too.
 * It can be this long because nothing else runs here: the thread that serves requests is not held while
 * it is used up. It is given as an argument and not the transform's default, which is short, so no caller
 * that does not run on a worker of its own gets it. A refusal as too slow is remembered with the page, so
 * a page near this must not be near it on a slower host: that is what the factor of four is for.
 */
export const WORKER_BUDGET_MS = 1500;

// (`MAX_PREPARED_BYTES`, in prepare-html.ts, is the most a prepared page may be. The transform keeps to it in characters; a
// character is up to three bytes, so a page of 4 MiB with a CJK attribute on a formatting element that a following tag
// brings back 55 times came back as 16.8 MB in 352 ms, half of the 32 MiB the origin keeps. Where the bytes are made is where
// they are counted, below. For ASCII the two are the same to within the guard's slack.)

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

/**
 * The answer to one page, and always an answer: the transform does not throw, and encoding a string it made does not, but if either
 * does it is this page that did it (what else has the worker been given?), and the answer is that the parser threw. An exception
 * that left the worker would end it, and the pool would call that a crash on this page, which it is, only more slowly and with a
 * process started again. Exported for the tests; the process uses it below.
 */
export function answerJob(job: WorkerJob): WorkerAnswer {
  try {
    const result = prepareArtifactHtml(job.html, { budgetMs: WORKER_BUDGET_MS });
    if (!result.ok) return { id: job.id, ok: false, reason: result.reason };
    const bytes = new TextEncoder().encode(result.html);
    if (bytes.byteLength > MAX_PREPARED_BYTES) return { id: job.id, ok: false, reason: 'output_too_large' };
    return { id: job.id, ok: true, bytes };
  } catch {
    return { id: job.id, ok: false, reason: 'parse_error' };
  }
}

/**
 * Answers one page over `send`. If sending the answer throws (it is big, and the channel can refuse it), the refusal is sent
 * instead, which is small; if that cannot be sent either there is nobody to tell, and `giveUp` ends the process. Exported for the
 * tests; the process uses it below.
 */
export function handleJob(job: WorkerJob, send: (answer: WorkerAnswer) => void, giveUp: () => void = () => process.exit(1)): void {
  try {
    send(answerJob(job));
  } catch {
    try {
      send({ id: job.id, ok: false, reason: 'parse_error' });
    } catch {
      giveUp();
    }
  }
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
    const nice = Math.min(19, getPriority() + 10);
    setPriority(nice);
    lowerTheOtherThreads(nice);
  } catch {
    // Nothing is lost by running at the priority it was given.
  }
}

/**
 * On Linux a nice value belongs to a thread, and `setPriority(pid)` reaches only the main one. V8 made its helper threads (the
 * collector, the compiler) before this runs, and measured, 29 to 50% of a worker's CPU on a heavy page ran on them at the priority
 * the host has. They are tasks of this process, listed in /proc/self/task, and setpriority takes a task id; a thread made from here
 * on takes the one that makes it (the main thread, already lowered). Each is tried on its own: one that is gone is no reason to
 * leave the rest. (Elsewhere there is no /proc, and a process's priority is the process's.)
 */
export function lowerTheOtherThreads(
  nice: number,
  io: { tasks: () => string[]; set: (id: number, nice: number) => void; self: number } = {
    tasks: () => readdirSync('/proc/self/task'),
    set: setPriority,
    self: process.pid,
  },
): void {
  let tasks: string[];
  try {
    tasks = io.tasks();
  } catch {
    return;
  }
  for (const task of tasks) {
    const id = Number(task);
    if (id === io.self) continue;
    try {
      io.set(id, nice);
    } catch {
      // Ended since it was listed, or not ours to lower.
    }
  }
}

// Imported anywhere but as the worker's entry, there is no argument, and nothing happens.
if (process.argv[2] === WORKER_ARG && typeof process.send === 'function') {
  const send = process.send.bind(process);
  // The host let go of the channel, or went away: there is nobody to answer, and nothing to wait for.
  process.on('disconnect', () => process.exit(0));
  process.on('message', (message: unknown) => {
    if (isJob(message)) handleJob(message, send);
  });
  askToBeGivenUpFirst();
  const ready: WorkerReady = { ready: true, heapLimitMb: getHeapStatistics().heap_size_limit / (1024 * 1024) };
  send(ready);
}
