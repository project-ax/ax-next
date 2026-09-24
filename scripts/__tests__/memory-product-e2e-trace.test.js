import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { attemptStats, latencyBreakdown, makeDiagnosticsBuffer, makeTokenSource, openAttemptLog, realNow, sanitizeError, startEnvironmentMonitor, tlsProbe } from '../memory-product-e2e-trace.mjs';
import { withCorpusClock } from '../memory-product-e2e.mjs';

const dirs = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'ax-product-trace-')); dirs.push(path); return path; };
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
const lines = path => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

describe('sanitized failure classes', () => {
  it('keeps only allowlisted identifiers and never a message, body or header', () => {
    const cause = Object.assign(new Error('socket to https://api.cohere.com?key=sk-cause-secret hung up'), { code: 'ECONNRESET', body: 'sk-body-secret' });
    const error = Object.assign(new TypeError('fetch failed: Bearer sk-live-secret'), { cause, code: 'UND_ERR_SOCKET', headers: { authorization: 'Bearer sk-header-secret' }, status: 503 });
    const out = sanitizeError(error);
    expect(out).toEqual({ name: 'TypeError', code: 'UND_ERR_SOCKET', status: 503, cause: { name: 'Error', code: 'ECONNRESET' } });
    expect(JSON.stringify(out)).not.toMatch(/secret|cohere|Bearer|hung up/);
  });
  it('maps unknown names and codes to "other" instead of copying caller-chosen strings', () => {
    class LeakyNameError extends Error { constructor() { super('x'); this.name = 'user@example.com said sk-123'; this.code = 'sk-123'; } }
    expect(sanitizeError(new LeakyNameError())).toEqual({ name: 'other', code: 'other' });
    expect(sanitizeError(Object.assign(new Error('x'), { status: 'teapot' }))).toEqual({ name: 'Error' });
    expect(sanitizeError('a thrown string with sk-secret')).toEqual({ name: 'non-error' });
    expect(sanitizeError(undefined)).toEqual({ name: 'non-error' });
  });
  it('recognizes timeouts and plugin codes the product actually raises', () => {
    expect(sanitizeError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toEqual({ name: 'TimeoutError' });
    expect(sanitizeError(Object.assign(new Error('m'), { name: 'PluginError', code: 'timeout' }))).toEqual({ name: 'PluginError', code: 'timeout' });
    expect(sanitizeError(Object.assign(new Error('m'), { status: 429 }))).toEqual({ name: 'Error', status: 429 });
  });
});

describe('wall clock under the corpus clock', () => {
  it('reports real time even while the corpus clock pins Date', async () => {
    const before = realNow();
    const inside = await withCorpusClock('2023-01-01T00:00:00Z', async () => ({ corpus: Date.now(), real: realNow() }));
    expect(inside.corpus).toBe(Date.parse('2023-01-01T00:00:00Z'));
    expect(inside.real).toBeGreaterThanOrEqual(before);
    expect(inside.real).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'));
  });
});

describe('durable attempt capture', () => {
  it('numbers attempts, never overwrites an earlier one, and appends each event immediately', () => {
    const root = temporary();
    writeFileSync(join(root, 'answer-sonnet.attempt-1.jsonl'), '{"type":"attempt-start","attempt":1}\n');
    const log = openAttemptLog(root, 'sonnet', { runId: 'r', questionId: 'q' });
    expect(log.attempt).toBe(2);
    log.write({ type: 'request', round: 0 });
    const events = lines(join(root, 'answer-sonnet.attempt-2.jsonl'));
    expect(events.map(e => e.type)).toEqual(['attempt-start', 'request']);
    expect(events[0]).toMatchObject({ runId: 'r', questionId: 'q', arm: 'sonnet', attempt: 2, pid: process.pid });
    expect(events.every(e => Number.isFinite(e.at) && Number.isFinite(e.mono) && Number.isSafeInteger(e.seq))).toBe(true);
    expect(readFileSync(join(root, 'answer-sonnet.attempt-1.jsonl'), 'utf8')).toBe('{"type":"attempt-start","attempt":1}\n');
    expect(openAttemptLog(root, 'glm', {}).attempt).toBe(1);
  });
  it('counts an attempt with no terminal event as interrupted, with its tool activity reported separately', () => {
    const root = temporary();
    const bank = join(root, 'bank-a');
    mkdirSync(bank);
    writeFileSync(join(root, 'manifest.json'), '{}');
    const first = openAttemptLog(bank, 'sonnet', {});
    first.write({ type: 'tool', name: 'memory_recall' });
    first.write({ type: 'tool', name: 'memory_recall' });
    const failed = openAttemptLog(bank, 'sonnet', {});
    failed.write({ type: 'attempt-failed', error: { name: 'TypeError' } });
    const complete = openAttemptLog(bank, 'sonnet', {});
    complete.write({ type: 'tool', name: 'memory_recall' });
    complete.write({ type: 'attempt-complete' });
    expect(attemptStats(root)).toEqual({ sonnet: { attempts: 3, complete: 1, failed: 1, interrupted: 1, toolCallsOutsideCompleted: 2 } });
  });
});

describe('attempt capture survives a torn write', () => {
  it('counts an attempt whose last line was cut off as interrupted instead of failing every later report', () => {
    const root = temporary();
    const bank = join(root, 'bank-a');
    mkdirSync(bank);
    const torn = openAttemptLog(bank, 'glm', {});
    torn.write({ type: 'tool', name: 'memory_recall' });
    appendFileSync(torn.path, '{"type":"tool","na');
    expect(attemptStats(root)).toEqual({ glm: { attempts: 1, complete: 0, failed: 0, interrupted: 1, toolCallsOutsideCompleted: 1, unreadableLines: 1 } });
  });
});

describe('diagnostics are buffered out of timed regions', () => {
  it('holds events until flush, then writes each sink once, in order', () => {
    const writes = [];
    const buffer = makeDiagnosticsBuffer((path, text) => writes.push([path, text]));
    buffer.push('a.jsonl', { n: 1 });
    buffer.push('b.jsonl', { n: 2 });
    buffer.push('a.jsonl', { n: 3 });
    expect(writes).toEqual([]);
    buffer.flush();
    expect(writes).toEqual([['a.jsonl', '{"n":1}\n{"n":3}\n'], ['b.jsonl', '{"n":2}\n']]);
    buffer.flush();
    expect(writes).toHaveLength(2);
  });
});

describe('token minting outside timed regions', () => {
  it('mints only in ensureFresh; current() never mints and refuses before the first mint', async () => {
    let mono = 0;
    let mints = 0;
    const source = makeTokenSource({ mint: async () => `token-${++mints}`, now: () => mono, maxAgeMs: 1000 });
    expect(() => source.current()).toThrow(/not minted/);
    await source.ensureFresh();
    await source.ensureFresh();
    expect(mints).toBe(1);
    mono = 999;
    expect(source.current()).toBe('token-1');
    mono = 1001;
    expect(source.current()).toBe('token-1');
    expect(mints).toBe(1);
    await source.ensureFresh();
    expect(source.current()).toBe('token-2');
  });
  it('reports a token that aged past its window instead of silently using it', async () => {
    let mono = 0;
    const stale = [];
    const source = makeTokenSource({ mint: async () => 'token', now: () => mono, maxAgeMs: 1000, staleAfterMs: 2000, onStale: event => stale.push(event) });
    await source.ensureFresh();
    mono = 2500;
    expect(source.current()).toBe('token');
    expect(stale).toEqual([{ type: 'token-stale', ageMs: 2500 }]);
  });
});

describe('environment signals', () => {
  it('flags a wall-clock jump the monotonic clock did not see (host sleep) and event-loop stalls', () => {
    let wall = 0; let mono = 0;
    const events = [];
    const monitor = startEnvironmentMonitor({ emit: e => events.push(e), wall: () => wall, mono: () => mono, gapMs: 2000, intervalMs: 0 });
    wall = 1000; mono = 1000; monitor.sample();
    expect(events).toEqual([]);
    wall = 600_000; mono = 2000; monitor.sample();
    expect(events).toEqual([expect.objectContaining({ type: 'clock-gap', wallDeltaMs: 599_000, monoDeltaMs: 1000 })]);
    wall = 610_000; mono = 12_000; monitor.sample();
    expect(events[1]).toMatchObject({ type: 'loop-stall', monoDeltaMs: 10_000 });
    expect(monitor.loopDelay()).toEqual(expect.objectContaining({ maxMs: expect.any(Number), p99Ms: expect.any(Number) }));
    monitor.stop();
  });
  it('measures a TLS handshake and sends nothing after it', async () => {
    const writes = [];
    const connect = (options, onSecure) => {
      const socket = Object.assign(new EventEmitter(), { write: data => writes.push(data), destroy() { socket.destroyed = true; }, setTimeout() {} });
      expect(options).toMatchObject({ host: 'api.cohere.com', port: 443, servername: 'api.cohere.com', rejectUnauthorized: true });
      setImmediate(onSecure);
      return socket;
    };
    const ok = await tlsProbe('api.cohere.com', { connect });
    expect(ok).toMatchObject({ type: 'tls-probe', host: 'api.cohere.com', ok: true });
    expect(ok.ms).toBeGreaterThanOrEqual(0);
    expect(writes).toEqual([]);
    const failing = (_options, _onSecure) => {
      const socket = Object.assign(new EventEmitter(), { destroy() {}, setTimeout() {} });
      setImmediate(() => socket.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND api.cohere.com sk-x'), { code: 'ENOTFOUND' })));
      return socket;
    };
    const bad = await tlsProbe('api.cohere.com', { connect: failing });
    expect(bad).toMatchObject({ ok: false, error: { name: 'Error', code: 'ENOTFOUND' } });
    expect(JSON.stringify(bad)).not.toContain('sk-x');
  });
  it('refuses to probe a host outside the fixed provider set', async () => {
    await expect(tlsProbe('evil.example', { connect: () => { throw new Error('must not connect'); } })).rejects.toThrow(/provider host/);
  });
});

describe('descriptive latency breakdown', () => {
  it('separates clean from degraded calls and summarizes stage spans without touching the gate', () => {
    const rows = [
      { recalls: [
        { ms: 400, ok: true, degraded: [], spans: [{ hook: 'embeddings:embed', ms: 120 }, { hook: 'embeddings:rerank', ms: 200 }] },
        { ms: 3500, ok: true, degraded: ['semantic', 'ranking'], spans: [{ hook: 'embeddings:embed', ms: 2400 }, { hook: 'embeddings:rerank', ms: 2100 }] },
      ] },
      { recalls: [{ ms: 500, ok: true, degraded: [] }, { ms: 90, ok: false, error: { name: 'Error' } }] },
    ];
    expect(latencyBreakdown(rows)).toEqual({
      cleanCalls: 2, degradedCalls: 1, cleanP95Ms: 500, degradedP95Ms: 3500,
      stages: { 'embeddings:embed': { n: 2, p95Ms: 2400 }, 'embeddings:rerank': { n: 2, p95Ms: 2100 } },
    });
  });
});

