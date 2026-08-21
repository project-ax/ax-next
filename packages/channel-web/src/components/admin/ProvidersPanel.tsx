import { CredentialSlotRow } from '../credentials/CredentialSlotRow';

// Mirrors the canonical PROVIDER_ENDPOINTS table in @ax/core (`name`,
// `credentialEnvVar`, `description`), which @ax/chat-orchestrator's
// KNOWN_PROVIDERS also derives from.
//
// Deliberately a hand-kept copy rather than an import: nothing under
// `components/` pulls in the kernel today, and dragging @ax/core into the
// browser bundle to save a handful of lines is the worse trade. The cost is
// this comment — when a provider is added to PROVIDER_ENDPOINTS, add its row
// here too, and the ProvidersPanel test will tell you if the two disagree.
const KNOWN_PROVIDERS = [
  {
    provider: 'anthropic' as const,
    name: 'Anthropic',
    slot: 'ANTHROPIC_API_KEY' as const,
    description: 'API key from console.anthropic.com.',
  },
  {
    provider: 'openrouter' as const,
    name: 'OpenRouter',
    slot: 'OPENROUTER_API_KEY' as const,
    description: 'API key from openrouter.ai/keys — one key, dozens of models.',
  },
] as const;

export function ProvidersPanel() {
  return (
    <div className="max-w-[640px] mx-auto font-sans">
      <div className="mb-5">
        <h2 className="text-2xl font-medium tracking-[-0.018em] mb-1.5">AI model keys</h2>
        <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
          Manage the API keys for the model providers wired into this deployment.
          Keys are encrypted at rest and never returned in plaintext.
        </p>
      </div>
      <div className="space-y-3">
        {KNOWN_PROVIDERS.map((p) => (
          <div key={p.provider} className="rounded-md border border-border p-4">
            <div className="font-medium mb-2">{p.name}</div>
            <CredentialSlotRow
              destination={{ kind: 'provider', provider: p.provider }}
              slot={{ label: p.slot, kind: 'api-key', description: p.description }}
              scope={{ scope: 'global', ownerId: null }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
