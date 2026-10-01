import { useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import type { CatalogProvider } from '@/lib/models-admin';
import { countModels } from '@/lib/models-picker';
import { cachedNote, countLine, providerNoKey, providerProblem } from '@/lib/models-copy';

export interface ModelCatalogPaneProps {
  /** Everything the catalog returned (unfiltered). */
  providers: readonly CatalogProvider[];
  /** The same providers after the search filter. */
  shown: readonly CatalogProvider[];
  selected: ReadonlySet<string>;
  query: string;
  onQueryChange(query: string): void;
  onToggle(ref: string): void;
  onSelectAllShown(refs: string[]): void;
  onRetry(): void;
  retrying: boolean;
  onOpenKeys?: () => void;
  nowMs: number;
}

export function ModelCatalogPane(props: ModelCatalogPaneProps) {
  const { providers, shown, selected, query, onQueryChange, onToggle, onSelectAllShown } = props;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const filtering = query.trim() !== '';
  const total = countModels(providers);
  const shownCount = countModels(shown);
  const shownRefs = shown.flatMap((p) => p.models.map((m) => m.ref));
  const allShownSelected = shownRefs.every((r) => selected.has(r));

  // While searching, providers that still have matches stay visible even with
  // no models listed only when they carry a problem note worth showing.
  const groups = filtering ? shown : providers;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3">
        <CardTitle role="heading" aria-level={2} className="text-lg">
          All models
        </CardTitle>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search by name or provider"
            aria-label="Search models"
            className="pl-8"
          />
        </div>
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <p role="status" aria-live="polite">
            {countLine(shownCount, total, filtering)}
          </p>
          {filtering && shownCount > 0 && (
            <Button
              type="button"
              variant="link"
              size="sm"
              disabled={allShownSelected}
              onClick={() => onSelectAllShown(shownRefs)}
            >
              Select all {shownCount} shown
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="max-h-[60vh] flex flex-col gap-4 overflow-y-auto">
        {filtering && shownCount === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No models match “{query.trim()}”</EmptyTitle>
              <EmptyDescription>Try a different word, or clear the search.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {groups.map((p) => {
          const open = filtering || !collapsed.has(p.id);
          return (
            <Collapsible
              key={p.id}
              open={open}
              onOpenChange={(next) =>
                setCollapsed((prev) => {
                  const copy = new Set(prev);
                  if (next) copy.delete(p.id);
                  else copy.add(p.id);
                  return copy;
                })
              }
            >
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="w-full justify-start gap-1 px-0 text-left">
                  {open ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
                  {p.name}
                  <span className="text-muted-foreground">({p.models.length})</span>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 flex flex-col gap-2">
                {(p.status === 'fallback' || p.status === 'error') && (
                  <Alert>
                    <AlertDescription className="flex flex-wrap items-center gap-3">
                      <span>{providerProblem(p.name)}</span>
                      <Button type="button" variant="outline" size="sm" disabled={props.retrying} onClick={props.onRetry}>
                        Try again
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}
                {p.status === 'cached' && (
                  <p className="text-xs text-muted-foreground">{cachedNote(p.fetchedAt, props.nowMs)}</p>
                )}
                {p.status === 'no-key' && (
                  <p className="text-sm text-muted-foreground">
                    {providerNoKey(p.name)}{' '}
                    {props.onOpenKeys !== undefined && (
                      <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={props.onOpenKeys}>
                        Open AI model keys
                      </Button>
                    )}
                  </p>
                )}
                <ul className="flex flex-col gap-1">
                  {p.models.map((m) => (
                    <li key={m.ref}>
                      {/* The raw ref is in the native title: 400+ rows make a Radix Tooltip per row too heavy. */}
                      <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted" title={m.ref}>
                        <Checkbox checked={selected.has(m.ref)} onCheckedChange={() => onToggle(m.ref)} />
                        <span>{m.label}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </CardContent>
    </Card>
  );
}
