// ---------------------------------------------------------------------------
// One MITM tunnel to a metered host (TASK-715).
//
// Ties the two halves of the byte path to the session's `ProviderMeter`:
//
//   client -> upstream   the request framer asks `onRequestHead` about every
//                        request head; this decides whether the credential may
//                        be spliced in (allowed endpoint + gate said yes),
//                        whether the head goes out plain (placeholder inert),
//                        or whether the request is refused.
//   upstream -> client   `onResponseBytes` feeds a passive ResponseTap that
//                        reads usage; each finished response settles the
//                        request it answers.
//
// The unit of accounting is the request the FRAMER admitted. `outstanding` is a
// FIFO of them, in the order they were sent; HTTP/1.1 answers in order, so the
// nth response settles the nth request. Whatever is still outstanding when the
// tunnel ends is settled as unanswered (billable, estimated by the meter): an
// aborted stream, a desynced response or a dropped connection can therefore
// never make a spliced request free.
// ---------------------------------------------------------------------------

import type { ProviderCallSettlement, ProviderMeter } from './provider-usage.js';
import type { MeteredRequestPolicy, RequestHeadInfo, RequestVerdict } from './request-framer.js';
import { ResponseTap, type ResponseMeta, type TapResponse } from './response-tap.js';

/** `/*` in a pattern: exactly one more segment of these characters, never `/`, `%` or a leading dot. */
const WILDCARD_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** The path of an origin-form request target: everything before `?` or `#`. */
function pathOf(target: string): string {
  const cut = target.search(/[?#]/);
  return cut < 0 ? target : target.slice(0, cut);
}

/**
 * Does `METHOD path` match one of `"METHOD /path"` patterns? The method is
 * compared exactly and the path exactly (no normalisation, no decoding, so
 * `/v1/messages/../batches`, `%2e%2e`, a trailing slash or `;params` are all
 * simply not the allowed path); a trailing `/*` allows exactly one more
 * conservative segment. Only an origin-form target (`/...`) can match.
 */
export function requestAllowed(method: string, target: string, patterns: readonly string[]): boolean {
  if (!target.startsWith('/')) return false;
  const path = pathOf(target);
  for (const pattern of patterns) {
    const space = pattern.indexOf(' ');
    if (space < 0 || pattern.slice(0, space) !== method) continue;
    const allowed = pattern.slice(space + 1);
    if (allowed.endsWith('/*')) {
      const prefix = allowed.slice(0, -1); // keeps the trailing '/'
      if (path.startsWith(prefix) && WILDCARD_SEGMENT.test(path.slice(prefix.length))) return true;
    } else if (allowed === path) {
      return true;
    }
  }
  return false;
}

/** No honest client has more than a handful of requests unanswered on one connection. */
const MAX_OUTSTANDING = 256;

interface Outstanding {
  method: string;
  path: string;
  /** True when the gate admitted it (a slot is held and `settle` is owed). */
  admitted: boolean;
  requestBytes: number | null;
}

/** A call that costs nothing however it ends: reads, and token counting. */
/**
 * Compressed bytes stand for about this many raw ones (English JSON gzips 3-5x);
 * over-counting a body we could not read is the safe direction.
 */
const ENCODED_EXPANSION = 4;

function partialOf(r: TapResponse, meta: ResponseMeta): { bytes: number; streamed: boolean } {
  return r.encoded
    ? { bytes: meta.bodyBytes * ENCODED_EXPANSION, streamed: false }
    : { bytes: meta.bodyBytes, streamed: meta.streamed };
}

function isFree(o: Outstanding): boolean {
  return o.method === 'GET' || o.path.endsWith('/count_tokens');
}

export class MeteredTunnel implements MeteredRequestPolicy {
  private readonly outstanding: Outstanding[] = [];
  private readonly tap: ResponseTap;
  private ended = false;

  constructor(private readonly meter: ProviderMeter) {
    this.tap = new ResponseTap({
      peekMethod: () => this.outstanding[0]?.method,
      onResponse: (r, meta) => this.answered(r, meta),
    });
  }

  onRequestHead(info: RequestHeadInfo): RequestVerdict {
    // Never track a request after the tunnel has ended: it would take a slot that no
    // `end()` is left to give back.
    if (this.ended) {
      return { kind: 'deny', status: 429, reason: 'busy', message: 'This connection has closed.' };
    }
    const path = pathOf(info.target);
    const requestBytes = info.contentLength;
    // A folded head cannot be forced to an unencoded response, so it never carries the
    // key: an encoded answer to a keyed request would be unreadable.
    const spliceable =
      info.version === 'HTTP/1.1' &&
      !info.folded &&
      requestAllowed(info.method, info.target, this.meter.requests);
    // A client that pipelines request after request without reading a response
    // must not grow this list without bound.
    if (this.outstanding.length >= MAX_OUTSTANDING) {
      return {
        kind: 'deny',
        status: 429,
        reason: 'busy',
        message: 'Too many requests are waiting for an answer on this connection.',
      };
    }
    if (!spliceable) {
      // Not a model call: the head goes out with the placeholder inert. It is
      // still tracked, only so its response lines up with the right request.
      this.outstanding.push({ method: info.method, path, admitted: false, requestBytes });
      return { kind: 'plain' };
    }
    const admit = this.meter.admit();
    if (!admit.ok) {
      return { kind: 'deny', status: 429, reason: admit.reason, message: admit.message };
    }
    this.outstanding.push({ method: info.method, path, admitted: true, requestBytes });
    return { kind: 'splice' };
  }

  /** Upstream -> client bytes, exactly as forwarded. Observes only; never throws. */
  onResponseBytes(chunk: Buffer): void {
    if (this.ended) return;
    try {
      this.tap.push(chunk);
    } catch {
      /* the tap is passive: a failure here must never touch the traffic */
    }
  }

  /** The tunnel is over. Settles every admitted request that never got an answer. */
  end(): void {
    if (this.ended) return;
    try {
      this.tap.end(); // may report a close-delimited or truncated response
    } catch {
      /* passive */
    }
    this.ended = true;
    for (const o of this.outstanding.splice(0)) {
      if (o.admitted) this.settle(o, undefined);
    }
  }

  private answered(r: TapResponse, meta: ResponseMeta): void {
    const o = this.outstanding.shift();
    // No request outstanding: a response to something the framer never saw (the
    // tail of a chunked request). No credential was spliced into it.
    if (o === undefined || !o.admitted) return;
    this.settle(o, r, meta);
  }

  private settle(o: Outstanding, r: TapResponse | undefined, meta?: ResponseMeta): void {
    let settlement: ProviderCallSettlement;
    if (isFree(o) || (r !== undefined && r.status >= 400)) {
      settlement = { billable: false, usage: null, requestBytes: o.requestBytes };
    } else {
      settlement = {
        billable: true,
        ...(r?.model !== undefined ? { model: r.model } : {}),
        // Nothing read (aborted, encoded, desynced, unanswered) is billable
        // with usage null: the meter charges an estimate, never zero.
        usage: r?.usage ?? null,
        requestBytes: o.requestBytes,
        // A response that ended early, or that arrived whole but could not be read (encoded,
        // or no counter in it), still tells how much was generated: by its size. Without
        // this, the counters being the last thing in a response would make hanging up just
        // before them, or a body the meter cannot read, cost almost nothing.
        ...(r !== undefined && meta !== undefined && (!r.complete || r.usage === null)
          ? { partial: partialOf(r, meta) }
          : {}),
      };
    }
    try {
      this.meter.settle(settlement);
    } catch {
      /* a meter that throws must not break the tunnel */
    }
  }
}
