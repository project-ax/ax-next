import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { CatalogProvider } from '@/lib/models-admin';
import { selectedInfo, type Draft } from '@/lib/models-picker';
import { DEFAULT_HELP, NEEDS_KEY, NONE_SELECTED_BODY, NONE_SELECTED_TITLE, NO_LONGER_LISTED } from '@/lib/models-copy';

export interface SelectedModelsPaneProps {
  draft: Draft;
  providers: readonly CatalogProvider[];
  onSetDefault(ref: string): void;
  onRemove(ref: string): void;
}

export function SelectedModelsPane({ draft, providers, onSetDefault, onRemove }: SelectedModelsPaneProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const focusAfterRemove = useRef<number | null>(null);

  // The remove button the admin just pressed is gone after the re-render, so keyboard
  // and screen-reader users would land on <body>. Put focus on the row that took its
  // place (or the one above it), and on the list itself when nothing is left.
  useEffect(() => {
    const index = focusAfterRemove.current;
    if (index === null) return;
    focusAfterRemove.current = null;
    const radios = listRef.current?.querySelectorAll<HTMLElement>('[role="radio"]');
    const target = radios !== undefined && radios.length > 0 ? radios[Math.min(index, radios.length - 1)] : listRef.current;
    target?.focus();
  }, [draft.allowed]);

  function remove(ref: string) {
    focusAfterRemove.current = draft.allowed.indexOf(ref);
    onRemove(ref);
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-1">
        <CardTitle role="heading" aria-level={2} className="text-lg">
          Available to users ({draft.allowed.length})
        </CardTitle>
        <CardDescription>{DEFAULT_HELP}</CardDescription>
      </CardHeader>
      <CardContent>
        <div ref={listRef} tabIndex={-1} className="outline-none">
          {draft.allowed.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{NONE_SELECTED_TITLE}</EmptyTitle>
                <EmptyDescription>{NONE_SELECTED_BODY}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <RadioGroup value={draft.default} onValueChange={onSetDefault} className="gap-2">
              {draft.allowed.map((ref) => {
                const info = selectedInfo(ref, providers);
                return (
                  <div key={ref} className="flex items-center gap-2 rounded border border-border px-2 py-1.5" title={ref}>
                    <RadioGroupItem value={ref} id={`default-${ref}`} aria-label={`Make ${info.label} the Default`} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{info.label}</p>
                      <p className="truncate text-xs text-muted-foreground">{info.providerName}</p>
                    </div>
                    {ref === draft.default && <Badge>Default</Badge>}
                    {info.noLongerListed && <Badge variant="outline">{NO_LONGER_LISTED}</Badge>}
                    {info.needsKey && <Badge variant="outline">{NEEDS_KEY}</Badge>}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${info.label}`}
                      onClick={() => remove(ref)}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                );
              })}
            </RadioGroup>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
