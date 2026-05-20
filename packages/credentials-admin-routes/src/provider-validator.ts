import type { AgentContext, HookBus } from '@ax/core';

// ---------------------------------------------------------------------------
// Provider API key pre-save validation.
//
// Shared by both /admin/credentials/providers/:id/validate (legacy route)
// and /admin/destinations/provider/credential (destination-first route).
// The job is the same in both places: hit the provider's API with the key
// before we persist it, so we never silently store a key that won't work.
//
// Delegation order:
//   1. If a `credentials:validate:<providerId>` service is registered on the
//      bus, call it. Plugins can register a custom validator (e.g., a
//      future @ax/credentials-validator-openrouter package). This is the
//      extension point — keep the route handlers slim, push provider
//      knowledge into the plugin that owns the provider.
//   2. Otherwise, fall back to built-in logic. Today: Anthropic only.
//   3. Otherwise, return `{ok:false, error:'validation not supported for
//      this provider'}` — surface as 422 so the operator knows the save
//      was rejected for a real reason, not just a misconfig.
//
// Test seams: pass `fetchImpl` and `timeoutMs` to skip real network calls
// without resorting to global-fetch monkey-patching.
// ---------------------------------------------------------------------------

const ANTHROPIC_VALIDATION_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VALIDATION_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ValidateProviderKeyDeps {
  bus: HookBus;
  ctx: AgentContext;
  providerId: string;
  keyBytes: Uint8Array;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type ProviderValidationResult =
  | { ok: true }
  | { ok: false; error: string };

export async function validateProviderKey(
  deps: ValidateProviderKeyDeps,
): Promise<ProviderValidationResult> {
  const validateService = `credentials:validate:${deps.providerId}`;
  if (deps.bus.hasService(validateService)) {
    return await deps.bus.call<{ key: Uint8Array }, ProviderValidationResult>(
      validateService,
      deps.ctx,
      { key: deps.keyBytes },
    );
  }

  if (deps.providerId === 'anthropic') {
    return await validateAnthropicKey(
      deps.keyBytes,
      deps.fetchImpl,
      deps.timeoutMs,
    );
  }

  return { ok: false, error: 'validation not supported for this provider' };
}

async function validateAnthropicKey(
  keyBytes: Uint8Array,
  fetchImpl?: typeof fetch,
  timeoutMs?: number,
): Promise<ProviderValidationResult> {
  const fetchFn = fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // The Anthropic API expects the key as a UTF-8 header value. We decode
  // here rather than retaining a string at the call site so the bytes are
  // dropped as soon as this function returns.
  const keyString = Buffer.from(keyBytes).toString('utf8');
  try {
    const r = await fetchFn(ANTHROPIC_VALIDATION_URL, {
      method: 'GET',
      headers: {
        'x-api-key': keyString,
        'anthropic-version': ANTHROPIC_VALIDATION_VERSION,
      },
      signal: ctrl.signal,
    });
    if (r.status === 200) return { ok: true };
    if (r.status === 401 || r.status === 403) {
      return { ok: false, error: 'key-rejected' };
    }
    return { ok: false, error: 'validation-failed' };
  } catch {
    if (ctrl.signal.aborted) {
      return { ok: false, error: 'validation-timeout' };
    }
    return { ok: false, error: 'validation-failed' };
  } finally {
    clearTimeout(timer);
  }
}
