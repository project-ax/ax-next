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
 */

type AppendFn = (text: string) => void;

let _append: AppendFn | null = null;
let _pending = false;

const KICKOFF_TEXT = 'hi';

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
