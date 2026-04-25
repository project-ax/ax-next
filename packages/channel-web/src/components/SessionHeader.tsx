/**
 * SessionHeader — sticky top bar of the main pane.
 *
 * Left slot: AgentChip (agent identity + switcher, per Tide Sessions.html).
 * Right slot: session title as small uppercase ghost label (double-click to rename).
 *
 * The rename flow: double-click → contenteditable, Enter/blur commits via
 * PATCH /api/chat/sessions/:id, Esc cancels. Mirrors SessionRow.tsx.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionStoreActions, useSessionStore } from '../lib/session-store';
import { AgentChip, useHydrateAgents } from './AgentChip';
import { SidebarMobileToggle } from './SidebarMobileToggle';

export function SessionHeader() {
  useHydrateAgents();
  const { sessions, activeSessionId } = useSessionStore();
  const active = sessions.find((s) => s.id === activeSessionId) ?? null;
  const title = active?.title ?? '';

  const [isRenaming, setIsRenaming] = useState(false);
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
          {/* Mobile hamburger — hidden on desktop via CSS. */}
          <SidebarMobileToggle />
          {/* Agent chip: identity + agent switcher, left-aligned per Tide Sessions.html. */}
          <AgentChip />
        </div>
        <div
          ref={titleRef}
          className="session-breadcrumb"
          data-testid="session-header-title"
          onClick={() => {
            if (!isRenaming) enterRename();
          }}
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
          {!isRenaming ? title : null}
        </div>
        <div className="header-actions" />
      </div>
    </header>
  );
}
