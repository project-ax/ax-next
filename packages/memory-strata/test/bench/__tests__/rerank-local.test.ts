import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeLocalCrossEncoderRerankClient } from '../rerank-local.js';

// These tests exercise the spawn + newline-delimited-JSON parse path of the local
// reranker client against a FAKE python script (a tiny node stub). They never load
// the real 435M cross-encoder, so they run in CI.

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

/** Write a node script that mimics the python rerank protocol and return its path. */
function writeFakeScript(body: string): string {
  dir = mkdtempSync(join(tmpdir(), 'fake-rerank-'));
  const p = join(dir, 'fake.js');
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

describe('makeLocalCrossEncoderRerankClient', () => {
  it('scores docs via the subprocess and maps scores back to docIds in input order', async () => {
    // Fake: read NDJSON requests, score by document length (longer = higher).
    const script = writeFakeScript(`
      let buf = '';
      process.stdin.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          const scores = req.documents.map((d) => d.length);
          process.stdout.write(JSON.stringify({ scores }) + '\\n');
        }
      });
    `);
    const client = makeLocalCrossEncoderRerankClient({ pythonBin: process.execPath, scriptPath: script });
    try {
      const res = await client.rerank('q', [
        { docId: 'short', text: 'hi' },
        { docId: 'long', text: 'a much longer document body' },
      ]);
      const byId = new Map(res.reranked.map((r) => [r.docId, r.score]));
      expect(byId.get('long')!).toBeGreaterThan(byId.get('short')!);
      expect(res.tokens).toBe(0); // local model: latency is the cost metric, not tokens
    } finally {
      await client.close?.();
    }
  });

  it('reuses ONE subprocess across multiple rerank calls', async () => {
    // The fake appends an incrementing nonce to prove the same process handles both calls.
    const script = writeFakeScript(`
      let n = 0; let buf = '';
      process.stdin.on('data', (c) => {
        buf += c; let i;
        while ((i = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const req = JSON.parse(line); n += 1;
          process.stdout.write(JSON.stringify({ scores: req.documents.map(() => n) }) + '\\n');
        }
      });
    `);
    const client = makeLocalCrossEncoderRerankClient({ pythonBin: process.execPath, scriptPath: script });
    try {
      const r1 = await client.rerank('q1', [{ docId: 'a', text: 'x' }]);
      const r2 = await client.rerank('q2', [{ docId: 'b', text: 'y' }]);
      expect(r1.reranked[0]!.score).toBe(1);
      expect(r2.reranked[0]!.score).toBe(2); // same process, nonce incremented
    } finally {
      await client.close?.();
    }
  });

  it('throws a clear error when the subprocess emits an {error} response', async () => {
    const script = writeFakeScript(`
      let buf = '';
      process.stdin.on('data', (c) => {
        buf += c; let i;
        while ((i = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          process.stdout.write(JSON.stringify({ error: 'boom from model' }) + '\\n');
        }
      });
    `);
    const client = makeLocalCrossEncoderRerankClient({ pythonBin: process.execPath, scriptPath: script });
    try {
      await expect(client.rerank('q', [{ docId: 'a', text: 'x' }])).rejects.toThrow(/boom from model/);
    } finally {
      await client.close?.();
    }
  });

  it('rejects an empty doc list without spawning work (returns empty)', async () => {
    const script = writeFakeScript(`process.stdin.resume();`);
    const client = makeLocalCrossEncoderRerankClient({ pythonBin: process.execPath, scriptPath: script });
    try {
      const res = await client.rerank('q', []);
      expect(res.reranked).toEqual([]);
      expect(res.tokens).toBe(0);
    } finally {
      await client.close?.();
    }
  });

  it('rejects a concurrent rerank call (single in-flight request) instead of corrupting the mapping', async () => {
    // Fake that NEVER responds, so the first call stays in flight while we issue a second.
    const script = writeFakeScript(`
      let buf = '';
      process.stdin.on('data', (c) => { buf += c; }); // read but never reply
    `);
    const client = makeLocalCrossEncoderRerankClient({ pythonBin: process.execPath, scriptPath: script });
    // The first call stays pending until close() kills the worker, which rejects it.
    // Attach a catch up-front so that rejection is HANDLED (no unhandled-rejection that
    // would fail the run), and assert it rejected with the expected teardown message.
    const first = client.rerank('q1', [{ docId: 'a', text: 'x' }]);
    const firstSettled = expect(first).rejects.toThrow(/exited|in flight/);
    try {
      await expect(client.rerank('q2', [{ docId: 'b', text: 'y' }])).rejects.toThrow(/already in flight/);
    } finally {
      await client.close?.();
    }
    await firstSettled;
  });

  it('surfaces a spawn failure (bad python binary) as a rejected promise', async () => {
    const script = writeFakeScript(`process.stdin.resume();`);
    const client = makeLocalCrossEncoderRerankClient({
      pythonBin: '/nonexistent/python-binary-xyz',
      scriptPath: script,
    });
    try {
      await expect(client.rerank('q', [{ docId: 'a', text: 'x' }])).rejects.toThrow();
    } finally {
      await client.close?.();
    }
  });
});
