/**
 * Thread — assistant-ui Thread root + welcome empty state + message
 * styling per the Tide design.
 *
 * Wraps `ThreadPrimitive.Root` / `Viewport` / `Messages` and provides
 * the welcome empty state, user/assistant message variants, and the
 * inline edit composer for user-message edit-in-place. The Composer is
 * mounted as a sibling of the timeline so it can be `position: fixed`
 * over the viewport.
 *
 * Notes:
 *
 *   - User messages get a muted-bubble background (`msg.you .msg-body`);
 *     assistant messages flow inline as plain prose. No avatars, no
 *     meta column.
 *
 *   - Action bars autohide unless the message is hovered or focused.
 *     User messages have copy + edit; assistant messages have copy +
 *     retry + thinking-toggle.
 *
 *   - `EditComposer` renders the inline edit-in-place UI when a user
 *     clicks the edit action. Replaces the user message in the message
 *     list while editing.
 *
 *   - Class names like `msg`, `msg.you`, `msg-error`, `timeline` are
 *     kept as test hooks (no CSS targets them — Tailwind drives the
 *     styling).
 */
import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAttachment,
  useMessage,
} from '@assistant-ui/react';
import { Brain, Check, Copy, Pencil, RotateCcw } from 'lucide-react';
import type { FC } from 'react';
import { useSearchStore } from '../lib/search-store';
import { thinkingStoreActions, useThinkingStore } from '../lib/thinking-store';
import { MarkdownText } from './MarkdownText';
import { Composer } from './Composer';
import { SearchBar } from './SearchBar';
import { ArtifactPublishTool, ToolFallback, ToolGroup } from './ToolUse';
import { AttachmentChip } from './AttachmentChip';
import { decodeAttachmentPath } from '../lib/history-adapter';
import { useConversationId } from '../lib/use-conversation-id';

const MSG_ACTION_CLASS =
  'msg-action inline-flex items-center justify-center cursor-pointer h-[22px] w-[22px] rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors data-[copied=true]:text-primary [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:block [&[data-copied=true]_.msg-action-icon-copy]:hidden [&:not([data-copied])_.msg-action-icon-check]:hidden';

const MessageTime: FC = () => {
  const ts = useMessage((m) => m.createdAt);
  if (!ts) return null;
  const text = ts
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .toLowerCase();
  return <span className="msg-time pr-1">{text}</span>;
};

const isThreadEmpty = (s: {
  thread: { messages?: readonly unknown[] };
}): boolean => (s.thread.messages?.length ?? 0) === 0;

