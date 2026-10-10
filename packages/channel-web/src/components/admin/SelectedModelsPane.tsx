import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { SettingsDetailRow } from '../settings/SettingsLayout';
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
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>('button[aria-label^="Details for "]');
    const target = rows !== undefined && rows.length > 0 ? rows[Math.min(index, rows.length - 1)] : listRef.current;
    target?.focus();
  }, [draft.allowed]);

  function remove(ref: string) {
    focusAfterRemove.current = draft.allowed.indexOf(ref);
    onRemove(ref);
  }

  return (
    <section aria-label="Enabled models">
      <h2 className="sr-only">Available to users ({draft.allowed.length})</h2>
      <div ref={listRef} tabIndex={-1} className="outline-none">
        {draft.allowed.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{NONE_SELECTED_TITLE}</EmptyTitle>
              <EmptyDescription>{NONE_SELECTED_BODY}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : draft.allowed.map((ref) => {
          const info = selectedInfo(ref, providers);
          const isDefault = ref === draft.default;
          const detail = [info.providerName, info.noLongerListed && NO_LONGER_LISTED, info.needsKey && NEEDS_KEY]
            .filter(Boolean).join(' · ');
          return (
            <SettingsDetailRow key={ref} label={info.label} detail={detail} value={isDefault ? 'Default' : 'Enabled'}>
              <p className="break-all text-sm text-muted-foreground">{ref}</p>
              <p className="text-sm text-muted-foreground">{DEFAULT_HELP}</p>
              <Button type="button" variant="outline" disabled={isDefault}
                aria-label={`Make ${info.label} the Default`} onClick={() => onSetDefault(ref)}>
                {isDefault ? 'Default model' : 'Make default'}
              </Button>
              <Button type="button" variant="destructive" aria-label={`Remove ${info.label}`} onClick={() => remove(ref)}>
                Remove model
              </Button>
            </SettingsDetailRow>
          );
        })}
      </div>
    </section>
  );
}
