/**
 * SessionRow — one row in the sidebar session list.
 *
 * Holds a tiny per-row state machine: idle | renaming | confirming-delete.
 * Rendered children depend on the state, but the outer wrapper is always
 * a 34px row so the list never reflows on confirm/cancel/rename.
 *
 * Inline rename:
 *   - Trigger: double-click the title, OR click the "rename" item in the
 *     row-menu opened by the `⋯` button.
 *   - The `.session-row-title` becomes `contenteditable="plaintext-only"`.
 *     Focus + select-all happens on entering rename mode.
 *   - Enter or blur commits via `PATCH /api/chat/sessions/:id { title }`,
 *     followed by `bumpVersion()` so the list re-fetches.
 *   - Esc cancels: original title restored, no PATCH, no version bump.
 *
 * Inline delete confirm:
 *   - Trigger: click the "delete" item in the row-menu.
 *   - Row contents swap in place to a confirm UI (`.confirming-delete`).
 *     Background is `color-mix(in oklch, var(--danger) 10%, transparent)`,
 *     row stays 34px tall.
 *   - Confirm `delete` -> `DELETE /api/chat/sessions/:id` + `bumpVersion()`.
 *   - Confirm `cancel` or no action within 5s -> revert to idle.
 *   - The 5s timer is cleared on cancel/delete via the `useEffect` cleanup
 *     so a row that was just deleted doesn't fire a late revert on a
 *     stale ref.
 *
 * jsdom note: `contenteditable="plaintext-only"` is partially supported.
 * Reading the value via `textContent` works either way, so we set
 * `plaintext-only` (the right semantic) and read with `textContent`.
 *
 * The fixed `34px` height is **load-bearing** — `index.css` enforces it,
 * including for `.confirming-delete`. Don't add padding/min-height that
 * would break it.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { sessionStoreActions } from '../lib/session-store';

export interface SessionRowProps {
  id: string;
  title: string;
  active: boolean;
  agentColor: string;
  onSelect: (id: string) => void;
}

type RowState = 'idle' | 'renaming' | 'confirming-delete';

export function SessionRow({
  id,
  title,
  active,
  agentColor,
  onSelect,
}: SessionRowProps) {
  const [rowState, setRowState] = useState<RowState>('idle');
  const [menuOpen, setMenuOpen] = useState(false);

  const titleRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLSpanElement | null>(null);
  // Track whether the rename committed (Enter / blur after typing) vs.
  // cancelled (Escape) so the blur handler doesn't double-commit a
  // cancellation.
  const renameCommittedRef = useRef(false);
  // Track whether we have a delete in flight so the auto-revert timer
  // doesn't fire after the row is gone.
  const deleteFiredRef = useRef(false);

  // ---------- rename ----------
  const enterRename = useCallback(() => {
    if (rowState === 'renaming') return;
    renameCommittedRef.current = false;
    setRowState('renaming');
    setMenuOpen(false);
  }, [rowState]);

  const exitRename = useCallback(() => {
    setRowState('idle');
  }, []);

  // When entering rename mode, seed the textContent imperatively (we don't
  // render `{title}` while renaming so a parent re-render can't clobber the
  // user's in-progress edits), focus the title, and select all text.
  useEffect(() => {
    if (rowState !== 'renaming') return;
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
    // Deliberately exclude `title` from deps — re-seeding on a parent-driven
    // title prop change would erase mid-edit text.
  }, [rowState]);

  const commitRename = useCallback(async () => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    const el = titleRef.current;
    const next = (el?.textContent ?? '').trim();
    exitRename();
    // Empty or unchanged → restore the original title in the DOM. React
    // will skip reconciling the text node because the `title` prop hasn't
    // changed, so without an imperative restore the user's typed text
    // would persist visually.
    if (!next || next === title) {
      if (el) el.textContent = title;
      return;
    }
    let ok = false;
    try {
      const res = await fetch(`/api/chat/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title: next }),
      });
      ok = res.ok;
      if (!ok) {
        console.warn('[session-row] rename PATCH failed', res.status);
      }
    } catch (err) {
      console.warn('[session-row] rename PATCH failed', err);
    }
    if (!ok && el) {
      // Server rejected — undo the visual change so the DOM matches truth.
      el.textContent = title;
    }
    sessionStoreActions.bumpVersion();
  }, [exitRename, id, title]);

  const cancelRename = useCallback(() => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    const el = titleRef.current;
    if (el) el.textContent = title;
    exitRename();
  }, [exitRename, title]);

  // ---------- delete confirm ----------
  const enterConfirmDelete = useCallback(() => {
    deleteFiredRef.current = false;
    setRowState('confirming-delete');
    setMenuOpen(false);
  }, []);

  const cancelConfirmDelete = useCallback(() => {
    if (deleteFiredRef.current) return;
    setRowState('idle');
  }, []);

  const confirmDelete = useCallback(async () => {
    if (deleteFiredRef.current) return;
    deleteFiredRef.current = true;
    setRowState('idle');
    try {
      await fetch(`/api/chat/sessions/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
    } catch (err) {
      console.warn('[session-row] DELETE failed', err);
    }
    sessionStoreActions.bumpVersion();
  }, [id]);

  // 5s auto-revert. Cleared on state change so cancel/delete don't see
  // a late revert; cleared on unmount too.
  useEffect(() => {
    if (rowState !== 'confirming-delete') return;
    const t = setTimeout(() => {
      if (deleteFiredRef.current) return;
      setRowState('idle');
    }, 5000);
    return () => {
      clearTimeout(t);
    };
  }, [rowState]);

  // ---------- row menu (rename / delete popover) ----------
  // Outside-click closes the menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (moreRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [menuOpen]);

  // ---------- render ----------
  if (rowState === 'confirming-delete') {
    return (
      <div
        className="session-row confirming-delete"
        data-session-id={id}
        role="group"
      >
        <span className="session-row-confirm-text">delete this session?</span>
        <button
          type="button"
          className="session-row-confirm-cancel"
          onClick={(e) => {
            e.stopPropagation();
            cancelConfirmDelete();
          }}
        >
          cancel
        </button>
        <button
          type="button"
          className="session-row-confirm-delete"
          onClick={(e) => {
            e.stopPropagation();
            void confirmDelete();
          }}
        >
          delete
        </button>
      </div>
    );
  }

  // contenteditable's React typing differs slightly across versions;
  // setting via attribute style sidesteps the union narrowing.
  const titleEditableProps =
    rowState === 'renaming'
      ? ({
          contentEditable: 'plaintext-only' as unknown as boolean,
          suppressContentEditableWarning: true,
        } as const)
      : {};

  // Static dot style; pulled out so re-renders don't churn the inline
  // style object (CSS engines memoize on identity in some browsers).
  const dotStyle: CSSProperties = { background: agentColor };

  return (
    <div
      className={`session-row${active ? ' active' : ''}`}
      data-session-id={id}
      onClick={(e) => {
        // Clicks on the more-button, menu, or editable title shouldn't
        // count as a row select. The row itself acts as the select target.
        if (rowState === 'renaming') return;
        const t = e.target as HTMLElement;
        if (t.closest('.session-row-more')) return;
        if (t.closest('.session-row-menu')) return;
        if (t.closest('.session-row-title')?.getAttribute('contenteditable')) {
          return;
        }
        onSelect(id);
      }}
      style={{ position: 'relative' }}
    >
      <span
        className="session-row-dot"
        style={dotStyle}
        aria-hidden="true"
      />
      <span
        ref={titleRef}
        className="session-row-title"
        onDoubleClick={(e) => {
          e.stopPropagation();
          enterRename();
        }}
        onKeyDown={(e) => {
          if (rowState !== 'renaming') return;
          if (e.key === 'Enter') {
            e.preventDefault();
            void commitRename();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelRename();
          }
        }}
        onBlur={() => {
          if (rowState !== 'renaming') return;
          void commitRename();
        }}
        {...titleEditableProps}
      >
        {/* Don't render `{title}` while renaming — the imperative effect
            seeds it on entry, and React reconciling the prop would
            clobber any in-progress edit on a parent re-render. */}
        {rowState === 'renaming' ? null : title}
      </span>
      <span
        ref={moreRef}
        className="session-row-more"
        aria-label="more"
        role="button"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
      >
        ⋯
      </span>
      {menuOpen ? (
        <div
          ref={menuRef}
          className="session-row-menu"
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="session-row-menu-item"
            data-testid="row-menu-rename"
            role="menuitem"
            onClick={() => enterRename()}
          >
            rename
          </button>
          <button
            type="button"
            className="session-row-menu-item danger"
            data-testid="row-menu-delete"
            role="menuitem"
            onClick={() => enterConfirmDelete()}
          >
            delete
          </button>
        </div>
      ) : null}
    </div>
  );
}
