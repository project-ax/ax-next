// Diagnostics for the memory-product benchmark (TASK-521).
//
// TASK-497's run failed its recall-latency target, and the frozen harness could not
// say why: no per-stage timing, no wall clock (the timeline was rebuilt from file
// mtimes), no record of interrupted answer attempts, and no failure classes. Everything
// here exists to answer one of those questions in a FUTURE, separately identified run.
// None of it changes what is measured or how a gate is scored.
//
// What gets persisted is allowlisted on purpose. Provider errors can echo request
// content, and headers carry credentials, so a failure is reduced to identifiers we
// chose ourselves — never a message, a body, a header or a URL.

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';

// `withCorpusClock` replaces `globalThis.Date` while ingestion and answering run, so
// `Date.now()` inside those regions is the simulated corpus date. Bind the real
// constructor once, at import, before any swap can happen.
const RealDate = globalThis.Date;
export const realNow = () => RealDate.now();
export const monoNow = () => performance.now();

const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError',
  'ProviderError', 'BudgetExceeded', 'PluginError', 'ObserverTimeoutError',
]);
const ERROR_CODES = new Set([
  // Node / libuv socket and DNS failures.
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EPIPE', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOENT', 'ABORT_ERR',
  // undici (global fetch).
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_CLOSED',
  // TLS verification.
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER',
  // `PluginError` codes raised by `@ax/core`'s hook bus.
  'timeout', 'invalid-payload', 'invalid-return', 'no-service', 'missing-service', 'rejected', 'forbidden', 'unknown',
]);

function classify(error) {
  if (!(error instanceof Error) && !(typeof DOMException !== 'undefined' && error instanceof DOMException)) return { name: 'non-error' };
  const out = { name: ERROR_NAMES.has(error.name) ? error.name : 'other' };
  // String codes only: `DOMException` carries a legacy numeric `code` that says nothing `name` does not.
  if (typeof error.code === 'string') out.code = ERROR_CODES.has(error.code) ? error.code : 'other';
  if (Number.isSafeInteger(error.status) && error.status >= 100 && error.status <= 599) out.status = error.status;
  return out;
}

/** A failure reduced to allowlisted identifiers, plus one level of `cause`. */
export function sanitizeError(error) {
  const out = classify(error);
  if (out.name !== 'non-error' && error.cause !== undefined) out.cause = classify(error.cause);
  return out;
}

const attemptFile = (arm, n) => `answer-${arm}.attempt-${n}.jsonl`;

/**
 * An append-only log for ONE answer attempt. Each event is written the moment it
 * happens, so a process that dies mid-answer still leaves its tool activity behind.
 * The file is created exclusively (`wx`): a resume starts attempt N+1 and never
 * rewrites what an earlier attempt recorded.
 */
export function openAttemptLog(bankRoot, arm, context) {
  const pattern = new RegExp(`^answer-${arm}\\.attempt-(\\d+)\\.jsonl$`);
  const taken = readdirSync(bankRoot).map(name => pattern.exec(name)?.[1]).filter(Boolean).map(Number);
  const attempt = taken.length ? Math.max(...taken) + 1 : 1;
  const path = join(bankRoot, attemptFile(arm, attempt));
  let seq = 0;
  const line = event => JSON.stringify({ ...event, seq: seq++, at: realNow(), mono: monoNow() }) + '\n';
  writeFileSync(path, line({ type: 'attempt-start', ...context, arm, attempt, pid: process.pid }), { flag: 'wx', mode: 0o600 });
  return { attempt, path, write(event) { appendFileSync(path, line(event)); } };
}

/**
 * Per arm: how many attempts ended, failed, or simply stopped (the process died with
 * no terminal event), and how many tool calls happened outside completed attempts.
 * Those calls are NOT in the recall metrics — which cover completed captures only —
 * so the report shows them on their own line.
 */
