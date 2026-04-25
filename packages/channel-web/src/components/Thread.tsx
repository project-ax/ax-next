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
} from '@assistant-ui/react';
import type { FC } from 'react';
import { MarkdownText } from './MarkdownText';
import { Composer } from './Composer';

// Empty-state predicate. Hooked to messages.length rather than
// `thread.isEmpty` because the latter returns `false` while the
// runtime is still in `isLoading=true` (init state). For the welcome
// copy we want "no messages yet" to be true from the very first
// frame, not "the runtime has finished loading and there's nothing".
const isThreadEmpty = (s: {
  thread: { messages?: readonly unknown[] };
}): boolean => (s.thread.messages?.length ?? 0) === 0;

export const Thread: FC = () => (
  <ThreadPrimitive.Root className="thread-root">
    <ThreadPrimitive.Viewport className="timeline">
      <AuiIf condition={isThreadEmpty}>
        <ThreadWelcome />
      </AuiIf>
      <ThreadPrimitive.Messages
        components={{ UserMessage, AssistantMessage, EditComposer }}
      />
    </ThreadPrimitive.Viewport>
    <Composer />
  </ThreadPrimitive.Root>
);

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
      <ActionBarPrimitive.Root
        hideWhenRunning
        autohide="not-last"
        className="msg-actions"
      >
        <ActionBarPrimitive.Copy asChild>
          <button type="button" className="msg-action" aria-label="Copy">
            copy
          </button>
        </ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Edit asChild>
          <button type="button" className="msg-action" aria-label="Edit">
            edit
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
      <ActionBarPrimitive.Root
        hideWhenRunning
        autohide="not-last"
        className="msg-actions"
      >
        <ActionBarPrimitive.Copy asChild>
          <button type="button" className="msg-action" aria-label="Copy">
            copy
          </button>
        </ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Reload asChild>
          <button type="button" className="msg-action" aria-label="Retry">
            retry
          </button>
        </ActionBarPrimitive.Reload>
      </ActionBarPrimitive.Root>
    </div>
  </MessagePrimitive.Root>
);

const EditComposer: FC = () => (
  <ComposerPrimitive.Root className="msg-edit">
    <ComposerPrimitive.Input className="msg-edit-input" autoFocus />
    <div className="msg-edit-actions">
      <ComposerPrimitive.Cancel asChild>
        <button type="button" className="msg-edit-cancel">
          cancel
        </button>
      </ComposerPrimitive.Cancel>
      <ComposerPrimitive.Send asChild>
        <button type="button" className="msg-edit-send">
          update
        </button>
      </ComposerPrimitive.Send>
    </div>
  </ComposerPrimitive.Root>
);
