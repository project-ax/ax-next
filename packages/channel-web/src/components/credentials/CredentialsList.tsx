/**
 * CredentialsList — row-style list of credentials, shared by admin + settings
 * panels.
 *
 * `variant` decides which wire client we talk to:
 *
 *   - 'admin' → `adminCredentials.*` → `/admin/credentials*` (full scope
 *     axis: global / user / agent visible to admins).
 *   - 'user'  → `myCredentials.*`    → `/settings/credentials*` (forced
 *     scope='user', ownerId=actor.id; the actor's own credentials only).
 *
 * The component is intentionally thin: load on mount, render a list,
 * delete with a `window.confirm` gate, refetch on success. Edit isn't
 * exposed (credentials are immutable — recreate to rotate).
 *
 * Server-supplied error strings render as plain text via React's default
 * escaping — no raw HTML injection. The wire never returns the secret
 * payload, so there's nothing to redact at the UI layer.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  adminCredentials,
  myCredentials,
  type CredentialMeta,
} from '../../lib/credentials';

export interface CredentialsListProps {
  variant: 'admin' | 'user';
  /**
   * Optional refresh signal — bump this number from the parent (e.g.
   * after CredentialAddMenu mutates) to force a re-fetch. The list also
   * fetches on mount.
   */
  refreshKey?: number;
}

function markFor(kind: string): string {
  // Take first letter of each segment of the kind, up to 2.
  // e.g., 'anthropic-oauth' → 'AO', 'api-key' → 'AP'.
  const parts = kind.split('-');
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return kind.slice(0, 2).toUpperCase();
}

export function CredentialsList({
  variant,
  refreshKey = 0,
}: CredentialsListProps) {
  const [list, setList] = useState<CredentialMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const client = variant === 'admin' ? adminCredentials : myCredentials;

  async function reload(): Promise<void> {
    setError(null);
    try {
      const next = await client.list();
      setList(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void reload();
    // `client` is captured from `variant`; refreshing on `refreshKey`
    // change lets parents force a re-fetch.
  }, [variant, refreshKey]);

  async function onDelete(c: CredentialMeta): Promise<void> {
    const ok = window.confirm(
      `Delete credential "${c.ref}"? This can't be undone — anything pointing at this ref will start failing immediately.`,
    );
    if (!ok) return;
    try {
      if (variant === 'admin') {
        await adminCredentials.delete({
          scope: c.scope,
          ownerId: c.ownerId,
          ref: c.ref,
        });
      } else {
        await myCredentials.delete(c.ref);
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Initial-load error (no list yet) takes over the whole panel — there's
  // nothing else to show.
  if (list === null && error === null) {
    return (
      <div className="text-sm text-muted-foreground">Loading…</div>
    );
  }
  if (list === null && error !== null) {
    return (
      <div className="text-sm text-destructive" role="alert">
        Error: {error}
      </div>
    );
  }

  // After the first successful load, errors render inline with a dismiss
  // button so a failed delete doesn't make the whole list disappear.
  return (
    <>
      {error !== null && (
        <div
          role="alert"
          className="px-3 py-2 bg-destructive/10 border border-destructive/25 rounded-md text-[12.5px] text-destructive flex items-center gap-2 mb-3"
        >
          <span className="flex-1">Error: {error}</span>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Dismiss error"
            onClick={() => setError(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      {list!.length === 0 ? (
        <div className="text-sm text-muted-foreground">No credentials yet.</div>
      ) : (
        <div className="flex flex-col">
          {list!.map((c) => {
            const subtitle = `${c.scope}${c.ownerId ? ` · ${c.ownerId}` : ''} · ${c.kind}`;
            return (
              <div
                key={`${c.scope}:${c.ownerId ?? '_'}:${c.ref}`}
                className="border-b border-rule-soft last:border-b-0 py-[1.125rem] flex items-center gap-3.5"
              >
                <span className="w-8 h-8 rounded-md bg-muted inline-flex items-center justify-center text-[13px] font-medium text-foreground/75 shrink-0">
                  {markFor(c.kind)}
                </span>
                <span className="flex flex-col gap-0.5 flex-1 min-w-0">
                  <span className="text-[15px] font-medium tracking-[-0.01em]">
                    {c.ref}
                  </span>
                  <span className="text-[12.5px] text-muted-foreground font-mono tracking-[0.02em]">
                    {subtitle}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete ${c.ref}`}
                  onClick={() => void onDelete(c)}
                >
                  Delete
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