export function attemptStats(runDirectory) {
  const stats = {};
  for (const bank of readdirSync(runDirectory)) {
    const bankRoot = join(runDirectory, bank);
    if (!statSync(bankRoot).isDirectory()) continue;
    for (const name of readdirSync(bankRoot)) {
      const match = /^answer-([a-z]+)\.attempt-\d+\.jsonl$/.exec(name);
      if (!match) continue;
      // A process killed mid-append leaves a torn last line. That is exactly the case
      // this log exists for, so an unreadable line is counted, never fatal — one torn
      // file must not stop every later report in the run from rendering.
      const events = [];
      let unreadable = 0;
      for (const line of readFileSync(join(bankRoot, name), 'utf8').split('\n').filter(Boolean)) {
        try { events.push(JSON.parse(line)); } catch { unreadable += 1; }
      }
      const arm = (stats[match[1]] ??= { attempts: 0, complete: 0, failed: 0, interrupted: 0, toolCallsOutsideCompleted: 0 });
      if (unreadable) arm.unreadableLines = (arm.unreadableLines ?? 0) + unreadable;
      arm.attempts += 1;
      const complete = events.some(e => e.type === 'attempt-complete');
      if (complete) arm.complete += 1;
      else if (events.some(e => e.type === 'attempt-failed')) arm.failed += 1;
      else arm.interrupted += 1;
      if (!complete) arm.toolCallsOutsideCompleted += events.filter(e => e.type === 'tool').length;
    }
  }
  return stats;
}

/**
 * A credential minted OUTSIDE timed regions. The frozen harness minted the Vertex
 * token lazily inside `credentials:get` with a synchronous `gcloud` spawn, so on a
 * resumed bank the first timed recall paid for that spawn and blocked the event loop
 * while the product's embed budget timer ran. Here only `ensureFresh` mints, and the
 * harness calls it between sessions and before each answer attempt.
 */
export function makeTokenSource({ mint, now = monoNow, maxAgeMs = 45 * 60_000, staleAfterMs = 55 * 60_000, onStale = () => {} }) {
  let token;
  let mintedAt = -Infinity;
  return {
    async ensureFresh() {
      if (token !== undefined && now() - mintedAt <= maxAgeMs) return;
      token = await mint();
      mintedAt = now();
    },
    current() {
      if (token === undefined) throw new Error('Credential was not minted before the timed region');
      const ageMs = now() - mintedAt;
      if (ageMs > staleAfterMs) onStale({ type: 'token-stale', ageMs });
      return token;
    },
  };
}

/**
 * Two cheap environment signals, sampled on a timer:
 * - `clock-gap`: the wall clock moved much more than the monotonic one. On macOS the
 *   monotonic clock does not advance while the host sleeps, so this is how a sleeping
 *   laptop shows up — the late-window question from TASK-497.
 * - `loop-stall`: the sampler itself ran late, i.e. something blocked the event loop.
 * Event-loop delay percentiles come from Node's own histogram.
 */
export function startEnvironmentMonitor({ emit, wall = realNow, mono = monoNow, gapMs = 2000, intervalMs = 1000 }) {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let lastWall = wall();
  let lastMono = mono();
  const sample = () => {
    const w = wall(); const m = mono();
    const wallDeltaMs = w - lastWall; const monoDeltaMs = m - lastMono;
    lastWall = w; lastMono = m;
    if (wallDeltaMs - monoDeltaMs > gapMs) emit({ type: 'clock-gap', at: w, wallDeltaMs, monoDeltaMs });
    else if (monoDeltaMs > intervalMs + gapMs) emit({ type: 'loop-stall', at: w, monoDeltaMs });
  };
  const timer = intervalMs > 0 ? setInterval(sample, intervalMs) : undefined;
  timer?.unref();
  return {
    sample,
    loopDelay() {
      const ms = ns => Math.round(ns / 1e4) / 100;
      const snapshot = { maxMs: ms(histogram.max), p99Ms: ms(histogram.percentile(99)), meanMs: Number.isFinite(histogram.mean) ? ms(histogram.mean) : 0 };
      histogram.reset();
      return snapshot;
    },
    stop() { if (timer) clearInterval(timer); histogram.disable(); },
  };
}

