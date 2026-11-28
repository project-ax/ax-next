import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState, List, StatusBadge } from '@project-ax/ui';
import { SheetRow } from '../settings/SettingsLayout';
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
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>('li button');
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
          <EmptyState title={NONE_SELECTED_TITLE} description={NONE_SELECTED_BODY} />
        ) : <List label="Available to users">{draft.allowed.map((ref) => {
          const info = selectedInfo(ref, providers);
          const isDefault = ref === draft.default;
          const detail = [info.providerName, info.noLongerListed && NO_LONGER_LISTED, info.needsKey && NEEDS_KEY]
            .filter(Boolean).join(' · ');
          return (
            <SheetRow key={ref} title={info.label} meta={detail} trailing={<StatusBadge tone={isDefault ? 'info' : 'neutral'}>{isDefault ? 'Default' : 'Enabled'}</StatusBadge>}>
              <p className="break-all text-sm text-muted-foreground">{ref}</p>
              <p className="text-sm text-muted-foreground">{DEFAULT_HELP}</p>
              <Button type="button" variant="outline" disabled={isDefault}
                aria-label={`Make ${info.label} the Default`} onClick={() => onSetDefault(ref)}>
                {isDefault ? 'Default model' : 'Make default'}
              </Button>
              <Button type="button" variant="destructive" aria-label={`Remove ${info.label}`} onClick={() => remove(ref)}>
                Remove model
              </Button>
            </SheetRow>
          );
        })}</List>}
      </div>
    </section>
  );
}
