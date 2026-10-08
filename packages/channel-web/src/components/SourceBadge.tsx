/**
 * SourceBadge — the single, calm "source" tag for a skill or connector
 * (connectors-first-class design, UI/IA reorg).
 *
 * The agent-centric settings surface gives each skill/connector AT MOST ONE
 * source badge:
 *   - "Catalog" — the item comes from the workspace's shared, admin-curated
 *     catalog. You don't own its definition.
 *   - (nothing) — the item is PRIVATE: your own, just your agents, yours to
 *     manage. No badge, no "catalog" language.
 *
 * So a solo user with no curated catalog sees no badges and never reads the
 * word "catalog" — scope reveals itself progressively (design §UI/IA). We
 * deliberately avoid the word "scope" in user-facing copy.
 *
 * Composes the shadcn `Badge` primitive + semantic tokens only (invariant #6).
 */
import { Badge } from '@/components/ui/badge';

/** Where a settings item came from. `'private'` renders no badge. */
export type ItemSource = 'catalog' | 'private';

/**
 * Map a skill's storage scope to its source. A skill stored in the
 * admin-managed (`'global'`) table is catalog-sourced; a user-private copy
 * (`'user'`) shows no badge.
 */
export function skillSource(scope: 'global' | 'user'): ItemSource {
  return scope === 'global' ? 'catalog' : 'private';
}

/**
 * Render the source badge. `source="private"` renders nothing — the absence of
 * a badge IS the "private" signal, so there is no second tag to add.
 */
export function SourceBadge({ source }: { source: ItemSource }) {
  if (source === 'private') return null;
  return (
    <Badge variant="secondary" className="text-[10px]">
      Catalog
    </Badge>
  );
}
