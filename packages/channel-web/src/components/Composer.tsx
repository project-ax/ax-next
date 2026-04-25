/**
 * Composer — fixed-bottom message composer (Task 17).
 *
 * Visual chrome is Tide-styled (`design_handoff_tide/Tide Sessions.html`):
 * 28px attach button, 30px send circle, surface-raised field with focus
 * halo. The interactive guts are assistant-ui's `ComposerPrimitive` —
 * `Send` is wired into the `AssistantRuntime` provided higher up the
 * tree, so submitting flows through the runtime → transport → backend.
 *
 * Notes:
 *
 *   - Attach button is `disabled` and `tabIndex={-1}` for now. File
 *     uploads aren't in MVP scope (Task 28+). The button stays in the
 *     markup so the visual layout matches the design.
 *
 *   - The send-button accent toggle uses CSS `:has()` against the
 *     textarea's placeholder state — no JS needed. See `index.css`.
 *
 *   - `ThreadPrimitive.If running={...}` is what swaps Send for Cancel
 *     while a run is in flight. Same pattern v1 uses (thread.tsx ~157).
 */
import { useEffect, useRef, useState } from 'react';
import { ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { Paperclip } from 'lucide-react';

function AttachMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Outside click closes the menu — same pattern as UserMenu/AgentMenu.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="attach-btn"
        aria-label="Attach"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Attach"
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 3.5 L8 12.5 M3.5 8 L12.5 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open && (
        <div className="attach-menu" role="menu">
          <ComposerPrimitive.AddAttachment asChild>
            <button
              type="button"
              className="attach-menu-item"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              <Paperclip aria-hidden="true" />
              <span>Attach file…</span>
            </button>
          </ComposerPrimitive.AddAttachment>
        </div>
      )}
    </div>
  );
}

export function Composer() {
  return (
    <div className="composer">
      <ComposerPrimitive.Root className="composer-inner">
        <div className="composer-field">
          <AttachMenu />
          <ComposerPrimitive.Input
            placeholder="Message tide…"
            className="composer-input"
            autoFocus
            rows={1}
          />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send asChild>
              <button type="button" className="send-btn" aria-label="Send">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M3 8 L12 8 M8 4 L12 8 L8 12"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel asChild>
              <button
                type="button"
                className="send-btn cancel"
                aria-label="Stop"
              >
                <svg viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
                  <rect width="10" height="10" rx="1" />
                </svg>
              </button>
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </div>
        <div className="composer-hint">
          <kbd>⏎</kbd> send · <kbd>⇧⏎</kbd> newline
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}
