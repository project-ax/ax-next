import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { IconTooltip } from './IconTooltip';
import { RAIL_PANELS, isRailPanel, type RailPanel } from './AgentRail';

interface Props {
  /** The panels this chat can open — Memory is absent without facts memory. */
  panels: readonly RailPanel[];
  /** The open panel, `null` when the side panel is hidden. */
  value: RailPanel | null;
  onValueChange: (next: RailPanel | null) => void;
  /** Accessible names that say more than the label (e.g. "Memory, 2 new"). */
  labels?: Partial<Record<RailPanel, string>>;
  /** Panels with something new behind them get a small dot. */
  dots?: Partial<Record<RailPanel, boolean>>;
}

/**
 * The chat header's icon toggles — one per side-panel view.
 *
 * A single-select toggle group is the whole interaction model: pressing an
 * icon opens its panel (or switches to it), and pressing the pressed one
 * again closes the panel. That is why the panel has no close button of its
 * own; the control that opened it is always the one that puts it away, and it
 * says which view is open with its pressed state.
 */
export function ChatPanelToggles({ panels, value, onValueChange, labels, dots }: Props) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      aria-label="Side panel"
      value={value ?? ''}
      onValueChange={(next) => onValueChange(isRailPanel(next) ? next : null)}
      className="gap-0.5"
    >
      {panels.map((id) => {
        const { label, Icon } = RAIL_PANELS[id];
        return (
          <IconTooltip key={id} label={label} side="bottom">
            <ToggleGroupItem
              value={id}
              aria-label={labels?.[id] ?? label}
              className="relative size-8 rounded-sm p-0 text-muted-foreground hover:bg-accent hover:text-foreground data-[state=on]:bg-primary-soft data-[state=on]:text-primary max-md:size-11"
            >
              <Icon aria-hidden="true" className="size-4" />
              {dots?.[id] && (
                <span
                  aria-hidden="true"
                  className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
                />
              )}
            </ToggleGroupItem>
          </IconTooltip>
        );
      })}
    </ToggleGroup>
  );
}
