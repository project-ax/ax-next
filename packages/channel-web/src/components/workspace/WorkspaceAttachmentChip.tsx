import type { FC } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { FileTile, IconButton } from '@project-ax/ui';
import { clampAttachmentName } from '@/lib/attachment-name';
import type { WorkspaceAttachment } from '@/lib/workspace-attachments';

/**
 * One file waiting to go to the agent, on the workspace composer.
 *
 * This takes a plain prop rather than reading from a runtime's attachment
 * context, because the workspace surface mounts no such runtime. It also has
 * a third state the deleted chat UI's equivalent chip never needed: chat's
 * adapter could only be running or done, so a file the server refused had
 * nowhere to say so. Here it says so, in a sentence, with a Try again next to it.
 *
 * Drawn as a `FileTile` chip: uploading shows a progress bar, uploaded says
 * "Ready to send", failed prints the reason as real (danger) text — never a
 * tooltip or a `title=`, which are invisible on touch and to anyone who does
 * not hover. The chip's second line is a polite live region, so the change
 * to "Ready to send" or to the reason is announced. Remove (and Try again)
 * sit in the chip's trailing slot, beside the file, never on top of it.
 */

interface WorkspaceAttachmentChipProps {
  attachment: WorkspaceAttachment;
  onRemove: () => void;
  onRetry: () => void;
}

const STATUS = { uploading: 'working', uploaded: 'ready', failed: 'failed' } as const;

export const WorkspaceAttachmentChip: FC<WorkspaceAttachmentChipProps> = ({
  attachment,
  onRemove,
  onRetry,
}) => {
  // Untrusted text, rendered as a React child so it is escaped.
  const name = clampAttachmentName(attachment.name);
  const isUploading = attachment.status === 'uploading';
  const isFailed = attachment.status === 'failed';
  const detail = isFailed ? attachment.message : attachment.status === 'uploaded' ? 'Ready to send' : null;

  return (
    <FileTile
      variant="chip"
      name={name}
      kind={attachment.contentType}
      status={STATUS[attachment.status]}
      {...(detail !== null ? { detail } : {})}
      {...(isUploading ? { progress: Math.round(attachment.progress * 100) } : {})}
      trailing={
        isFailed ? (
          <>
            <IconButton label="Try again" icon={RotateCcw} size="sm" onClick={onRetry} />
            <IconButton label="Remove" icon={X} size="sm" onClick={onRemove} />
          </>
        ) : (
          <IconButton label={`Remove ${name}`} icon={X} size="sm" onClick={onRemove} />
        )
      }
    />
  );
};
