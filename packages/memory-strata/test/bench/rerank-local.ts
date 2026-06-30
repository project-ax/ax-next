// Local cross-encoder rerank client (TASK-192).
//
// Implements the same `RerankClient` interface config B/F consume, but instead of
// calling the hosted zerank-2 API it spawns a long-lived Python subprocess that runs
// a sentence-transformers CrossEncoder (mxbai-rerank-large-v1 by default) locally.
// See `scripts/cross_encoder_rerank.py` for the worker.
//
// Why a subprocess instead of an in-process node model: the 435M cross-encoder +
// torch is a ~1.7GB Python stack with no maintained pure-node equivalent. Shelling
// out keeps that weight OUT of the node dependency tree (this is bench-only code),
// and matches the stack SmartSearch (arXiv 2603.15599) used. The process is started
// once and reused across queries (model load is the expensive part).
//
// MEASUREMENT-SPIKE ONLY — never imported by the shipped runtime, never run in CI
// (CI stubs the reranker). Security note: the spawned command is a FIXED in-repo
// python script with a caller-controlled `pythonBin`/`scriptPath`; the only data
// crossing the boundary is the bench corpus text we already own, passed as JSON on
// stdin (never interpolated into a shell — `spawn` with an argv array, `shell:false`).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RerankClient } from './configs/b-rerank.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RERANK_SCRIPT = join(HERE, 'scripts', 'cross_encoder_rerank.py');
export const DEFAULT_RERANK_MODEL = 'mixedbread-ai/mxbai-rerank-large-v1';

export interface LocalCrossEncoderOptions {
  /** Python interpreter to run the worker (e.g. a venv's `bin/python`). */
  pythonBin: string;
  /** Path to the worker script (defaults to the bundled cross_encoder_rerank.py). */
  scriptPath?: string;
  /** HuggingFace model id passed to the worker (--model). */
  model?: string;
}

export interface ClosableRerankClient extends RerankClient {
  /** Terminate the worker subprocess. Idempotent. */
  close(): Promise<void>;
}

interface Pending {
  resolve: (line: string) => void;
  reject: (err: Error) => void;
}

/**
 * Build a {@link RerankClient} backed by a local cross-encoder Python subprocess.
 * The process is spawned lazily on the first `rerank` call and reused thereafter.
 * Calls are serialized (one in flight at a time) so stdout lines map to requests.
 */
export function makeLocalCrossEncoderRerankClient(
  opts: LocalCrossEncoderOptions,
): ClosableRerankClient {
  const scriptPath = opts.scriptPath ?? DEFAULT_RERANK_SCRIPT;
  const model = opts.model ?? DEFAULT_RERANK_MODEL;

  let child: ChildProcessWithoutNullStreams | null = null;
  let stdoutBuf = '';
  let stderrTail = '';
  let queue: Pending | null = null; // single in-flight request
  let fatal: Error | null = null;

  function failAll(err: Error): void {
    fatal = err;
    if (queue) {
      queue.reject(err);
      queue = null;
    }
  }

  function ensureChild(): ChildProcessWithoutNullStreams {
    if (child) return child;
    const args = [scriptPath, '--model', model];
    const c = spawn(opts.pythonBin, args, { shell: false });
    child = c;
    c.stdout.setEncoding('utf8');
    c.stderr.setEncoding('utf8');
    c.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line.trim()) continue;
        const pending = queue;
        queue = null;
        pending?.resolve(line);
      }
    });
    c.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });
    c.on('error', (err) => {
      failAll(new Error(`local-reranker spawn/runtime error: ${err.message}`));
    });
    c.on('exit', (code, sig) => {
      child = null;
      if (queue) {
        failAll(
          new Error(
            `local-reranker process exited (code=${code}, signal=${sig}) before responding. ` +
              `stderr tail: ${stderrTail.trim().slice(-500)}`,
          ),
        );
      }
    });
    return c;
  }

  async function send(payload: object): Promise<string> {
    if (fatal) throw fatal;
    // Single in-flight request: stdout lines are matched to requests positionally,
    // so a concurrent call would clobber the pending resolver. Reject instead of
    // corrupting the mapping. (The bench runs queries sequentially, so this only
    // guards a future misuse.)
    if (queue) {
      throw new Error('local-reranker: a rerank call is already in flight; calls must be serialized');
    }
    const c = ensureChild();
    if (fatal) throw fatal; // a synchronous spawn 'error' may have fired already
    return await new Promise<string>((resolve, reject) => {
      queue = { resolve, reject };
      try {
        c.stdin.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        queue = null;
        reject(new Error(`local-reranker stdin write failed: ${(err as Error).message}`));
      }
    });
  }

  return {
    async rerank(query, docs) {
      if (docs.length === 0) return { reranked: [], tokens: 0 };
      const line = await send({ query, documents: docs.map((d) => d.text) });
      let parsed: { scores?: number[]; error?: string };
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`local-reranker: unparseable response line: ${line.slice(0, 200)}`);
      }
      if (parsed.error) throw new Error(`local-reranker worker error: ${parsed.error}`);
      const scores = parsed.scores;
      if (!Array.isArray(scores) || scores.length !== docs.length) {
        throw new Error(
          `local-reranker: expected ${docs.length} scores, got ${Array.isArray(scores) ? scores.length : typeof scores}`,
        );
      }
      const reranked = docs.map((d, i) => ({ docId: d.docId, score: scores[i]! }));
      // Local model: there is no per-call token billing. Latency is the cost metric
      // (config F records `rerankMs`); report 0 tokens so the CostMeter ignores it.
      return { reranked, tokens: 0 };
    },
    async close() {
      const c = child;
      child = null;
      if (c && !c.killed) {
        try {
          c.stdin.end();
        } catch {
          /* ignore */
        }
        c.kill();
      }
    },
  };
}
