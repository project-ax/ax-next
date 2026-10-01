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

const LIST_TIMEOUT_MS = 10_000;
const LIST_MAX_BYTES = 5 * 1024 * 1024;
const ERROR: ModelsListAvailableOutput = { status: 'error', models: [] };

/**
 * GET `${baseUrl}/models` (a fixed URL, never caller-supplied). The endpoint is
 * public; the key is sent anyway to match the plugin's other calls. Never
 * throws and never puts the key, or an upstream error object, in its result.
 */
export async function fetchOpenRouterModels(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
): Promise<ModelsListAvailableOutput> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return ERROR;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > LIST_MAX_BYTES) return ERROR;
    const body = JSON.parse(new TextDecoder().decode(buf)) as { data?: unknown };
    if (!Array.isArray(body.data)) return ERROR;
    const models: ModelsListAvailableOutput['models'] = [];
    for (const item of body.data) {
      if (typeof item !== 'object' || item === null) continue;
      const { id, name } = item as { id?: unknown; name?: unknown };
      if (typeof id !== 'string' || id.length === 0) continue;
      models.push({ ref: `openrouter/${id}`, label: typeof name === 'string' && name.length > 0 ? name : id });
    }
    return { status: 'live', models };
  } catch {
    return ERROR; // deliberately drops the error: it could echo request details
  } finally {
    clearTimeout(timer);
  }
}