export const Thread: FC = () => {
  const { open: searchOpen, query } = useSearchStore();
  return (
    <ThreadPrimitive.Root className="thread-root flex flex-col flex-1 min-h-0">
      {searchOpen && <SearchBar />}
      {searchOpen && query.length > 0 && (
        <div
          role="status"
          className="px-6 py-2 text-xs font-mono tracking-[0.01em] text-muted-foreground bg-muted border-b border-border"
        >
          Showing all messages — text filtering will land when assistant-ui
          exposes a stable message-iteration API.
        </div>
      )}
      <ThreadPrimitive.Viewport className="flex-1 w-full min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="timeline w-full max-w-[640px] mx-auto px-6 pt-6 pb-[220px]">
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
  <div className="text-center pt-16 pb-10 text-[13.5px] text-muted-foreground">
    <div className="text-[22px] font-medium tracking-[-0.01em] text-foreground mb-1.5">
      One conversation.
    </div>
    <div className="text-muted-foreground">Say anything.</div>
  </div>
);

/**
 * Adapter from assistant-ui's `FileMessagePart` shape to `AttachmentChip`.
 * The history adapter (Task 6) encodes `ax://attachment-path/<base64url>`
 * URLs into the `data` slot so the renderer can decode them back to a
 * workspace path and build `GET /api/files` URLs at render time.
 *
 * Falls back to a small text marker when the URL doesn't carry a known
 * `ax://` prefix or when no conversation id is in play yet — we never
 * silently drop the user's attachment from the transcript.
 *
 * Accepts both `mediaType` (history-adapter path / AI SDK UIMessage shape)
 * and `mimeType` (assistant-ui's canonical `FileMessagePart` shape) since
 * the path the part travels depends on whether the message comes from
 * `useLocalRuntime` / `initialMessages` or the live AI SDK bridge.
 */
interface FileMessagePartLike {
  data?: string;
  url?: string;
  mediaType?: string;
  mimeType?: string;
  filename?: string;
}

const UserFilePart: FC<FileMessagePartLike> = (props) => {
  const conversationId = useConversationId();
  const url = props.data ?? props.url ?? '';
  const path = decodeAttachmentPath(url);
  const mediaType =
    props.mediaType ?? props.mimeType ?? 'application/octet-stream';
  if (path === null || conversationId === null) {
    return (
      <span className="text-xs text-muted-foreground italic">
        [attachment: {props.filename ?? 'unknown'}]
      </span>
    );
  }
  return (
    <AttachmentChip
      path={path}
      displayName={props.filename ?? 'file'}
      mediaType={mediaType}
      conversationId={conversationId}
    />
  );
};

/**
 * LiveAttachmentChip — `MessagePrimitive.Attachments` slot renderer for
 * the **live frame** right after a user hits send. The AI SDK bridge
 * (`@assistant-ui/react-ai-sdk`'s `convertMessage`) routes user-message
 * file parts into the message's `attachments` array (not `content.parts`),
 * so `UserFilePart` doesn't fire until after a page reload — when the
 * history-load adapter rewrites the `attachment` blocks back into `file`
 * parts on `content.parts`.
 *
 * The live-frame attachment carries `data: ax://attachment/<attachmentId>`
 * (the attachmentId, not a workspace path), so we can't build a
 * `GET /api/files?path=…` URL yet. We render display name + icon only.
 * After reload, the downloadable chip takes over.
 */
interface LiveAttachmentLike {
  name?: string;
  contentType?: string;
  content?: ReadonlyArray<{
    type?: string;
    data?: string;
    filename?: string;
    mimeType?: string;
  }>;
}

const LiveAttachmentChip: FC = () => {
  // useAttachment with no selector args reads the current AttachmentState
  // for this slot; we narrow to our shape via a cast. No download in the
  // live frame — the history-load path (UserFilePart) takes over after
  // reload.
  const a = useAttachment() as unknown as LiveAttachmentLike;
  const filename = a.content?.[0]?.filename ?? a.name ?? 'file';
  const mediaType =
    a.content?.[0]?.mimeType ?? a.contentType ?? 'application/octet-stream';
  return (
    <AttachmentChip
      variant="pending"
      displayName={filename}
      mediaType={mediaType}
    />
  );
};

const UserMessage: FC = () => (
  <MessagePrimitive.Root asChild>
    <div className="msg you mb-[22px] flex flex-col items-end relative max-w-full" data-role="user">
      <MessagePrimitive.Attachments
        components={{ Attachment: LiveAttachmentChip }}
      />
      <div
        className="
          msg-body bg-muted text-foreground px-3 py-[7px] rounded-md max-w-[78%]
          font-sans text-[15px] leading-[1.6] whitespace-pre-wrap break-words
        "
      >
        <MessagePrimitive.Parts
          components={{ Text: MarkdownText, File: UserFilePart }}
        />
      </div>
      <ActionBarPrimitive.Root
        className="
          msg-actions justify-end flex items-center gap-2 mt-1
          font-mono text-[11px] tracking-[0.02em] text-ink-ghost whitespace-nowrap
          opacity-0 transition-opacity duration-150
          [.msg:hover_&]:opacity-100 has-[:focus-visible]:opacity-100
        "
      >
        <MessageTime />
        <ActionBarPrimitive.Copy asChild copiedDuration={1000}>
          <button type="button" className={MSG_ACTION_CLASS} aria-label="Copy" title="Copy">
            <Copy size={13} aria-hidden="true" className="msg-action-icon-copy" strokeWidth={1.4} />
            <Check size={13} aria-hidden="true" className="msg-action-icon-check" strokeWidth={1.4} />
          </button>
        </ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Edit asChild>
          <button type="button" className={MSG_ACTION_CLASS} aria-label="Edit" title="Edit">
            <Pencil size={13} aria-hidden="true" strokeWidth={1.4} />
          </button>
        </ActionBarPrimitive.Edit>
      </ActionBarPrimitive.Root>
    </div>
  </MessagePrimitive.Root>
);

const ThinkingToggle: FC = () => {
  const { visible } = useThinkingStore();
  const label = visible ? 'Hide thinking' : 'Show thinking';
  return (
    <button
      type="button"
      className={`${MSG_ACTION_CLASS} ${visible ? 'text-foreground bg-muted' : ''}`}
      data-testid="thinking-toggle"
      aria-pressed={visible ? 'true' : 'false'}
      aria-label={label}
      title={label}
      onClick={() => thinkingStoreActions.toggle()}
    >
      <Brain size={13} aria-hidden="true" strokeWidth={1.4} />
    </button>
  );
};

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root asChild>
    <div className="msg agent mb-[22px] relative max-w-full" data-role="assistant">
      <div
        className="
          msg-body font-sans text-[15px] leading-[1.55] tracking-[-0.008em]
          text-foreground max-w-[56ch]
          whitespace-pre-wrap break-words
        "
      >
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            tools: {
              by_name: { artifact_publish: ArtifactPublishTool },
              Fallback: ToolFallback,
            },
            ToolGroup,
          }}
        />
      </div>
      <ActionBarPrimitive.Root
        className="
          msg-actions flex items-center gap-2 mt-1
          font-mono text-[11px] tracking-[0.02em] text-ink-ghost whitespace-nowrap
          opacity-0 transition-opacity duration-150
          [.msg:hover_&]:opacity-100 has-[:focus-visible]:opacity-100
        "
      >
        <MessageTime />
        <ActionBarPrimitive.Copy asChild copiedDuration={1000}>
          <button type="button" className={MSG_ACTION_CLASS} aria-label="Copy" title="Copy">
            <Copy size={13} aria-hidden="true" className="msg-action-icon-copy" strokeWidth={1.4} />
            <Check size={13} aria-hidden="true" className="msg-action-icon-check" strokeWidth={1.4} />
          </button>
        </ActionBarPrimitive.Copy>
        <ActionBarPrimitive.Reload asChild>
          <button type="button" className={MSG_ACTION_CLASS} aria-label="Retry" title="Retry">
            <RotateCcw size={13} aria-hidden="true" strokeWidth={1.4} />
          </button>
        </ActionBarPrimitive.Reload>
        <ThinkingToggle />
      </ActionBarPrimitive.Root>
    </div>
  </MessagePrimitive.Root>
);

const EditComposer: FC = () => (
  <ComposerPrimitive.Root className="msg you msg-edit mb-[22px] flex flex-col items-end relative">
    <ComposerPrimitive.Input
      className="
        msg-edit-input resize-none border-0 outline-none
        bg-muted text-foreground font-sans text-[15px] leading-[1.6]
        px-3 py-[7px] rounded-md
        max-w-[78%] min-w-0 box-border
        [field-sizing:content] w-auto
        placeholder:text-muted-foreground
        shadow-[0_0_0_2px_hsl(var(--primary)/0.35)]
      "
      autoFocus
      rows={1}
    />
  </ComposerPrimitive.Root>
);
