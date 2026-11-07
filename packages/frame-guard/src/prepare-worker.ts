import { parentPort } from 'node:worker_threads';
import { prepareArtifactHtml, type PrepareRefusal } from './prepare-html.js';

// The entry of the worker thread `createHtmlPreparer` (prepare-pool.ts) starts: it
// runs `prepareArtifactHtml` on the pages it is sent, one at a time, and answers
// with the page as UTF-8 bytes (handed over, not copied) or the transform's
// refusal code. It reads no file, uses no network and takes nothing from the
// environment after it has loaded, and is started with an empty one.
//
// This is a thread, not a sandbox: it shares the process and its privileges. What
// it buys is that the work is somewhere else. A page that costs the transform its
// whole time budget holds this thread, not the one that serves requests; one that
// runs it out of memory ends this thread (the pool gives it a heap limit) and not the
// process; one that holds it in a stretch nothing can interrupt is ended by the pool
// from outside.

/**
 * The CPU the transform may use on one page in this thread: four times the heaviest real page measured
 * (0.35 s of CPU for 3 to 4 MiB of script, on the machine measured on), so a slower host serves it too.
 * It can be this long because nothing else runs here: the thread that serves requests is not held while
 * it is used up. It is given as an argument and not the transform's default, which is short, so no caller
 * that does not run on a worker of its own gets it. A refusal as too slow is remembered with the page, so
 * a page near this must not be near it on a slower host: that is what the factor of four is for.
 */
export const WORKER_BUDGET_MS = 1500;

/** What the pool sends. */
export interface WorkerJob {
  id: number;
  html: string;
}

/** What the worker answers: the page's bytes, or why it was refused. */
export type WorkerAnswer = { id: number; ok: true; bytes: Uint8Array } | { id: number; ok: false; reason: PrepareRefusal };

/** The answer to one page, and what is to be handed over rather than copied when it is sent. Exported for the tests; the thread uses it below. */
export function answerJob(job: WorkerJob): { answer: WorkerAnswer; transfer: ArrayBuffer[] } {
  const result = prepareArtifactHtml(job.html, { budgetMs: WORKER_BUDGET_MS });
  if (!result.ok) return { answer: { id: job.id, ok: false, reason: result.reason }, transfer: [] };
  // `encode` returns a view of a buffer that is the page's alone, so it can be handed over whole.
  const bytes = new TextEncoder().encode(result.html);
  return { answer: { id: job.id, ok: true, bytes }, transfer: [bytes.buffer as ArrayBuffer] };
}

// Imported anywhere but as a worker's entry there is no port, and nothing happens.
if (parentPort !== null) {
  const port = parentPort;
  port.on('message', (job: WorkerJob) => {
    const { answer, transfer } = answerJob(job);
    port.postMessage(answer, transfer);
  });
}
