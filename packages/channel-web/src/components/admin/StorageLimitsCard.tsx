/**
 * The "Storage limits" card on the Storage tab (admins only): how much room
 * each person gets, and when they start to hear that it is running out.
 *
 * The form mirrors the server's bounds so a typo gets a sentence at the field
 * rather than a refusal after the fact; the server re-checks and is the
 * authority (`STORAGE_LIMIT_BOUNDS`). Save stays off until there is a valid
 * change to save, so the button is never a question.
 *
 * `limits === null` means "still loading": the card keeps its place and shows
 * skeletons, so the page does not jump when the numbers arrive.
 */
import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  STORAGE_LIMIT_BOUNDS,
  putStorageLimits,
  type StorageLimits,
} from '@/lib/storage-api';
import {
  LIMIT_MB_INVALID,
  WARN_PERCENT_INVALID,
  failureMessage,
  formatMb,
} from '@/lib/storage-copy';
import { toastActions } from '@/lib/toast-store';

const LIMIT = STORAGE_LIMIT_BOUNDS.limitMb;
const WARN = STORAGE_LIMIT_BOUNDS.warnPercent;

/** Whole numbers only, inside the bounds. Anything else is `null`. */
function parseWhole(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

interface Draft {
  limit: string;
  warn: string;
}

export interface StorageLimitsCardProps {
  /** The saved limits, or `null` while the first read is in flight. */
  limits: StorageLimits | null;
  /** Called with what the server saved, so the rest of the tab uses it too. */
  onSaved: (limits: StorageLimits) => void;
}

export function StorageLimitsCard({ limits, onSaved }: StorageLimitsCardProps) {
  /*
    `draft === null` means "untouched": the inputs mirror the saved limits, so
    there is no effect syncing props into state and no way for a background
    refresh to overwrite half-typed numbers. The first keystroke copies both
    fields into a draft; a save (or nothing) puts it back to null.
  */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const limitValue = draft?.limit ?? (limits ? String(limits.limitMb) : '');
  const warnValue = draft?.warn ?? (limits ? String(limits.warnPercent) : '');

  const limit = parseWhole(limitValue, LIMIT.min, LIMIT.max);
  const warn = parseWhole(warnValue, WARN.min, WARN.max);
  // A field can only be wrong once it has been edited: saved values are valid.
  const limitInvalid = draft !== null && limit === null;
  const warnInvalid = draft !== null && warn === null;
  const changed =
    limits !== null &&
    limit !== null &&
    warn !== null &&
    (limit !== limits.limitMb || warn !== limits.warnPercent);

  const edit = (patch: Partial<Draft>) => {
    if (limits === null) return;
    setSaveError(null);
    setDraft({ limit: limitValue, warn: warnValue, ...patch });
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    // Enter can submit even while the button is off; the same guard applies.
    if (limits === null || limit === null || warn === null || !changed || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Only what changed: the other setting is not ours to overwrite (another
      // admin may have just changed it).
      const saved = await putStorageLimits({
        ...(limit !== limits.limitMb ? { limitMb: limit } : {}),
        ...(warn !== limits.warnPercent ? { warnPercent: warn } : {}),
      });
      setDraft(null);
      onSaved(saved);
      toastActions.show({
        title: 'Storage limits saved',
        detail: 'The new settings apply to everyone right away.',
        kind: 'info',
      });
    } catch (err) {
      setSaveError(
        failureMessage("We couldn't save your changes.", err, {
          settled: 'Nothing was changed.',
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} noValidate>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2} className="text-lg">
            Storage limits
          </CardTitle>
          <CardDescription>
            Everyone gets the same two settings. You can change them any time.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {limits === null ? (
            <div className="flex flex-col gap-7" aria-hidden="true">
              <Skeleton className="h-[72px] w-full max-w-sm" />
              <Skeleton className="h-[72px] w-full max-w-sm" />
            </div>
          ) : (
            <FieldGroup>
              <Field className="max-w-sm" data-invalid={limitInvalid || undefined}>
                <FieldLabel htmlFor="storage-limit-mb">Limit per person (MB)</FieldLabel>
                <Input
                  id="storage-limit-mb"
                  type="number"
                  inputMode="numeric"
                  min={LIMIT.min}
                  max={LIMIT.max}
                  step="1"
                  value={limitValue}
                  onChange={(e) => edit({ limit: e.target.value })}
                  aria-invalid={limitInvalid || undefined}
                  aria-describedby={
                    [
                      'storage-limit-mb-help',
                      limit !== null ? 'storage-limit-mb-size' : null,
                      limitInvalid ? 'storage-limit-mb-error' : null,
                    ]
                      .filter((id) => id !== null)
                      .join(' ')
                  }
                />
                <FieldDescription id="storage-limit-mb-help">
                  This is the most a person can store. It counts their agents'
                  files and their uploads together, and a team counts as one
                  person. Changes apply right away.
                </FieldDescription>
                {limit !== null && (
                  <FieldDescription id="storage-limit-mb-size">
                    {`That's ${formatMb(limit)} per person.`}
                  </FieldDescription>
                )}
                {limitInvalid && (
                  <FieldError id="storage-limit-mb-error">{LIMIT_MB_INVALID}</FieldError>
                )}
              </Field>

              <Field className="max-w-sm" data-invalid={warnInvalid || undefined}>
                <FieldLabel htmlFor="storage-warn-percent">
                  Show the "getting full" notice at (%)
                </FieldLabel>
                <Input
                  id="storage-warn-percent"
                  type="number"
                  inputMode="numeric"
                  min={WARN.min}
                  max={WARN.max}
                  step="1"
                  value={warnValue}
                  onChange={(e) => edit({ warn: e.target.value })}
                  aria-invalid={warnInvalid || undefined}
                  aria-describedby={
                    warnInvalid
                      ? 'storage-warn-percent-help storage-warn-percent-error'
                      : 'storage-warn-percent-help'
                  }
                />
                <FieldDescription id="storage-warn-percent-help">
                  Once someone has used this much of their limit, they see a
                  notice that they're getting close.
                </FieldDescription>
                {warnInvalid && (
                  <FieldError id="storage-warn-percent-error">
                    {WARN_PERCENT_INVALID}
                  </FieldError>
                )}
              </Field>
            </FieldGroup>
          )}
          {saveError !== null && (
            <Alert variant="destructive">
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={!changed || saving}>
            {saving ? 'Saving…' : 'Save limits'}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