/**
 * Diagnostic events are held in memory and written only at untimed boundaries. A
 * provider span is produced while a recall is still being timed, and a synchronous
 * append there would add our own disk I/O to the number we are trying to explain —
 * the same class of artifact as the synchronous token mint this card removed.
 *
 * Not everything can be moved out: the spending ledger still appends each reservation
 * and settlement synchronously inside a recall (~4 small writes per clean recall), as
 * the frozen harness did, because a buffered reservation could let a crash-restart
 * overspend the cap. That cost is identical across arms and runs.
 */
export function makeDiagnosticsBuffer(write = appendFileSync) {
  const pending = new Map();
  return {
    push(path, event) { if (!pending.has(path)) pending.set(path, []); pending.get(path).push(JSON.stringify(event) + '\n'); },
    flush() {
      // Clear each sink as it is written, so a failing write does not make a retry
      // duplicate the sinks that already succeeded.
      for (const [path, lines] of pending) { write(path, lines.join('')); pending.delete(path); }
    },
  };
}

/** The run-level diagnostic sinks, both buffered. `main` flushes them at untimed boundaries. */
export function makeDiagnosticsSinks(directory, write) {
  const buffer = makeDiagnosticsBuffer(write);
  const environmentPath = join(directory, 'environment.jsonl');
  const providerSpansPath = join(directory, 'provider-spans.jsonl');
  return {
    recordEnvironment: event => buffer.push(environmentPath, { at: realNow(), ...event }),
    recordProviderSpan: span => buffer.push(providerSpansPath, span),
    flush: () => buffer.flush(),
  };
}

/** The only hosts a benchmark run talks to; the probe refuses anything else. */
export const PROVIDER_HOSTS = Object.freeze(['us-central1-aiplatform.googleapis.com', 'api.cohere.com', 'openrouter.ai', 'api.anthropic.com']);

/**
 * Time a TLS handshake to a provider host, then close. No request is written and no
 * credential is involved, so it costs nothing. It separates "our network is slow"
 * from "the provider is slow" when read beside the per-request spans.
 */
export function tlsProbe(host, { connect = tlsConnect, timeoutMs = 5000 } = {}) {
  if (!PROVIDER_HOSTS.includes(host)) return Promise.reject(new Error('Refusing to probe a host outside the fixed provider host set'));
  const start = monoNow();
  return new Promise(resolveProbe => {
    let done = false;
    let socket;
    const finish = result => {
      if (done) return;
      done = true;
      socket?.destroy();
      resolveProbe({ type: 'tls-probe', host, at: realNow(), ms: monoNow() - start, ...result });
    };
    socket = connect({ host, port: 443, servername: host, rejectUnauthorized: true }, () => finish({ ok: true }));
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: { name: 'TimeoutError' } }));
    socket.on('error', error => finish({ ok: false, error: sanitizeError(error) }));
  });
}

/** Nearest-rank p95 — the ONE implementation; the gate in `memory-product-e2e-lib.mjs` re-exports it. */
export function percentile95(values) {
  if (values.length === 0) return null;
  if (values.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid latency sample');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

/**
 * Descriptive only. The p95 gate stays defined over ALL calls; this shows how much of
 * it the degraded calls and each stage account for.
 */
export function latencyBreakdown(rows) {
  const calls = rows.flatMap(row => row.recalls ?? []).filter(call => call.ok);
  const degraded = calls.filter(call => Array.isArray(call.degraded) && call.degraded.length > 0);
  const clean = calls.filter(call => !degraded.includes(call));
  const stages = {};
  for (const span of calls.flatMap(call => call.spans ?? [])) (stages[span.hook] ??= []).push(span.ms);
  return {
    cleanCalls: clean.length, degradedCalls: degraded.length,
    cleanP95Ms: percentile95(clean.map(c => c.ms)), degradedP95Ms: percentile95(degraded.map(c => c.ms)),
    stages: Object.fromEntries(Object.entries(stages).sort().map(([hook, ms]) => [hook, { n: ms.length, p95Ms: percentile95(ms) }])),
  };
}

