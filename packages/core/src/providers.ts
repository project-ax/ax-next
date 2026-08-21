// Model-call provider endpoints — the one table both sides of the sandbox
// boundary read. See docs/plans/2026-08-18-provider-agnostic-runner-design.md
// §6.
//
// Two independent decisions have to agree on the same facts about a
// provider, and they're made on opposite sides of the sandbox wall:
//
//   - The HOST orchestrator decides which hostname to put on the sandbox's
//     egress allow-list and which credential to mint an `ax-cred:<32-hex>`
//     placeholder for, before the sandbox ever opens.
//   - The IN-SANDBOX runner decides which base URL to dial and which env
//     var holds that placeholder, once it's running.
//
// If those two ever drift — say, the host allow-lists `api.anthropic.com`
// but a runner change points the SDK at a different host — the failure
// shows up as a MITM proxy 403 deep inside a model call. Nothing about that
// error mentions "the two providers.ts tables disagree," because there were
// never two tables to compare. This module exists so there's exactly one:
// import it from both sides and the drift class can't occur.
//
// Sharing the constant does NOT weaken the boundary. The runner cannot
// grant itself egress by editing its copy of this file, because there is no
// copy — and even so, the credential-proxy's allow-list check is still the
// thing that enforces reachability at request time. The host never trusts
// the runner's claim about where it's dialing; it trusts its own
// `proxy:add-host` call, made from this same table. This module only
// removes the chance that the two sides quietly stop agreeing about what
// the table says.

/**
 * Everything needed to reach one LLM provider's API from inside a sandbox,
 * and everything the host needs to authorize that reach.
 */
export interface ProviderEndpoint {
  /** Provider id — the first segment of a `provider/model-id` ref. */
  id: string;
  /** Human label for admin surfaces. */
  name: string;
  /** One line for the admin Providers panel. */
  description: string;
  /** Base URL the model call is made against. */
  baseUrl: string;
  /** Hostname the sandbox egress allow-list must permit. */
  egressHost: string;
  /** Env var carrying the `ax-cred:<32-hex>` placeholder inside the sandbox. */
  credentialEnvVar: string;
  /** Credential-store ref. */
  credentialRef: string;
}

export const PROVIDER_ENDPOINTS: Readonly<Record<string, ProviderEndpoint>> =
  Object.freeze({
    anthropic: Object.freeze({
      id: 'anthropic',
      name: 'Anthropic',
      // Exact wording of chat-orchestrator's KNOWN_PROVIDERS — T5 derives
      // that table from this one and the strings must match byte-for-byte.
      description: 'API key from console.anthropic.com.',
      baseUrl: 'https://api.anthropic.com/v1',
      egressHost: 'api.anthropic.com',
      credentialEnvVar: 'ANTHROPIC_API_KEY',
      credentialRef: 'provider:anthropic',
    }),
    openrouter: Object.freeze({
      id: 'openrouter',
      name: 'OpenRouter',
      description: 'API key from openrouter.ai/keys — one key, dozens of models.',
      baseUrl: 'https://openrouter.ai/api/v1',
      egressHost: 'openrouter.ai',
      credentialEnvVar: 'OPENROUTER_API_KEY',
      credentialRef: 'provider:openrouter',
    }),
  });

/**
 * Look up a provider endpoint by id. `providerId` is user-controllable —
 * it comes from an agent row's `model` field (`parseModelRef(...).provider`)
 * — so this uses an own-property check rather than plain property access.
 * Without it, a crafted ref like `constructor/foo` or `__proto__/foo` would
 * resolve through `Object.prototype` to a function or the prototype object
 * instead of `undefined`, and callers treat any non-`undefined` result as a
 * real endpoint.
 */
export function providerEndpointFor(
  providerId: string,
): ProviderEndpoint | undefined {
  return Object.prototype.hasOwnProperty.call(PROVIDER_ENDPOINTS, providerId)
    ? PROVIDER_ENDPOINTS[providerId]
    : undefined;
}
