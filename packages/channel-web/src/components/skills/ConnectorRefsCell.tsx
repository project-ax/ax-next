/**
 * ConnectorRefsCell — the demoted "connectors" display for a skill table row
 * (TASK-118). A skill's `connectors` is a `string[]` of raw connector IDs; the
 * old tables rendered each id as a standalone lead-prominent badge. UX finding
 * M2 wants the raw ids demoted behind a tooltip/disclosure, not displayed raw.
 *
 * So this renders a calm "N connector(s)" count as the cell's visible content;
 * the raw ids live behind the shadcn `Tooltip` (hover) AND the trigger's `title`
 * attribute (the accessible/testable fallback — Radix tooltips are hover-only
 * and don't render their content in jsdom). Zero connectors renders the em-dash,
 * matching the prior empty state.
 *
 * One source of truth (invariant #4) for both the My Skills tables and the
 * admin Catalog table. Composes shadcn `Tooltip` + semantic tokens (invariant
 * #6) only. The connector ids are untrusted manifest-derived text and render
 * through React text nodes (auto-escaped) — never raw HTML.
 *
 * NOTE: the friendly connector NAME (`ConnectorSummary.name`) is not carried on
 * a skill summary, so this shows the raw id behind the disclosure. Mapping
 * id → friendly name is a follow-up (overlaps the connector-display work).
 */
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export function ConnectorRefsCell({ connectors }: { connectors: string[] }) {
  if (connectors.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const ids = connectors.join(', ');
  const label = `${connectors.length} connector${connectors.length === 1 ? '' : 's'}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="cursor-default text-xs text-muted-foreground underline decoration-dotted underline-offset-2"
          title={ids}
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{ids}</TooltipContent>
    </Tooltip>
  );
}
