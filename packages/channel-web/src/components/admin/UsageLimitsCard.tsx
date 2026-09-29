/**
 * The "Limits" card on the Usage tab: the two numbers every person is held to.
 *
 * The form mirrors the server's bounds so a typo gets a sentence at the field
 * rather than a refusal after the fact; the server re-checks and is the
 * authority (`USAGE_LIMIT_BOUNDS`). Save stays off until there is a valid
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
import { toastActions } from '@/lib/toast-store';
import {
  USAGE_LIMIT_BOUNDS,
  putUsageLimits,
  type UsageLimits,
} from '@/lib/usage-admin';
import {
  DAILY_LIMIT_INVALID,
  TURNS_LIMIT_INVALID,
  failureMessage,
} from '@/lib/usage-copy';

const DAILY = USAGE_LIMIT_BOUNDS.dailySpendUsd;
const TURNS = USAGE_LIMIT_BOUNDS.turnsPerHour;

function parseDaily(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= DAILY.min && n <= DAILY.max ? n : null;
}

function parseTurns(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= TURNS.min && n <= TURNS.max ? n : null;
}

/** "5" -> "5.00" for dollars; anything already finer than cents is left alone. */
function dailyText(n: number): string {
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-9 ? n.toFixed(2) : String(n);
}

interface Draft {
  daily: string;
  turns: string;
}

export interface UsageLimitsCardProps {
  /** The saved limits, or `null` while the first read is in flight. */
  limits: UsageLimits | null;
  /** Called with what the server saved, so the rest of the tab uses it too. */
  onSaved: (limits: UsageLimits) => void;
}

export function UsageLimitsCard({ limits, onSaved }: UsageLimitsCardProps) {
  /*
    `draft === null` means "untouched": the inputs mirror the saved limits, so
    there is no effect syncing props into state and no way for a background
    refresh to overwrite half-typed numbers. The first keystroke copies both
    fields into a draft; a save (or nothing) puts it back to null.
  */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const dailyValue = draft?.daily ?? (limits ? dailyText(limits.dailySpendUsd) : '');
  const turnsValue = draft?.turns ?? (limits ? String(limits.turnsPerHour) : '');

  const daily = parseDaily(dailyValue);
  const turns = parseTurns(turnsValue);
  // A field can only be wrong once it has been edited: saved values are valid.
  const dailyInvalid = draft !== null && daily === null;
  const turnsInvalid = draft !== null && turns === null;
  const changed =
    limits !== null &&
    daily !== null &&
    turns !== null &&
    (daily !== limits.dailySpendUsd || turns !== limits.turnsPerHour);

  const edit = (patch: Partial<Draft>) => {
    if (limits === null) return;
    setSaveError(null);
    setDraft({ daily: dailyValue, turns: turnsValue, ...patch });
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    // Enter can submit even while the button is off; the same guard applies.
    if (daily === null || turns === null || !changed || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await putUsageLimits({
        dailySpendUsd: daily,
        turnsPerHour: turns,
      });
      setDraft(null);
      onSaved(saved);
      toastActions.show({
        title: 'Limits saved',
        detail: 'Everyone now gets these limits.',
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
            Limits
          </CardTitle>
          <CardDescription>
            Everyone gets the same two limits. You can change them any time.
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
              <Field className="max-w-sm" data-invalid={dailyInvalid || undefined}>
                <FieldLabel htmlFor="usage-daily-limit">
                  Daily spend limit per person (USD)
                </FieldLabel>
                <Input
                  id="usage-daily-limit"
                  type="number"
                  inputMode="decimal"
                  min={DAILY.min}
                  max={DAILY.max}
                  step="0.01"
                  value={dailyValue}
                  onChange={(e) => edit({ daily: e.target.value })}
                  aria-invalid={dailyInvalid || undefined}
                  aria-describedby={
                    dailyInvalid
                      ? 'usage-daily-limit-help usage-daily-limit-error'
                      : 'usage-daily-limit-help'
                  }
                />
                <FieldDescription id="usage-daily-limit-help">
                  We estimate spend from how much each person's agents use, over
                  a rolling 24 hours. At the limit, their next message waits
                  until usage frees up.
                </FieldDescription>
                {dailyInvalid && (
                  <FieldError id="usage-daily-limit-error">
                    {DAILY_LIMIT_INVALID}
                  </FieldError>
                )}
              </Field>

              <Field className="max-w-sm" data-invalid={turnsInvalid || undefined}>
                <FieldLabel htmlFor="usage-turns-limit">
                  Messages per person per hour
                </FieldLabel>
                <Input
                  id="usage-turns-limit"
                  type="number"
                  inputMode="numeric"
                  min={TURNS.min}
                  max={TURNS.max}
                  step="1"
                  value={turnsValue}
                  onChange={(e) => edit({ turns: e.target.value })}
                  aria-invalid={turnsInvalid || undefined}
                  aria-describedby={
                    turnsInvalid
                      ? 'usage-turns-limit-help usage-turns-limit-error'
                      : 'usage-turns-limit-help'
                  }
                />
                <FieldDescription id="usage-turns-limit-help">
                  Includes messages that scheduled routines send for them.
                </FieldDescription>
                {turnsInvalid && (
                  <FieldError id="usage-turns-limit-error">
                    {TURNS_LIMIT_INVALID}
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
