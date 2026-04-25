/**
 * SessionRow — one row in the sidebar session list.
 *
 * Pure presentational. Reads agent color from the agent-store via prop
 * lookup at render time (parent passes `agentColor`); the row itself
 * doesn't know how to fetch agents.
 *
 * The fixed `34px` height is **load-bearing** for Task 14's inline
 * delete-confirm: the confirm UI swaps row contents in place at the
 * same height, so the list doesn't reflow on confirm/cancel. CSS in
 * `index.css` enforces this — don't make rows variable-height here.
 *
 * The `⋯` more-button is a stub for Task 14 (which adds the inline
 * rename + delete-confirm menu). Markup is in place so CSS rules for
 * opacity 0 → 1 on hover/active carry from now.
 */
export interface SessionRowProps {
  id: string;
  title: string;
  active: boolean;
  agentColor: string;
  onSelect: (id: string) => void;
}

export function SessionRow({
  id,
  title,
  active,
  agentColor,
  onSelect,
}: SessionRowProps) {
  return (
    <button
      className={`session-row${active ? ' active' : ''}`}
      data-session-id={id}
      type="button"
      onClick={() => onSelect(id)}
    >
      <span
        className="session-row-dot"
        style={{ background: agentColor }}
        aria-hidden="true"
      />
      <span className="session-row-title">{title}</span>
      <span className="session-row-more" aria-label="more" tabIndex={-1}>
        ⋯
      </span>
    </button>
  );
}
