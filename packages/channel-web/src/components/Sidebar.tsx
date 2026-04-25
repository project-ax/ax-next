/**
 * Sidebar — left rail shell.
 *
 * Structure-only for Task 11. Real handlers and dynamic content come in
 * later tasks (agent menu in Task 12, session list in Task 13, collapse
 * toggle in Task 15, user menu in Task 21).
 *
 * Class names match `design_handoff_tide/Tide Sessions.html` so the
 * CSS rules in `index.css` (also copied verbatim from that file) carry
 * over without visual drift.
 */
export function Sidebar() {
  return (
    <aside className="sidebar" data-testid="sidebar" id="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-word">tide</span>
        </div>
        {/* sidebar-collapse toggle button placeholder — Task 15 wires it */}
      </div>
      <button
        className="agent-chip"
        aria-haspopup="true"
        aria-expanded="false"
        type="button"
      >
        <span className="agent-chip-avatar" aria-hidden="true">
          <span className="dot" />
        </span>
        <span className="agent-chip-name">tide</span>
        <span className="agent-chip-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      <button className="new-session-btn" type="button">
        <span className="plus" aria-hidden="true">
          +
        </span>
        <span className="label">new session</span>
        <span className="kbd">⌘N</span>
      </button>
      <div className="sessions-scroll" role="navigation" aria-label="sessions">
        {/* SessionList placeholder — Task 13 fills it */}
      </div>
      <div className="user-row-wrap">
        <button
          className="user-row"
          aria-haspopup="true"
          aria-expanded="false"
          type="button"
        >
          <span className="user-avatar" aria-hidden="true">
            A
          </span>
          <span className="user-meta">
            <span className="user-name">Alice</span>
          </span>
          <span className="user-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {/* user-menu popover placeholder — Task 21 wires it */}
      </div>
    </aside>
  );
}
