/**
 * SessionHeader — sticky 56px top bar of the main pane.
 *
 * Shows the active session title (serif 17/500). Double-click to inline-
 * rename: the title becomes `contenteditable="plaintext-only"`, Enter or
 * blur commits via `PATCH /api/chat/sessions/:id { title }`, Esc cancels.
 * Mirrors the per-row rename in `SessionRow.tsx` so the two affordances
 * feel the same.
 *
 * Right-aligned actions:
 *   - ⌘N: triggers a new session for the active agent (same path as
 *     `NewSessionButton`). The ⌘N keyboard shortcut lives on `App.tsx`
 *     (alongside ⌘\) so it works even when the header isn't focused.
 *   - ⋯: stub more-menu. Toggles local state; the menu items themselves
 *     come in later tasks.
 *   - SidebarCollapseToggle: moved here from the sidebar head per the
 *     Tide design — the toggle lives at the top of the main pane, not
 *     inside the sidebar.
 *
 * If no active session is selected, the header still renders (so the
 * 56px slot exists for layout) with an empty title.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentStore } from '../lib/agent-store';
import { sessionStoreActions, useSessionStore } from '../lib/session-store';
import { SidebarCollapseToggle } from './SidebarCollapseToggle';

export function SessionHeader() {
  const { sessions, activeSessionId } = useSessionStore();
  const { agents, selectedAgentId, pendingAgentId } = useAgentStore();
  const activeAgentId =
    pendingAgentId ?? selectedAgentId ?? agents[0]?.id ?? null;

  const active = sessions.find((s) => s.id === activeSessionId) ?? null;
  const title = active?.title ?? '';

  const [isRenaming, setIsRenaming] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const titleRef = useRef<HTMLDivElement | null>(null);
  // Track whether the rename committed (Enter / blur after typing) vs.
  // cancelled (Escape) so the blur handler doesn't double-commit a
  // cancellation. Mirrors SessionRow's renameCommittedRef.
  const renameCommittedRef = useRef(false);

  // Focus + select-all on entering rename mode. Same pattern as SessionRow.
  useEffect(() => {
    if (!isRenaming) return;
    const el = titleRef.current;
    if (!el) return;
    el.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {
      // jsdom may not implement Range fully; ignore.
    }
  }, [isRenaming]);

  const exitRename = useCallback(() => {
    setIsRenaming(false);
  }, []);

  const commitRename = useCallback(async () => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    const el = titleRef.current;
    const next = (el?.textContent ?? '').trim();
    exitRename();
    if (!active) return;
    if (!next || next === active.title) return;
    try {
      await fetch(`/api/chat/sessions/${active.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title: next }),
      });
    } catch (err) {
      console.warn('[session-header] rename PATCH failed', err);
    }
    sessionStoreActions.bumpVersion();
  }, [active, exitRename]);

  const cancelRename = useCallback(() => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    const el = titleRef.current;
    if (el) el.textContent = active?.title ?? '';
    exitRename();
  }, [active, exitRename]);

  const enterRename = useCallback(() => {
    renameCommittedRef.current = false;
    setIsRenaming(true);
  }, []);

  const handleNewSession = useCallback(async (): Promise<void> => {
    if (!activeAgentId) return;
    try {
      await sessionStoreActions.createAndActivate(activeAgentId);
    } catch (err) {
      console.warn('[session-header] create session failed', err);
    }
  }, [activeAgentId]);

  // contenteditable React typing differs across versions; setting via
  // attribute object sidesteps the union narrowing. Mirrors SessionRow.
  const titleEditableProps = isRenaming
    ? ({
        contentEditable: 'plaintext-only' as unknown as boolean,
        suppressContentEditableWarning: true,
      } as const)
    : {};

  return (
    <header className="header">
      <div className="header-inner">
        <div className="header-left">
          {/* Agent chip lives in the sidebar per Tide design — header-left
              is intentionally empty for now. Kept as a slot so future
              breadcrumbs / pane controls have a home. */}
        </div>
        <div
          ref={titleRef}
          className="session-breadcrumb"
          data-testid="session-header-title"
          onDoubleClick={enterRename}
          onKeyDown={(e) => {
            if (!isRenaming) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              void commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelRename();
            }
          }}
          onBlur={() => {
            if (!isRenaming) return;
            void commitRename();
          }}
          {...titleEditableProps}
        >
          {title}
        </div>
        <div className="header-actions">
          <button
            className="header-action"
            type="button"
            aria-label="New session"
            title="New session (⌘N)"
            onClick={() => {
              void handleNewSession();
            }}
          >
            <span className="kbd">⌘N</span>
          </button>
          <button
            className="header-action"
            type="button"
            aria-label="More"
            aria-haspopup="true"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          >
            ⋯
          </button>
          <SidebarCollapseToggle />
        </div>
      </div>
    </header>
  );
}
