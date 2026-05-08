/**
 * OAuthFlowForm — paste-flow for OAuth-style credentials.
 *
 * Two-step UX, mirroring the server's start/finish handlers:
 *
 *   1. Operator types a `ref`, picks `scope`/`ownerId` (admin variant),
 *      clicks "Open" → POST /…/credentials/oauth/start. We open the
 *      provider's authorize URL in a new tab (`noopener,noreferrer` —
 *      the new tab can't reach back into our window) and stash the
 *      pendingId in component state.
 *   2. Operator signs in at the provider, copies the code from the
 *      redirect page, pastes it into the "Code" field, clicks "Finish"
 *      → POST /…/credentials/oauth/finish with `{ pendingId, code }`.
 *
 * No automatic redirect-listener: this is the deliberately-low-tech web
 * paste flow that doesn't require a registered redirect URI for every
 * deployment topology.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  adminCredentials,
  myCredentials,
} from '../../lib/credentials';

export interface OAuthFlowFormProps {
  variant: 'admin' | 'user';
  kind: string;
  onAdded: () => void;
  onCancel: () => void;
}

type Scope = 'global' | 'user' | 'agent';

interface PendingState {
  pendingId: string;
  authorizeUrl: string;
  instructions: string;
}

export function OAuthFlowForm({
  variant,
  kind,
  onAdded,
  onCancel,
}: OAuthFlowFormProps) {
  const [scope, setScope] = useState<Scope>('global');
  const [ownerId, setOwnerId] = useState('');
  const [ref, setRef] = useState('');
  const [pending, setPending] = useState<PendingState | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Client-side ownerId requirement: for admin variant with scope !== 'global',
  // an empty ownerId would bind the credential to nobody — the server rejects
  // it with 400. Disable the submit button up front so the round-trip never
  // happens, and surface a hint near the field.
  const ownerIdRequired =
    variant === 'admin' && scope !== 'global' && ownerId.trim().length === 0;

  const start = async (): Promise<void> => {
    if (busy) return;
    if (ref.trim().length === 0) {
      setError('ref is required');
      return;
    }
    if (ownerIdRequired) {
      setError(`ownerId is required when scope='${scope}'`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out =
        variant === 'admin'
          ? await adminCredentials.oauthStart({
              scope,
              ownerId: scope === 'global' ? null : ownerId.trim(),
              ref: ref.trim(),
              kind,
            })
          : await myCredentials.oauthStart({
              ref: ref.trim(),
              kind,
            });
      setPending(out);
      // `noopener,noreferrer` denies the new tab access to our window
      // (no `window.opener`, no Referer header to the provider). Same
      // posture as any external link in a security-sensitive UI.
      window.open(out.authorizeUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    if (pending === null) return;
    if (code.trim().length === 0) {
      setError('code is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input = { pendingId: pending.pendingId, code: code.trim() };
      if (variant === 'admin') {
        await adminCredentials.oauthFinish(input);
      } else {
        await myCredentials.oauthFinish(input);
      }
      setCode('');
      setPending(null);
      setRef('');
      setOwnerId('');
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => void finish(e)}
    >
      {error !== null && (
        <div
          role="alert"
          className="px-3 py-2 bg-destructive/10 border border-destructive/25 rounded-md text-[12.5px] text-destructive"
        >
          {error}
        </div>
      )}

      <div className="space-y-3">
        {variant === 'admin' && (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="oauth-scope">Scope</Label>
              <select
                id="oauth-scope"
                value={scope}
                disabled={pending !== null}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                onChange={(e) => setScope(e.target.value as Scope)}
              >
                <option value="global">global</option>
                <option value="user">user</option>
                <option value="agent">agent</option>
              </select>
            </div>

            {scope !== 'global' && (
              <div className="grid gap-1.5">
                <Label htmlFor="oauth-owner">Owner ID</Label>
                <Input
                  id="oauth-owner"
                  type="text"
                  value={ownerId}
                  disabled={pending !== null}
                  onChange={(e) => setOwnerId(e.target.value)}
                  placeholder={
                    scope === 'user' ? 'e.g. alice' : 'e.g. agt-12345'
                  }
                  aria-describedby="oauth-owner-hint"
                  aria-invalid={ownerIdRequired}
                  required
                />
                <span id="oauth-owner-hint" className="text-xs text-muted-foreground">
                  Required when scope is {scope}.
                </span>
              </div>
            )}
          </>
        )}

        <div className="grid gap-1.5">
          <Label htmlFor="oauth-ref">Ref</Label>
          <Input
            id="oauth-ref"
            type="text"
            value={ref}
            disabled={pending !== null}
            onChange={(e) => setRef(e.target.value)}
            placeholder="e.g. anthropic"
            required
          />
        </div>

        {pending !== null && (
          <>
            {pending.instructions && (
              <div className="px-3 py-2 bg-muted rounded-md text-sm text-muted-foreground">
                {pending.instructions}
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="oauth-code">Code</Label>
              <Input
                id="oauth-code"
                type="text"
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="paste the code from the provider page"
                className="font-mono"
                required
              />
            </div>
          </>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        {pending === null ? (
          <Button
            type="button"
            onClick={() => void start()}
            disabled={busy || ownerIdRequired || ref.trim().length === 0}
          >
            {busy ? 'Opening…' : 'Open'}
          </Button>
        ) : (
          <Button
            type="submit"
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Finish'}
          </Button>
        )}
      </div>
    </form>
  );
}
