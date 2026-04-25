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
import { ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react';

export function Composer() {
  return (
    <div className="composer">
      <ComposerPrimitive.Root className="composer-inner">
        <div className="composer-field">
          <button
            type="button"
            className="attach-btn"
            aria-label="Attach"
            tabIndex={-1}
            disabled
          >
            <span aria-hidden="true">+</span>
          </button>
          <ComposerPrimitive.Input
            placeholder="Message tide…"
            className="composer-input"
            autoFocus
            rows={1}
          />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send asChild>
              <button type="button" className="send-btn" aria-label="Send">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path
                    d="M2 7h10M8 3l4 4-4 4"
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
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="currentColor"
                >
                  <rect width="10" height="10" rx="1" />
                </svg>
              </button>
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}
