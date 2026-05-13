export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  label: string;
  log?: (msg: string) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: unknown;
  const log = opts.log ?? ((m) => console.warn(m));
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === opts.attempts - 1) throw err;
      const delay = opts.baseDelayMs * Math.pow(2, i);
      log(`${opts.label}: retrying after ${delay}ms (attempt ${i + 1}/${opts.attempts}); reason: ${describeError(err)}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export function isTransient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; status?: unknown; name?: unknown; cause?: unknown };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const TRANSIENT_CODES = new Set([
    'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  ]);
  if (code && TRANSIENT_CODES.has(code)) return true;
  const status = typeof e.status === 'number' ? e.status : undefined;
  if (status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500 && status < 600)) {
    return true;
  }
  const name = typeof e.name === 'string' ? e.name : '';
  if (/Timeout|Connection|Network|FetchError/i.test(name)) return true;
  if (e.cause !== undefined) return isTransient(e.cause);
  return false;
}

export function describeError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as { name?: unknown; code?: unknown; message?: unknown; status?: unknown };
  return [e.name, e.code, e.status, e.message].filter((v) => v !== undefined && v !== '').join(' ');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
