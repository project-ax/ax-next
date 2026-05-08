/**
 * ProviderKeysTab — provider list with validation states.
 *
 * Behavior contract preserved from the legacy implementation:
 *   - GET /admin/credentials/providers on mount.
 *   - One row open at a time; opening a row collapses any other.
 *   - Save validates against the provider; success refetches + collapses,
 *     failure shows an inline destructive Alert + flips the action button to "Retry".
 */
import { useEffect, useRef, useState } from 'react';
import { listProviders, validateProviderKey, type ProviderEntry } from '@/lib/providers';
import { ProviderRow } from './ProviderRow';
import { KeyForm } from './KeyForm';
import type { StatusDotVariant } from './StatusDot';

const PROVIDER_HELPER: Record<string, string> = {
  anthropic: 'console.anthropic.com',
  openai: 'platform.openai.com/api-keys',
};

function providerMark(name: string): string {
  // Two-letter mark from the provider name (e.g., 'Anthropic' → 'An').
  return name.slice(0, 2);
}

export function ProviderKeysTab() {
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const editingIdRef = useRef<string | null>(null);

  const fetchProviders = async () => {
    try {
      const list = await listProviders();
      setProviders(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchProviders();
  }, []);

  const handleEdit = (providerId: string) => {
    setRowError({});
    setEditingId(providerId);
    editingIdRef.current = providerId;
  };

  const handleCancel = (providerId: string) => {
    setEditingId(null);
    editingIdRef.current = null;
    setRowError((prev) => ({ ...prev, [providerId]: '' }));
  };

  const handleSave = async (provider: ProviderEntry, key: string) => {
    setValidating(true);
    try {
      await validateProviderKey(provider.id, key);
      if (editingIdRef.current !== provider.id) {
        setValidating(false);
        return;
      }
      const list = await listProviders();
      setProviders(list);
      setEditingId(null);
      editingIdRef.current = null;
      setRowError((prev) => ({ ...prev, [provider.id]: '' }));
    } catch (err) {
      setValidating(false);
      if (editingIdRef.current !== provider.id) return;
      setRowError((prev) => ({
        ...prev,
        [provider.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className="max-w-[640px] mx-auto font-sans">
      <CanaryAdvisory />

      <div className="mb-5">
        <h2 className="text-2xl font-medium tracking-[-0.018em] mb-1.5">
          Provider keys
        </h2>
        <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
          Manage shared API keys for the model providers wired into this deployment.
          Keys are encrypted at rest and never returned in plaintext.
        </p>
      </div>

      {loading && <div className="text-sm text-muted-foreground">Loading providers…</div>}

      {loadError && (
        <div
          role="alert"
          className="px-3 py-2 bg-destructive-soft border border-destructive/25 rounded-md text-[12.5px] text-destructive"
        >
          Couldn't load providers: {loadError}
        </div>
      )}

      {!loading && !loadError && providers.length === 0 && (
        <div className="text-sm text-muted-foreground">
          No providers registered. Wire one in via{' '}
          <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            credentials:list-providers
          </code>
          .
        </div>
      )}

      <div className="flex flex-col">
        {providers.map((provider) => {
          const isEditing = editingId === provider.id;
          const error = rowError[provider.id];
          const status: StatusDotVariant = error
            ? 'bad'
            : provider.configured
              ? 'ok'
              : 'empty';

          const statusLabel = error
            ? 'Key rejected by provider'
            : isEditing
              ? 'Adding key…'
              : provider.configured
                ? 'Configured'
                : 'Not configured';

          return (
            <ProviderRow
              key={provider.id}
              mark={providerMark(provider.name)}
              name={provider.name}
              status={status}
              statusLabel={statusLabel}
              {...(provider.configured && !isEditing && { keyStub: 'key ••••••••' })}
              editing={isEditing}
              {...(!isEditing && { onEdit: () => handleEdit(provider.id) })}
              body={
                isEditing && (
                  <KeyForm
                    placeholder={`Paste your ${provider.name} API key`}
                    inputLabel={`${provider.name} API key`}
                    {...(error && { error })}
                    saving={validating}
                    helperRight={
                      PROVIDER_HELPER[provider.id] ? (
                        <>
                          Get a key at{' '}
                          <a
                            href={`https://${PROVIDER_HELPER[provider.id]}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                          >
                            {PROVIDER_HELPER[provider.id]}
                          </a>
                        </>
                      ) : undefined
                    }
                    onSave={(key) => handleSave(provider, key)}
                    onCancel={() => handleCancel(provider.id)}
                  />
                )
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function CanaryAdvisory() {
  return (
    <div
      role="status"
      data-testid="canary-advisory"
      className="mb-6 flex gap-2.5 items-start p-3.5 bg-muted border border-border rounded-lg text-[13px] leading-[1.5] text-muted-foreground"
    >
      <span className="shrink-0 font-mono text-[10px] tracking-[0.12em] uppercase text-muted-foreground bg-background border border-border px-1.5 py-0.5 rounded mt-px">
        Advisory
      </span>
      <span className="flex-1">
        Canary scanner isn't wired in yet — this deployment has no automated
        secret-leak veto and no LLM-output redaction. Internal use only.{' '}
        Tracked for Week&nbsp;13+.
      </span>
    </div>
  );
}
