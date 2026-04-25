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
import { searchStoreActions, useSearchStore } from '../lib/search-store';
import { sessionStoreActions, useSessionStore } from '../lib/session-store';
import { SidebarCollapseToggle } from './SidebarCollapseToggle';
import { SidebarMobileToggle } from './SidebarMobileToggle';

export function SessionHeader() {
  const { sessions, activeSessionId } = useSessionStore();
  const { agents, selectedAgentId, pendingAgentId } = useAgentStore();
  const { open: searchOpen } = useSearchStore();
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
  // Also seeds the textContent imperatively because we don't render `{title}`
  // while renaming (see render below) — this keeps parent re-renders from
  // clobbering the user's in-progress edits.
  useEffect(() => {
    if (!isRenaming) return;
    const el = titleRef.current;
    if (!el) return;
    el.textContent = title;
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
    // We deliberately exclude `title` from the dep array — re-seeding on
    // a parent-driven title prop change would erase mid-edit text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (!next || next === active.title) {
      // Empty / unchanged → restore the visible text. Once we exit rename
      // mode the div renders `{title}` again; setting it imperatively here
      // is belt-and-suspenders for the rare `el && next.trim() === ''`
      // path before the re-render lands.
      if (el) el.textContent = active.title;
      return;
    }
    let ok = false;
    try {
      const res = await fetch(`/api/chat/sessions/${active.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title: next }),
      });
      ok = res.ok;
      if (!ok) {
        console.warn('[session-header] rename PATCH failed', res.status);
      }
    } catch (err) {
      console.warn('[session-header] rename PATCH failed', err);
    }
    if (!ok && el) {
      // Server rejected — undo the visual change. bumpVersion() below also
      // re-fetches authoritative data, but we restore eagerly so the user
      // doesn't see their not-actually-saved text linger.
      el.textContent = active.title;
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
              hosts the mobile-only sidebar toggle (hamburger). The toggle
              hides itself on desktop via CSS, so this slot is empty there. */}
          <SidebarMobileToggle />
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
          {/* While renaming we leave the div's text alone — the imperative
              effect seeds it on entry, and React reconciling `{title}`
              would clobber any in-progress edit if the parent re-renders
              (e.g., a session-store update). */}
          {!isRenaming ? title : null}
        </div>
        <div className="header-actions">
          <button
            className="header-action"
            type="button"
            aria-label="Search"
            aria-pressed={searchOpen}
            title="Search messages"
            onClick={() => {
              if (searchOpen) {
                searchStoreActions.close();
              } else {
                searchStoreActions.open();
              }
            }}
          >
            <span aria-hidden="true">⌕</span>
          </button>
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
