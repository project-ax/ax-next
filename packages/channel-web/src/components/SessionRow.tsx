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
 *   - The title becomes `contenteditable="plaintext-only"`. Focus +
 *     select-all happens on entering rename mode.
 *   - Enter or blur commits via `PATCH /api/chat/sessions/:id { title }`,
 *     followed by `bumpVersion()` so the list re-fetches.
 *   - Esc cancels: original title restored, no PATCH, no version bump.
 *
 * Inline delete confirm:
 *   - Trigger: click the "delete" item in the row-menu.
 *   - Row contents swap in place to a confirm UI. Background tints to
 *     bg-destructive/10, row stays 34px tall.
 *   - Confirm `delete` -> `DELETE /api/chat/conversations/:id` + bump.
 *   - Confirm `cancel` or no action within 5s -> revert to idle.
 *
 * Class names like `session-row`, `session-row-title`, `session-row-more`,
 * `confirming-delete` are kept as structural hooks that the component
 * tests query by; they carry no CSS rules of their own anymore.
 *
 * The fixed `34px` height is **load-bearing**. Don't add padding or
 * min-height that would break it.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { sessionStoreActions } from '../lib/session-store';
import { cn } from '@/lib/utils';
import {
  sidebarRowActiveClass,
  sidebarRowBaseClass,
  sidebarRowInactiveClass,
} from './SidebarRow';

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
  const renameCommittedRef = useRef(false);
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
  }, [rowState]);

  const commitRename = useCallback(async () => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    const el = titleRef.current;
    const next = (el?.textContent ?? '').trim();
    exitRename();
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
      await fetch(`/api/chat/conversations/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'x-requested-with': 'ax-admin' },
        credentials: 'include',
      });
    } catch (err) {
      console.warn('[session-row] DELETE failed', err);
    }
    sessionStoreActions.bumpVersion();
  }, [id]);

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

  // ---------- row menu ----------
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
        className="
          session-row confirming-delete
          flex items-center gap-1.5 h-[34px] px-2.5
          rounded-sm bg-destructive/10 cursor-default
        "
        data-session-id={id}
        role="group"
      >
        <span
          className="
            session-row-confirm-text flex-1
            text-[12px] leading-[1.35] tracking-[-0.005em] text-foreground
            whitespace-nowrap overflow-hidden text-ellipsis
          "
        >
          delete this session?
        </span>
        <button
          type="button"
          className="
            session-row-confirm-cancel
            text-[11.5px] leading-none px-1.5 py-[3px] rounded-sm
            text-muted-foreground hover:text-foreground transition-colors
          "
          onClick={(e) => {
            e.stopPropagation();
            cancelConfirmDelete();
          }}
        >
          cancel
        </button>
        <button
          type="button"
          className="
            session-row-confirm-delete
            text-[11.5px] leading-none px-1.5 py-[3px] rounded-sm font-medium
            text-destructive hover:bg-destructive hover:text-destructive-foreground
            transition-colors
          "
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

  const titleEditableProps =
    rowState === 'renaming'
      ? ({
          contentEditable: 'plaintext-only' as unknown as boolean,
          suppressContentEditableWarning: true,
        } as const)
      : {};

  const accentStyle: CSSProperties = { background: agentColor };
  const isRenaming = rowState === 'renaming';

  return (
    <div
      className={cn(
        // Mirror the SidebarRow frame so chat session rows are visually
        // identical to admin nav items (same paddings, gap, text size,
        // hover wash). h-[34px] is the only chat-specific override —
        // load-bearing for inline delete-confirm "no reflow" parity.
        'session-row',
        sidebarRowBaseClass,
        'h-[34px]',
        active ? cn('active', sidebarRowActiveClass) : sidebarRowInactiveClass,
      )}
      data-session-id={id}
      data-active={active ? 'true' : undefined}
      onClick={(e) => {
        if (rowState === 'renaming') return;
        const t = e.target as HTMLElement;
        if (t.closest('.session-row-more')) return;
        if (t.closest('.session-row-menu')) return;
        if (t.closest('.session-row-title')?.getAttribute('contenteditable')) {
          return;
        }
        onSelect(id);
      }}
    >
      {/* Per-agent accent bar — same shape as AdminNavItem's primary
          active bar, but always visible and coloured by the session's
          agent so the sidebar doubles as an at-a-glance agent legend. */}
      <span
        className="session-row-dot absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded-full"
        style={accentStyle}
        aria-hidden="true"
      />
      <span
        ref={titleRef}
        className={cn(
          'session-row-title flex-1 min-w-0 leading-[1.35] tracking-[-0.005em] whitespace-nowrap overflow-hidden',
          // Right-edge fade so trailing chars sit cleanly under the ⋯ button.
          // Mask widens slightly on hover/active so the runway stays clear.
          !isRenaming &&
            '[mask-image:linear-gradient(to_right,#000_calc(100%-18px),transparent_100%)] group-hover:[mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent_100%)] [.active>&]:[mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent_100%)]',
          isRenaming &&
            'overflow-visible cursor-text bg-muted rounded-sm px-1 -mx-1 outline-none',
        )}
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
        {isRenaming ? null : title}
      </span>
      <span
        ref={moreRef}
        className="
          session-row-more shrink-0 h-[18px] w-[18px] mt-px
          inline-flex items-center justify-center rounded-sm
          text-ink-ghost hover:bg-background hover:text-foreground
          opacity-0 group-hover:opacity-100 [.active>&]:opacity-100
          transition-opacity transition-colors cursor-pointer
        "
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
          className="
            session-row-menu absolute top-7 right-2 z-30 min-w-[130px]
            flex flex-col gap-px p-1
            rounded-md border border-border bg-background shadow-md
          "
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="
              session-row-menu-item
              flex items-center gap-2 px-2 py-1.5 rounded-sm
              text-[12.5px] text-foreground
              hover:bg-muted transition-colors cursor-pointer
            "
            data-testid="row-menu-rename"
            role="menuitem"
            onClick={() => enterRename()}
          >
            <svg
              viewBox="0 0 14 14"
              aria-hidden="true"
              className="h-3 w-3 shrink-0 text-muted-foreground"
            >
              <path
                d="M2 12 L4 12 L11 5 L9 3 L2 10 Z"
                stroke="currentColor"
                strokeWidth="1.2"
                fill="none"
                strokeLinejoin="round"
              />
            </svg>
            <span>Rename</span>
          </button>
          <button
            type="button"
            className="
              session-row-menu-item danger
              flex items-center gap-2 px-2 py-1.5 rounded-sm
              text-[12.5px] text-destructive font-normal
              hover:bg-destructive/15 transition-colors cursor-pointer
            "
            data-testid="row-menu-delete"
            role="menuitem"
            onClick={() => enterConfirmDelete()}
          >
            <svg
              viewBox="0 0 14 14"
              aria-hidden="true"
              className="h-3 w-3 shrink-0 text-destructive"
            >
              <path
                d="M3 4 L11 4 M5 4 L5 2 L9 2 L9 4 M4.5 4 L5 12 L9 12 L9.5 4"
                stroke="currentColor"
                strokeWidth="1.2"
                fill="none"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
            <span>Delete</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
