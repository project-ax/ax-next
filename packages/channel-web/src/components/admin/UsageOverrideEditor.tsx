import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { putUserLimits, type UsageUser } from '@/lib/usage-admin';
import { failureMessage, personLabel } from '@/lib/usage-copy';

export function UsageOverrideEditor({
  user,
  onSaved,
  onCancel,
}: {
  user: UsageUser;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [daily, setDaily] = useState(String(user.overrides?.dailySpendUsd ?? ''));
  const [turns, setTurns] = useState(String(user.overrides?.turnsPerHour ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dailyValid =
    daily.trim() === '' ||
    (Number.isFinite(Number(daily)) && Number(daily) >= 0.01 && Number(daily) <= 10_000);
  const turnsValid =
    turns.trim() === '' ||
    (Number.isInteger(Number(turns)) && Number(turns) >= 1 && Number(turns) <= 100_000);
  const save = async () => {
    if (!dailyValid || !turnsValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const input = {
        ...(daily.trim() === '' ? {} : { dailySpendUsd: Number(daily) }),
        ...(turns.trim() === '' ? {} : { turnsPerHour: Number(turns) }),
      };
      await putUserLimits(user.userId, Object.keys(input).length ? input : null);
      onSaved();
    } catch (err) {
      setError(failureMessage("We couldn't save these limits.", err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="flex flex-col gap-4"
      noValidate
    >
      <p className="text-sm font-medium">Limits for {personLabel(user)}</p>
      <FieldGroup className="md:flex-row">
        <Field data-invalid={!dailyValid || undefined}>
          <FieldLabel htmlFor={`daily-${user.userId}`}>Daily spend (USD)</FieldLabel>
          <Input
            id={`daily-${user.userId}`}
            type="number"
            min={0.01}
            max={10000}
            step="0.01"
            value={daily}
            onChange={(e) => setDaily(e.target.value)}
            aria-invalid={!dailyValid || undefined}
          />
        </Field>
        <Field data-invalid={!turnsValid || undefined}>
          <FieldLabel htmlFor={`turns-${user.userId}`}>Messages per hour</FieldLabel>
          <Input
            id={`turns-${user.userId}`}
            type="number"
            min={1}
            max={100000}
            step="1"
            value={turns}
            onChange={(e) => setTurns(e.target.value)}
            aria-invalid={!turnsValid || undefined}
          />
        </Field>
      </FieldGroup>
      <FieldDescription>
        Leave a field empty to use the workspace default. The workspace spend limit always applies.
      </FieldDescription>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !dailyValid || !turnsValid}>
          {busy ? 'Saving…' : 'Save person’s limits'}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
