/**
 * The "Limits" card on the Usage tab: workspace protection and defaults for each person.
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toastActions } from '@/lib/toast-store';
import { USAGE_LIMIT_BOUNDS, putUsageLimits, type UsageLimits } from '@/lib/usage-admin';
import { DAILY_LIMIT_INVALID, TURNS_LIMIT_INVALID, failureMessage } from '@/lib/usage-copy';

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
  fleet: string;
  assumed: string;
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

  const fleetValue = draft?.fleet ?? (limits ? dailyText(limits.fleetDailySpendUsd) : '');
  const assumedValue = draft?.assumed ?? (limits ? dailyText(limits.assumedTurnCostUsd) : '');
  const fleet = fleetValue.trim() === '' ? null : Number(fleetValue);
  const assumed = assumedValue.trim() === '' ? null : Number(assumedValue);
  const fleetValid =
    fleet !== null && Number.isFinite(fleet) && fleet >= 0.01 && fleet <= 1_000_000;
  const assumedValid =
    assumed !== null && Number.isFinite(assumed) && assumed >= 0 && assumed <= 100;
  const daily = parseDaily(dailyValue);
  const turns = parseTurns(turnsValue);
  // A field can only be wrong once it has been edited: saved values are valid.
  const dailyInvalid = draft !== null && daily === null;
  const turnsInvalid = draft !== null && turns === null;
  const changed =
    limits !== null &&
    daily !== null &&
    turns !== null &&
    fleetValid &&
    assumedValid &&
    (daily !== limits.dailySpendUsd ||
      turns !== limits.turnsPerHour ||
      fleet !== limits.fleetDailySpendUsd ||
      assumed !== limits.assumedTurnCostUsd);

  const edit = (patch: Partial<Draft>) => {
    if (limits === null) return;
    setSaveError(null);
    setDraft({
      daily: dailyValue,
      turns: turnsValue,
      fleet: fleetValue,
      assumed: assumedValue,
      ...patch,
    });
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
        fleetDailySpendUsd: fleet!,
        assumedTurnCostUsd: assumed!,
      });
      setDraft(null);
      onSaved(saved);
      toastActions.show({
        title: 'Limits saved',
        detail: 'Default limits updated. Individual overrides still apply.',
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
            Set workspace-wide protection and the default limits for each person.
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
              <Field
                className="max-w-sm"
                data-invalid={(draft !== null && !fleetValid) || undefined}
              >
                <FieldLabel htmlFor="usage-fleet-limit">
                  Daily spend limit for the whole workspace (USD)
                </FieldLabel>
                <Input
                  id="usage-fleet-limit"
                  type="number"
                  inputMode="decimal"
                  min={0.01}
                  max={1_000_000}
                  step="0.01"
                  value={fleetValue}
                  onChange={(e) => edit({ fleet: e.target.value })}
                  aria-invalid={(draft !== null && !fleetValid) || undefined}
                  aria-describedby="usage-fleet-help"
                />
                <FieldDescription id="usage-fleet-help">
                  At this total across all people over a rolling 24 hours, new model calls pause for
                  everyone. Calls already running may finish and add spend.
                </FieldDescription>
                {draft !== null && !fleetValid && (
                  <FieldError>Enter an amount between $0.01 and $1,000,000.</FieldError>
                )}
              </Field>
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
                  We estimate spend from how much each person's agents use, over a rolling 24 hours.
                  It's a safety limit, not a bill: models we don't recognize are counted at a high
                  rate. At the limit, their next message waits until usage frees up. A running task
                  can continue up to twice this amount before its next model call is blocked. The
                  workspace limit can stop it sooner.
                </FieldDescription>
                {dailyInvalid && (
                  <FieldError id="usage-daily-limit-error">{DAILY_LIMIT_INVALID}</FieldError>
                )}
              </Field>

              <Field className="max-w-sm" data-invalid={turnsInvalid || undefined}>
                <FieldLabel htmlFor="usage-turns-limit">Messages per person per hour</FieldLabel>
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
                  <FieldError id="usage-turns-limit-error">{TURNS_LIMIT_INVALID}</FieldError>
                )}
              </Field>
              <Field
                className="max-w-sm"
                data-invalid={(draft !== null && !assumedValid) || undefined}
              >
                <FieldLabel htmlFor="usage-assumed-cost">
                  Estimate for an unreported or interrupted turn (USD)
                </FieldLabel>
                <Input
                  id="usage-assumed-cost"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step="0.01"
                  value={assumedValue}
                  onChange={(e) => edit({ assumed: e.target.value })}
                  aria-invalid={(draft !== null && !assumedValid) || undefined}
                  aria-describedby="usage-assumed-help"
                />
                <FieldDescription id="usage-assumed-help">
                  Used when a turn ends without reporting usage. If the credential proxy measured
                  more, we use its larger estimate.
                </FieldDescription>
                {draft !== null && !assumedValid && (
                  <FieldError>Enter an amount between $0 and $100.</FieldError>
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
