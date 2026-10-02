import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { putModelPrices, type ModelPrice } from '@/lib/usage-admin';
import { failureMessage } from '@/lib/usage-copy';

const rates = [
  ['inputUsdPerMillion', 'Input'],
  ['outputUsdPerMillion', 'Output'],
  ['cacheReadUsdPerMillion', 'Cache read'],
  ['cacheWriteUsdPerMillion', 'Cache write'],
] as const;
const blank: ModelPrice = {
  model: '',
  inputUsdPerMillion: 0,
  outputUsdPerMillion: 0,
  cacheReadUsdPerMillion: 0,
  cacheWriteUsdPerMillion: 0,
};
function id(model: string) {
  return model.toLowerCase().replace(/^(?:(?:openrouter|anthropic)\/)+/, '');
}
export function UsagePricesCard({
  prices,
  onSaved,
}: {
  prices: ModelPrice[];
  onSaved: (prices: ModelPrice[]) => void;
}) {
  const [draft, setDraft] = useState<ModelPrice | null>(null);
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validModel =
    draft !== null && /^[a-zA-Z0-9][a-zA-Z0-9/_.:@+-]{0,199}$/.test(draft.model.trim());
  const validRates =
    draft !== null &&
    rates.every(
      ([key]) =>
        Number.isFinite(draft[key]) &&
        draft[key] >= 0 &&
        draft[key] <= 10000 &&
        Math.abs(draft[key] * 100 - Math.round(draft[key] * 100)) < 1e-7,
    );
  const save = async (next: ModelPrice[]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await putModelPrices(next));
      setDraft(null);
    } catch (err) {
      setError(failureMessage("We couldn't save model prices.", err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Model prices
        </CardTitle>
        <CardDescription>
          Estimates in USD per million tokens. Saved prices apply to future usage; past estimates
          stay as recorded. Without an override, Claude families use built-in rates and other models
          use a conservative high rate.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {prices.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                {rates.map(([, label]) => (
                  <TableHead key={label}>{label}</TableHead>
                ))}
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prices.map((p) => (
                <TableRow key={p.model}>
                  <TableCell className="max-w-64 break-words">{p.model}</TableCell>
                  {rates.map(([key]) => (
                    <TableCell key={key}>{p[key]}</TableCell>
                  ))}
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`Edit price for ${p.model}`}
                        onClick={() => { setEditingModel(p.model); setDraft({ ...p }); }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`Remove price for ${p.model}`}
                        onClick={() => void save(prices.filter((x) => x.model !== p.model))}
                      >
                        Remove
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {draft === null ? (
          <Button
            className="self-start"
            variant="outline"
            disabled={busy || prices.length >= 100}
            onClick={() => {
              setError(null);
              setEditingModel(null);
              setDraft({ ...blank });
            }}
          >
            Add model price
          </Button>
        ) : (
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (validModel && validRates)
                void save([
                  ...prices.filter((p) => p.model !== editingModel && id(p.model) !== id(draft.model)),
                  { ...draft, model: draft.model.trim() },
                ]);
            }}
          >
            <FieldGroup>
              <Field data-invalid={!validModel || undefined}>
                <FieldLabel htmlFor="price-model">Model reference</FieldLabel>
                <Input
                  id="price-model"
                  value={draft.model}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  aria-invalid={!validModel || undefined}
                  aria-describedby="price-model-help"
                />
                <FieldDescription id="price-model-help">
                  Use the exact model reference from Models and keys, for example
                  openrouter/vendor/model-name.
                </FieldDescription>
              </Field>
              <FieldGroup className="grid grid-cols-2 md:grid-cols-4">
                {rates.map(([key, label]) => (
                  <Field key={key} data-invalid={!validRates || undefined}>
                    <FieldLabel htmlFor={`price-${key}`}>{label} (USD/M)</FieldLabel>
                    <Input
                      id={`price-${key}`}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={10000}
                      step="0.01"
                      value={Number.isNaN(draft[key]) ? '' : draft[key]}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          [key]: e.target.value === '' ? NaN : Number(e.target.value),
                        })
                      }
                      aria-invalid={!validRates || undefined}
                    />
                  </Field>
                ))}
              </FieldGroup>
              <FieldDescription>
                Enter non-negative prices up to $10,000, with at most two decimal places. Zero means
                those tokens are free.
              </FieldDescription>
            </FieldGroup>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !validModel || !validRates}>
                {busy ? 'Saving…' : 'Save model price'}
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
