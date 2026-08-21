import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { createLlmOpenRouterPlugin, type ProviderValidationResult } from '../plugin.js';

// ---------------------------------------------------------------------------
// credentials:validate:openrouter — the pre-save key check.
//
// The contract is @ax/credentials-admin-routes' `validateProviderKey`: it
// dispatches `bus.call<{ key: Uint8Array }, ProviderValidationResult>(...)`,
// where the result is `{ok:true} | {ok:false, error:string}` and that `error`
// string is rendered verbatim into the operator's alert.
//
// The load-bearing property, though, is negative: the key the operator just
// pasted must not come back out. These tests assert it appears in NEITHER the
// resolved value NOR any thrown error, for every status class.
// ---------------------------------------------------------------------------

const KEY = 'sk-or-v1-supersecret-operator-key';
const KEY_BYTES = new TextEncoder().encode(KEY);

interface Recorded {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

function stubFetch(
  respond: () => Response | Promise<Response>,
  calls: Recorded[] = [],
): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(input), method: init?.method, headers });
    return await respond();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function validate(
  fetchImpl: typeof fetch,
): Promise<{ result: ProviderValidationResult; thrown: unknown }> {
  const plugin = createLlmOpenRouterPlugin({ apiKey: 'boot-key', fetchImpl });
  const bus = new HookBus();
  await plugin.init({ bus, config: {} });
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
  try {
    const result = await bus.call<{ key: Uint8Array }, ProviderValidationResult>(
      'credentials:validate:openrouter',
      ctx,
      { key: KEY_BYTES },
    );
    return { result, thrown: undefined };
  } catch (e) {
    return { result: { ok: false, error: 'threw' }, thrown: e };
  }
}

describe('@ax/llm-openrouter credentials:validate:openrouter', () => {
  it('GETs {baseUrl}/key with the Bearer key', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response('{}', { status: 200 }));
    await validate(fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/key');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('maps 200 to ok', async () => {
    const { fetchImpl } = stubFetch(() => new Response('{"data":{"label":"x"}}', { status: 200 }));
    const { result } = await validate(fetchImpl);
    expect(result).toEqual({ ok: true });
  });

  it('maps 401 to a not-ok result with a readable reason', async () => {
    const { fetchImpl } = stubFetch(() => new Response('nope', { status: 401 }));
    const { result } = await validate(fetchImpl);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error.length).toBeGreaterThan(0);
    // Plain language for the operator's alert, not a machine code.
    expect((result as { error: string }).error).toMatch(/key/i);
  });

  it('maps 403 to a not-ok result too', async () => {
    const { fetchImpl } = stubFetch(() => new Response('nope', { status: 403 }));
    const { result } = await validate(fetchImpl);
    expect(result.ok).toBe(false);
  });

  it('maps 500 to a not-ok result distinct from the rejected-key one', async () => {
    const { fetchImpl: f401 } = stubFetch(() => new Response('', { status: 401 }));
    const { fetchImpl: f500 } = stubFetch(() => new Response('', { status: 500 }));
    const rejected = await validate(f401);
    const transient = await validate(f500);
    expect(transient.result.ok).toBe(false);
    expect((transient.result as { error: string }).error).not.toBe(
      (rejected.result as { error: string }).error,
    );
  });

  it('maps a transport failure to a not-ok result rather than throwing', async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const { result, thrown } = await validate(fetchImpl);
    expect(thrown).toBeUndefined();
    expect(result.ok).toBe(false);
  });

  it('never returns or throws the key, for any status', async () => {
    // 200 / 401 / 500 / transport blowup / a hostile body that echoes the key
    // back at us — none of these may put the secret in the result or an error.
    const scenarios: Array<() => Response> = [
      () => new Response('{}', { status: 200 }),
      () => new Response(`{"error":"bad key ${KEY}"}`, { status: 401 }),
      () => new Response(`{"error":"boom ${KEY}"}`, { status: 500 }),
      () => {
        throw new Error(`connect failed while sending ${KEY}`);
      },
    ];
    for (const respond of scenarios) {
      const { fetchImpl } = stubFetch(respond);
      const { result, thrown } = await validate(fetchImpl);
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(serialise(thrown)).not.toContain(KEY);
    }
  });
});

/** Flatten an error (message, stack, own props, cause) into one string. */
function serialise(e: unknown): string {
  if (e === undefined) return '';
  if (e instanceof Error) {
    return [
      e.message,
      e.stack ?? '',
      JSON.stringify(e, Object.getOwnPropertyNames(e)),
      e.cause instanceof Error ? e.cause.message : String(e.cause ?? ''),
    ].join('\n');
  }
  return String(e);
}
