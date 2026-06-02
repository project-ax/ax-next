/**
 * SessionHeader — sticky top bar of the main pane.
 *
 * Left slot: AgentChip (agent identity + switcher, per the design (Tide Sessions.html)).
 * Right slot: session title as small uppercase ghost label (double-click to rename).
 *
 * The rename flow: double-click → contenteditable, Enter/blur commits via
 * PATCH /api/chat/sessions/:id, Esc cancels. Mirrors SessionRow.tsx.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionStoreActions, useSessionStore } from '../lib/session-store';
import { AgentChip } from './AgentChip';
import { SidebarMobileToggle } from './SidebarMobileToggle';

export function SessionHeader({ onCreateAgent }: { onCreateAgent?: (() => void) | undefined }) {
  // Agent-list hydration is lifted to AppContent (so the first-run gate can
  // read agentsStatus before the chat shell ever renders); the header no
  // longer kicks it off.
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
      // TODO(week-10-12 follow-up): backend has no PATCH endpoint for conversations
      // yet — rename is silently no-op against real AX backend. Tracking in PR notes.
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
    <header className="sticky top-0 z-10 flex justify-center bg-background px-6 pt-[22px] pb-[18px]">
      <div className="w-full max-w-[640px] flex items-baseline justify-between">
        <div className="relative flex items-center shrink-0">
          {/* Mobile hamburger — hidden on desktop via Tailwind responsive classes. */}
          <SidebarMobileToggle />
          {/* Agent chip: identity + agent switcher, left-aligned per the design. */}
          <AgentChip onCreateNew={onCreateAgent} />
        </div>
        <div
          ref={titleRef}
          data-testid="session-header-title"
          className={
            isRenaming
              ? 'whitespace-nowrap max-w-[360px] self-center ml-auto -mr-2 px-2 py-1 rounded-sm cursor-text text-[10.5px] uppercase tracking-[0.08em] outline outline-1 outline-border bg-background text-foreground overflow-visible focus:outline-primary'
              : 'whitespace-nowrap overflow-hidden text-ellipsis max-w-[360px] self-center ml-auto -mr-2 px-2 py-1 rounded-sm cursor-text text-[10.5px] uppercase tracking-[0.08em] text-ink-ghost transition-colors hover:bg-muted hover:text-muted-foreground'
          }
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
      </div>
    </header>
  );
}
