/**
 * SourceBadge — the single, calm "source" tag for a skill or connector
 * (connectors-first-class design, UI/IA reorg).
 *
 * The agent-centric settings surface gives each skill/connector AT MOST ONE
 * source badge:
 *   - "Catalog" — the item comes from the workspace's shared, admin-curated
 *     catalog (it may be default-on). You don't own its definition.
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
 * Map a connector's curation flags to its source. A connector an admin flagged
 * default-on, OR one shared into the workspace, is catalog-sourced; a private,
 * non-default connector shows no badge. (`visibility`/`defaultAttached` are
 * storage-agnostic flags — never a backing-mechanism field.)
 *
 * `defaultAttached` is optional because the metadata-only connector LIST
 * (`ConnectorSummary`) does not carry it — the list keys the badge off
 * `visibility` alone, while a surface holding the full connector can pass both.
 */
export function connectorSource(input: {
  defaultAttached?: boolean;
  visibility: 'private' | 'shared';
}): ItemSource {
  return input.defaultAttached === true || input.visibility === 'shared'
    ? 'catalog'
    : 'private';
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
