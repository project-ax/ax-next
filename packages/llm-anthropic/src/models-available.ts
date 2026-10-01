import { z, type ZodType } from 'zod';

/** Full model list for the admin catalog. Local copy of the contract (invariant 2: the hook bus is the API). */
export interface ModelsListAvailableOutput {
  status: 'live' | 'no-key' | 'error';
  models: Array<{ ref: string; label: string }>;
}

export const ModelsListAvailableOutputSchema = z.object({
  status: z.union([z.literal('live'), z.literal('no-key'), z.literal('error')]),
  models: z.array(z.object({ ref: z.string(), label: z.string() })),
}) as unknown as ZodType<ModelsListAvailableOutput>;

// Fixed URL + version, mirroring the provider-key validator's precedent. Not
// derived from ANTHROPIC_BASE_URL on purpose: this call carries the real key.
const MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';
const LIST_TIMEOUT_MS = 10_000;
const LIST_MAX_BYTES = 5 * 1024 * 1024;
const PAGE_SIZE = 1000;
const MAX_PAGES = 5;
const ERROR: ModelsListAvailableOutput = { status: 'error', models: [] };

/** Never throws, and never puts the key or an upstream error object in its result. */
export async function fetchAnthropicModels(
  fetchImpl: typeof fetch,
  apiKey: string,
): Promise<ModelsListAvailableOutput> {
  const models: ModelsListAvailableOutput['models'] = [];
  let afterId: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = `${MODELS_URL}?limit=${PAGE_SIZE}${afterId !== undefined ? `&after_id=${encodeURIComponent(afterId)}` : ''}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), LIST_TIMEOUT_MS);
      let body: { data?: unknown; has_more?: unknown; last_id?: unknown };
      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
          signal: ctrl.signal,
        });
        if (!res.ok) return ERROR;
        const buf = await res.arrayBuffer();
        if (buf.byteLength > LIST_MAX_BYTES) return ERROR;
        body = JSON.parse(new TextDecoder().decode(buf)) as typeof body;
      } finally {
        clearTimeout(timer);
      }
      if (!Array.isArray(body.data)) return ERROR;
      for (const item of body.data) {
        if (typeof item !== 'object' || item === null) continue;
        const { id, display_name: displayName } = item as { id?: unknown; display_name?: unknown };
        if (typeof id !== 'string' || id.length === 0) continue;
        models.push({
          ref: `anthropic/${id}`,
          label: typeof displayName === 'string' && displayName.length > 0 ? displayName : id,
        });
      }
      if (body.has_more === true && typeof body.last_id === 'string') {
        afterId = body.last_id;
        continue;
      }
      break;
    }
    return { status: 'live', models };
  } catch {
    return ERROR; // deliberately drops the error: it could echo request details
  }
}
