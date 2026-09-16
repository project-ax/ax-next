/**
 * Module-level singleton that fires a single "let's get started" user message
 * the first time the chat runtime mounts after a new agent is bootstrapped.
 *
 * Problem: when FirstRunAutoCreate calls onDone() the chat shell hasn't rendered
 * yet, so there's no runtime/thread to append to. This module bridges that gap
 * with the same pending-registration pattern used by resumeActions: trigger()
 * stores the intent; register() fires it immediately if already pending.
 *
 * Lifecycle:
 *   App.tsx         → bootstrapKickoff.trigger()   (in FirstRunAutoCreate onDone)
 *   runtime.tsx     → bootstrapKickoff.register()  (in useChatThreadRuntime useEffect on mount)
 *                  → bootstrapKickoff.unregister() (cleanup on unmount)
 *
 * This bridge is the **chat runtime's** kickoff path, and only that path.
 * `register()` has exactly one caller, `useChatThreadRuntime` in
 * `lib/runtime.tsx`, and assistant-ui only invokes that hook from inside its
 * `_RuntimeBinder` — reached via the runtime core's `RenderComponent`, i.e.
 * only under an `AssistantRuntimeProvider`. The workspace branch of `App.tsx`
 * deliberately mounts none, so on that path `register()` never runs:
 * `trigger()` just sets `_pending = true` and the kickoff is silently
 * dropped. The workspace therefore sends its own kickoff through
 * `workspaceApi.sendMessage` (see `WorkspaceShell`), not through this module.
 */

type AppendFn = (text: string) => void;

let _append: AppendFn | null = null;
let _pending = false;

/**
 * The first message a freshly-bootstrapped agent receives. One spelling,
 * exported, because both the chat runtime (via this module) and the
 * workspace (via `workspaceApi.sendMessage`) now send it.
 */
export const KICKOFF_TEXT = 'hi';

export const bootstrapKickoff = {
  /**
   * Schedule a kickoff message. If the chat runtime is already registered,
   * fires immediately; otherwise stores the intent for when it mounts.
   */
  trigger() {
    if (_append) {
      _append(KICKOFF_TEXT);
    } else {
      _pending = true;
    }
  },

  /** Called by useChatThreadRuntime on mount to register the live append fn. */
  register(fn: AppendFn) {
    _append = fn;
    if (_pending) {
      _pending = false;
      fn(KICKOFF_TEXT);
    }
  },

  /** Called by useChatThreadRuntime on unmount. */
  unregister() {
    _append = null;
  },
};
