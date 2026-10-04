/**
 * A bounded, redacted tail of the runner's stderr (TASK-784).
 *
 * When a runner dies before it can say anything over IPC — a boot-time env
 * error is the common case (`runner: invalid env: AX_PROXY_TOKEN …`, exit 2) —
 * its stderr is the only place the reason lives. We used to log every chunk at
 * debug only, so an operator saw nothing at the default level. Now the sandbox
 * keeps the LAST few KiB and logs them once, at warn, when the runner exits
 * non-zero.
 *
 * The runner is untrusted, so its stderr is untrusted text:
 *   - It is capped (STDERR_TAIL_MAX code units) — a chatty or hostile runner
 *     cannot balloon a host log line.
 *   - Secrets the HOST minted for this session (the IPC auth token, the proxy
 *     token) are replaced with `[redacted]` before the text leaves this module,
 *     in case the runner echoed its own environment.
 *   - It goes to the host log only. It is never sent to the browser; the
 *     orchestrator maps the exit to a fixed reason code instead.
 */

/** Most code units of runner stderr we log on a non-zero exit. */
export const STDERR_TAIL_MAX = 4096;

/**
 * Extra code units kept ahead of the tail while buffering. A secret split by
 * the trim point would otherwise leave a partial (un-redactable) secret at the
 * front of the buffer; we redact the whole buffer and then drop this slack, so
 * any fragment lives only in the part we throw away. Must be at least as long
 * as the longest secret — `createStderrTail` widens it if one is longer.
 */
const MIN_SLACK = 1024;

export const STDERR_REDACTED = '[redacted]';

export interface StderrTail {
  append(chunk: string): void;
  /** The capped, redacted tail. Empty string when the runner wrote nothing. */
  text(): string;
  /**
   * Redact this session's secrets from one chunk, for the per-chunk debug
   * line. Best-effort only: a secret split across two chunks is not matched
   * there (each half is logged on its own line). The warn tail has no such gap.
   */
  redact(chunk: string): string;
}

function redactAll(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(STDERR_REDACTED);
  return out;
}

/** Drop a leading lone low surrogate so a cut never splits a pair. */
function startOnCharBoundary(s: string): string {
  const first = s.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? s.slice(1) : s;
}

export function createStderrTail(
  secrets: readonly string[],
  max: number = STDERR_TAIL_MAX,
): StderrTail {
  const live = secrets.filter((s) => s.length > 0);
  const slack = Math.max(MIN_SLACK, ...live.map((s) => s.length));
  const keep = max + slack;
  let buf = '';
  let trimmed = false;
  return {
    append(chunk: string): void {
      buf += chunk;
      // Amortized trim: only cut once we are well past the window.
      if (buf.length > keep * 2) {
        buf = buf.slice(buf.length - keep);
        trimmed = true;
      }
    },
    text(): string {
      let window = buf;
      if (window.length > keep) {
        window = window.slice(window.length - keep);
        trimmed = true;
      }
      window = redactAll(window, live);
      // Once anything was dropped, the first `slack` units may hold the tail
      // end of a secret we could not match. Drop at least that much.
      if (trimmed) {
        window = window.slice(Math.min(slack, window.length));
      }
      if (window.length > max) window = window.slice(window.length - max);
      return startOnCharBoundary(window);
    },
    redact(chunk: string): string {
      return redactAll(chunk, live);
    },
  };
}
