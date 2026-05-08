/**
 * Composer — fixed-bottom message composer.
 *
 * Visual chrome is Tide-styled (per the design handoff): 28px attach
 * button, 30px send circle, lifted field with focus halo. The
 * interactive guts are assistant-ui's `ComposerPrimitive` — `Send`
 * is wired into the AssistantRuntime provided higher up the tree, so
 * submitting flows through the runtime → transport → backend.
 *
 * Notes:
 *
 *   - The send-button accent toggle uses CSS `:has()` against the
 *     textarea's placeholder state — no JS needed. See `index.css`
 *     (the `.composer-field:has(.composer-input:not(:placeholder-shown))`
 *     rule that flips the send circle from neutral to primary).
 *
 *   - `ThreadPrimitive.If running={...}` swaps Send for Cancel while
 *     a run is in flight. Same pattern as the existing v1 thread.
 *
 *   - Above the field sits `<AgentStatus />` — a slim row that
 *     reflects transient agent state. Lives in the composer wrapper
 *     so it's *outside* the message timeline.
 *
 *   - The form's `onSubmit` intercepts dev-only test triggers
 *     (`/status …`, `/error …`) before assistant-ui sends them as
 *     real messages.
 */
import { useEffect, useRef, useState } from 'react';
import { ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { Paperclip } from 'lucide-react';
import { handleTestTrigger } from '../lib/agent-status-test-triggers';
import { AgentStatus } from './AgentStatus';

function AttachMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        // `attach-btn` class is a structural hook for the body.searching
        // hide rule in index.css until Phase 13 wires search<->composer
        // exclusion through the search store directly.
        className="
          attach-btn group inline-flex items-center justify-center shrink-0
          h-7 w-7 mr-1 rounded-full
          text-muted-foreground transition-colors
          hover:enabled:bg-muted hover:enabled:text-foreground
          aria-expanded:bg-muted aria-expanded:text-foreground
          disabled:cursor-default disabled:opacity-60
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
        "
        aria-label="Attach"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Attach"
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="h-3.5 w-3.5">
          <path
            d="M8 3.5 L8 12.5 M3.5 8 L12.5 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="
            absolute bottom-[calc(100%+8px)] left-0 z-40 min-w-[180px]
            flex flex-col gap-px p-1
            rounded-lg border border-border bg-background shadow-popover
            animate-in fade-in-0 slide-in-from-bottom-1 zoom-in-95 duration-150
          "
        >
          <ComposerPrimitive.AddAttachment asChild>
            <button
              type="button"
              role="menuitem"
              className="
                flex items-center gap-2.5 px-2.5 py-2 rounded-sm cursor-pointer
                text-[13px] text-foreground hover:bg-muted transition-colors
                [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground
              "
              onClick={() => setOpen(false)}
            >
              <Paperclip aria-hidden="true" strokeWidth={1.4} />
              <span>Attach file…</span>
            </button>
          </ComposerPrimitive.AddAttachment>
        </div>
      )}
    </div>
  );
}

export function Composer() {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    if (!import.meta.env.DEV) return;
    const text = inputRef.current?.value.trim() ?? '';
    if (!text.startsWith('/status') && !text.startsWith('/error')) return;
    if (handleTestTrigger(text)) {
      e.preventDefault();
      if (inputRef.current) {
        inputRef.current.value = '';
        inputRef.current.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  };

  return (
    <div
      className="
        composer composer-fade group/composer
        fixed bottom-0 right-[var(--scrollbar-gutter,15px)] left-[240px]
        [body.sidebar-collapsed_&]:left-[56px]
        flex justify-center px-6 pt-10 pb-[22px] z-20
        transition-[left] duration-200
      "
    >
      <ComposerPrimitive.Root
        className="composer-inner relative w-full max-w-[640px]"
        onSubmit={onSubmit}
      >
        <AgentStatus />
        <div
          className="
            composer-field relative flex items-end gap-2.5
            px-3.5 pl-[14px] py-2.5 rounded-lg bg-card
            border border-border shadow-sm transition-[border-color,box-shadow] duration-150
            focus-within:border-primary/40
            focus-within:shadow-[0_0_0_4px_hsl(var(--primary)/0.14),0_1px_2px_hsl(0_0%_0%/0.04)]
          "
        >
          <AttachMenu />
          <ComposerPrimitive.Input
            placeholder="Message ax…"
            // `composer-input` class is the hook for the field's :has()
            // ready-state rule in index.css.
            className="
              composer-input flex-1 min-w-0 resize-none border-0 outline-none bg-transparent
              text-foreground text-[15px] leading-[1.55] py-0.5
              min-h-7 max-h-[200px]
              placeholder:text-muted-foreground
            "
            autoFocus
            rows={1}
            ref={inputRef}
          />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send asChild>
              <button
                type="button"
                data-send=""
                aria-label="Send"
                className="
                  inline-flex items-center justify-center shrink-0
                  h-[30px] w-[30px] rounded-full bg-ink-ghost text-background
                  transition-[background-color,transform,filter] duration-150
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
                "
              >
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="h-3.5 w-3.5">
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
                aria-label="Stop"
                className="
                  inline-flex items-center justify-center shrink-0
                  h-[30px] w-[30px] rounded-full bg-primary text-primary-foreground
                  transition-transform duration-150 hover:scale-105
                "
              >
                <svg viewBox="0 0 10 10" fill="currentColor" aria-hidden="true" className="h-2.5 w-2.5">
                  <rect width="10" height="10" rx="1" />
                </svg>
              </button>
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </div>
        <div
          className="
            mt-2 text-center text-[10.5px] tracking-[0.04em] text-ink-ghost pointer-events-none
            opacity-0 transition-opacity duration-150
            group-hover/composer:opacity-100 group-focus-within/composer:opacity-100
          "
        >
          <kbd className="font-mono text-[10px] text-muted-foreground">⏎</kbd> send ·{' '}
          <kbd className="font-mono text-[10px] text-muted-foreground">⇧⏎</kbd> newline
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}
