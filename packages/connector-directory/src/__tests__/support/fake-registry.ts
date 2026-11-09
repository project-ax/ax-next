/**
 * A fake registry behind an injected `fetchImpl`: no test in this package
 * reaches the network. Each call is recorded (URL and init), then answered by
 * the test's handler. Modeled on `stub(pages)` in
 * packages/llm-anthropic/src/__tests__/models-available.test.ts.
 */

export interface FakeRegistry {
  fetchImpl: typeof fetch;
  /** Every request's URL, in order. */
  requests: URL[];
  /** Every request's init, in order. */
  inits: RequestInit[];
}

export function createFakeRegistry(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): FakeRegistry {
  const requests: URL[] = [];
  const inits: RequestInit[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const recorded = init ?? {};
    requests.push(url);
    inits.push(recorded);
    return handler(url, recorded);
  }) as typeof fetch;
  return { fetchImpl, requests, inits };
}

/** One page of the registry's list answer (status 200, JSON). */
export function page(servers: unknown[], nextCursor?: string): Response {
  const metadata =
    nextCursor === undefined
      ? { count: servers.length }
      : { nextCursor, count: servers.length };
  return new Response(JSON.stringify({ servers, metadata }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Never answers on its own: rejects with the signal's reason once the request
 * is aborted, the way fetch does.
 */
export function waitForAbort(init: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (signal === undefined || signal === null) {
      reject(new Error('waitForAbort: the request carried no signal'));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
