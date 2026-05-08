/**
 * ApiKeyForm — paste-flow form for credentials with `flow: 'paste'`.
 *
 * Two variants:
 *
 *   - 'admin' → POST /admin/credentials with the operator-chosen scope
 *     and ownerId (full axis: global / user / agent). Scope=global means
 *     ownerId is null; scope=user|agent requires an ownerId.
 *   - 'user'  → POST /settings/credentials. Scope/ownerId are forced to
 *     scope='user' + ownerId=actor.id by the server, so we omit them
 *     from the form entirely.
 *
 * The api-key bytes are base64-encoded by the wire client before they
 * leave this component — they never traverse fetch logs as plaintext.
 *
 * State is vanilla `useState` (no react-hook-form — not in deps and the
 * form is small enough that the deduplication isn't worth the dep).
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  adminCredentials,
  myCredentials,
} from '../../lib/credentials';

export interface ApiKeyFormProps {
  variant: 'admin' | 'user';
  /** Defaults to 'api-key'; override for paste-flow kinds we don't yet
   *  enumerate (the server's list-kinds tells the menu what's accepted). */
  kind?: string;
  onAdded: () => void;
  onCancel: () => void;
}

type Scope = 'global' | 'user' | 'agent';

export function ApiKeyForm({
  variant,
  kind = 'api-key',
  onAdded,
  onCancel,
}: ApiKeyFormProps) {
  const [scope, setScope] = useState<Scope>('global');
  const [ownerId, setOwnerId] = useState('');
  const [ref, setRef] = useState('');
  const [payload, setPayload] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    if (ref.trim().length === 0) {
      setError('ref is required');
      return;
    }
    if (payload.length === 0) {
      setError('api key is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (variant === 'admin') {
        const ownerIdForCall = scope === 'global' ? null : ownerId.trim();
        if (ownerIdForCall !== null && ownerIdForCall.length === 0) {
          setError(`ownerId is required when scope='${scope}'`);
          setBusy(false);
          return;
        }
        await adminCredentials.create({
          scope,
          ownerId: ownerIdForCall,
          ref: ref.trim(),
          kind,
          payload,
        });
      } else {
        await myCredentials.create({
          ref: ref.trim(),
          kind,
          payload,
        });
      }
      // Clear secret material from component state immediately on
      // success — there's no reason for it to outlive the submit.
      setPayload('');
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
      onSubmit={(e) => void submit(e)}
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
              <Label htmlFor="cred-scope">Scope</Label>
              <select
                id="cred-scope"
                value={scope}
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
                <Label htmlFor="cred-owner">Owner ID</Label>
                <Input
                  id="cred-owner"
                  type="text"
                  value={ownerId}
                  onChange={(e) => setOwnerId(e.target.value)}
                  placeholder={
                    scope === 'user' ? 'e.g. alice' : 'e.g. agt-12345'
                  }
                />
              </div>
            )}
          </>
        )}

        <div className="grid gap-1.5">
          <Label htmlFor="cred-ref">Ref</Label>
          <Input
            id="cred-ref"
            type="text"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="e.g. anthropic"
            required
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="cred-payload">API key</Label>
          <Input
            id="cred-payload"
            type="password"
            autoComplete="off"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            required
          />
        </div>
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
        <Button
          type="submit"
          disabled={busy}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
