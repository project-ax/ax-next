/**
 * Thread — assistant-ui Thread root + welcome empty state + message
 * styling per Tide (Task 18).
 *
 * Wraps `ThreadPrimitive.Root` / `Viewport` / `Messages` and provides the
 * Tide-styled welcome empty state, user/assistant message variants, and
 * the inline edit composer for user-message edit-in-place. The Composer
 * is mounted as a sibling of `.timeline` so it can be `position: fixed`
 * over the viewport and reveal scroll-fade behavior in front of it.
 *
 * Notes:
 *
 *   - User messages get a `you-wash` background bubble (`.msg.you
 *     .msg-body`); assistant messages flow inline as plain prose
 *     (`.msg.agent .msg-body`). This is Tide — no avatars, no meta
 *     column, no "Assistant:" labels. Just text.
 *
 *   - Action bars (`.msg-actions`) live at the bottom of each message
 *     and autohide unless the message is the last in the thread. User
 *     messages have copy + edit; assistant messages have copy + retry.
 *
 *   - `EditComposer` renders the inline edit-in-place UI (cancel +
 *     update buttons) when a user clicks the edit action. It replaces
 *     the user message in the message list while editing.
 *
 *   - `ThreadPrimitive.If empty` is the welcome branch — once any
 *     message exists, the welcome is hidden and `Messages` renders the
 *     timeline.
 *
 * Reference: v1's `~/dev/ai/ax/ui/chat/src/components/thread.tsx`. We
 * borrow the structure (root → viewport → if-empty welcome → messages →
 * composer) but Tide's design replaces v1's tailwind chrome wholesale.
 */
import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessage,
} from '@assistant-ui/react';
import { Check, Copy, Pencil, RotateCcw } from 'lucide-react';
import type { FC } from 'react';
import { useSearchStore } from '../lib/search-store';
import { MarkdownText } from './MarkdownText';
import { Composer } from './Composer';
import { SearchBar } from './SearchBar';

/**
 * MessageTime — renders the message createdAt as a lowercase clock-time
 * label (e.g., "9:12 am") in the message footer. Mirrors Tide Sessions.html.
 */
const MessageTime: FC = () => {
  const ts = useMessage((m) => m.createdAt);
  if (!ts) return null;
  const text = ts
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .toLowerCase();
  return <span className="msg-time">{text}</span>;
};

// Empty-state predicate. Hooked to messages.length rather than
// `thread.isEmpty` because the latter returns `false` while the
// runtime is still in `isLoading=true` (init state). For the welcome
// copy we want "no messages yet" to be true from the very first
// frame, not "the runtime has finished loading and there's nothing".
const isThreadEmpty = (s: {
  thread: { messages?: readonly unknown[] };
}): boolean => (s.thread.messages?.length ?? 0) === 0;

export const Thread: FC = () => {
  // Search bar lives above the timeline rather than inside the composer.
  // Plan suggested either placement; banner above the viewport is the
  // less-invasive choice — the composer doesn't need to know about
  // search state, and CSS hides .attach-btn via body.searching anyway.
  //
  // TODO(assistant-ui): wire actual message-text filtering here when
  // assistant-ui exposes a stable message-iteration API. Today there's
  // no clean way to read+filter messages from the runtime store without
  // reaching into private internals, so we show a "filter active" banner
  // and defer the substring match until we can do it without leakage.
  const { open: searchOpen, query } = useSearchStore();
  return (
    <ThreadPrimitive.Root className="thread-root">
      {searchOpen && <SearchBar />}
      {searchOpen && query.length > 0 && (
        <div className="search-results-banner" role="status">
          Showing all messages — text filtering will land when assistant-ui
          exposes a stable message-iteration API.
        </div>
      )}
      <ThreadPrimitive.Viewport className="timeline-scroll">
        {/* The Viewport is the full-pane-width scroll container so the
            scrollbar sits flush with the right edge of the pane (matches
            the design). The inner `.timeline` keeps the messages centered
            within a 640px column. */}
        <div className="timeline">
          <AuiIf condition={isThreadEmpty}>
            <ThreadWelcome />
          </AuiIf>
          <ThreadPrimitive.Messages
            components={{ UserMessage, AssistantMessage, EditComposer }}
          />
        </div>
      </ThreadPrimitive.Viewport>
      <Composer />
    </ThreadPrimitive.Root>
  );
};

const ThreadWelcome: FC = () => (
  <div className="thread-welcome">
    <div className="thread-welcome-big">One conversation.</div>
    <div className="thread-welcome-sub">Say anything.</div>
  </div>
);

const UserMessage: FC = () => (
  <MessagePrimitive.Root asChild>
    <div className="msg you" data-role="user">
      <div className="msg-body">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
      <ActionBarPrimitive.Root className="msg-actions">
        <MessageTime />
        <ActionBarPrimitive.Copy asChild copiedDuration={1000}>
          <button type="button" className="msg-action" aria-label="Copy" title="Copy">
            <Copy size={13} aria-hidden="true" className="msg-action-icon-copy" />
            <Check size={13} aria-hidden="true" className="msg-action-icon-check" />
          </button>
        </ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Edit asChild>
          <button type="button" className="msg-action" aria-label="Edit" title="Edit">
            <Pencil size={13} aria-hidden="true" />
          </button>
        </ActionBarPrimitive.Edit>
      </ActionBarPrimitive.Root>
    </div>
  </MessagePrimitive.Root>
);

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root asChild>
    <div className="msg agent" data-role="assistant">
      <div className="msg-body">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
      <ActionBarPrimitive.Root className="msg-actions">
        <MessageTime />
        <ActionBarPrimitive.Copy asChild copiedDuration={1000}>
          <button type="button" className="msg-action" aria-label="Copy" title="Copy">
            <Copy size={13} aria-hidden="true" className="msg-action-icon-copy" />
            <Check size={13} aria-hidden="true" className="msg-action-icon-check" />
          </button>
        </ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Reload asChild>
          <button type="button" className="msg-action" aria-label="Retry" title="Retry">
            <RotateCcw size={13} aria-hidden="true" />
          </button>
        </ActionBarPrimitive.Reload>
      </ActionBarPrimitive.Root>
    </div>
  </MessagePrimitive.Root>
);

/**
 * EditComposer — in-place edit for user messages.
 *
 * Visually mirrors the user message bubble (right-aligned, you-wash background)
 * with an accent halo to signal edit mode. No visible cancel/update buttons —
 * Enter commits (ComposerPrimitive default), Escape cancels (cancelOnEscape).
 * Mirrors the Tide design's `.msg-body.editing` in-place edit pattern.
 */
const EditComposer: FC = () => (
  <ComposerPrimitive.Root className="msg you msg-edit">
    <ComposerPrimitive.Input
      className="msg-edit-input"
      autoFocus
      rows={1}
    />
  </ComposerPrimitive.Root>
);
