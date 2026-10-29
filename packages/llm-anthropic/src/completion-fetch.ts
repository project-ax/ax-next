import { capResponseBody } from '@ax/core/response-cap';

// Match the host OpenRouter completion/error budgets. Host callers ordinarily
// ask for 4,096 output tokens; 4 MiB leaves room for long text and reasoning.
// Error bodies need only a short diagnostic. Count decompressed bytes before
// the SDK buffers/decodes them; Content-Length is only an early refusal.
export const MAX_COMPLETION_BYTES = 4 * 1024 * 1024;
export const MAX_ERROR_BYTES = 64 * 1024;

export function capCompletionFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    return capResponseBody(response, response.ok ? MAX_COMPLETION_BYTES : MAX_ERROR_BYTES);
  };
}
