import { CredentialSlotRow } from '../credentials/CredentialSlotRow';

// Mirrors the canonical list in @ax/chat-orchestrator's KNOWN_PROVIDERS.
// Duplicated here because cross-plugin runtime imports are forbidden
// (CLAUDE.md invariant 2). Keep in sync when adding providers.
const KNOWN_PROVIDERS = [
  {
    provider: 'anthropic' as const,
    name: 'Anthropic',
    slot: 'ANTHROPIC_API_KEY' as const,
    description: 'API key from console.anthropic.com.',
  },
] as const;

export function ProvidersPanel() {
  return (
    <div className="max-w-[640px] mx-auto font-sans">
      <div className="mb-5">
        <h2 className="text-2xl font-medium tracking-[-0.018em] mb-1.5">Providers</h2>
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
