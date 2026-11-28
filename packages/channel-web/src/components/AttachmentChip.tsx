import type { FC } from 'react';
import { FileTile } from '@project-ax/ui';
import { clampFileName } from '@/lib/attachment-name';

/**
 * AttachmentChip — renders an attachment in the transcript.
 *
 * Two variants:
 *
 *   - `downloadable` (default): given the file's `attachmentId` plus the
 *     `conversationId` it belongs to, builds a
 *     `GET /api/files?conversationId=…&id=…` URL and renders a `FileTile`
 *     chip that is itself the Download button. An `image/*` file is a
 *     `FileTile` card instead, with the image itself as an inline preview,
 *     so it can be seen without downloading it. The id is opaque — the chip only hands it back to
 *     the server, which checks the file belongs to that conversation and to
 *     the person asking.
 *
 *   - `pending`: the live-frame variant — used right after a user hits
 *     send, before the next read brings back the committed copy of the
 *     message. Renders name + icon only; no download. The re-read hands the
 *     chip the file's id, and it becomes the downloadable variant.
 *
 * `displayName` is CLAMPED here, in the component, rather than at each call
 * site (the stem is clamped; `clampFileName` keeps the extension). A filename comes off a person's own disk and has no length limit, and
 * this component spends it on a title attribute and an `aria-label` — a screen
 * reader announcing four hundred characters is its own kind of broken, and the
 * CSS `truncate` on the visible row does nothing about it, because CSS does not
 * touch the accessibility tree. TASK-431 exists because a clamp that used to
 * live at each call site reached only some of them; now the agent view's
 * `AgentConversation` renders through this one sink, which cannot be forgotten.
 *
 * Read that narrowly: it bounds the names THIS chip draws, not every attachment
 * name in the product. The workspace composer's `WorkspaceAttachmentChip`
 * clamps too, independently.
 */
export type AttachmentChipProps =
  | {
      variant?: 'downloadable';
      /** The file's attachment id. Opaque: only ever handed back to `/api/files`. */
      attachmentId: string;
      displayName: string;
      mediaType: string;
      conversationId: string;
      /** Optional sizeBytes — when present, shown as a formatted suffix. */
      sizeBytes?: number;
    }
  | {
      variant: 'pending';
      displayName: string;
      mediaType: string;
    };

function downloadUrl(conversationId: string, attachmentId: string): string {
  return `/api/files?conversationId=${encodeURIComponent(conversationId)}&id=${encodeURIComponent(attachmentId)}`;
}

export const AttachmentChip: FC<AttachmentChipProps> = (props) => {
  const displayName = clampFileName(props.displayName);

  if (props.variant === 'pending') {
    return <FileTile variant="chip" name={displayName} kind={props.mediaType} />;
  }

  const { attachmentId, mediaType, conversationId, sizeBytes } = props;
  const href = downloadUrl(conversationId, attachmentId);

  const onDownload = () => {
    // Use window.open with a sandboxed target so the browser's
    // download UI fires from the Content-Disposition header on the
    // server response. Same-origin, no popup blocker concerns.
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  const size = typeof sizeBytes === 'number' && sizeBytes > 0 ? { size: sizeBytes } : {};
  if (mediaType.startsWith('image/')) {
    return (
      <FileTile variant="card" name={displayName} kind={mediaType} actionLabel="Download" onOpen={onDownload} previewUrl={href} {...size} />
    );
  }
  return <FileTile variant="chip" name={displayName} kind={mediaType} actionLabel="Download" onOpen={onDownload} {...size} />;
};
