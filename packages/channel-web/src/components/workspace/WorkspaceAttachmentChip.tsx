import type { FC } from 'react';
import {
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { clampAttachmentName } from '@/lib/attachment-name';
import type { WorkspaceAttachment } from '@/lib/workspace-attachments';

/**
 * One file waiting to go to the agent, on the workspace composer.
 *
 * Shaped after `AttachmentComposerChip` so the two composers read as one
 * product — but this one takes a plain prop instead of assistant-ui's
 * attachment context, because the workspace surface has no
 * `AssistantRuntimeProvider` to read from. It also has a third state that
 * chip never needed: chat's adapter can only be running or done, so a file
 * the server refused had nowhere to say so. Here it says so, in a sentence,
 * with a Retry next to it.
 */

function pickIcon(mediaType: string) {
  if (mediaType.startsWith('image/')) return ImageIcon;
  if (mediaType.startsWith('text/') || mediaType === 'application/json') {
    return FileText;
  }
  return FileIcon;
}

interface WorkspaceAttachmentChipProps {
  attachment: WorkspaceAttachment;
  onRemove: () => void;
  onRetry: () => void;
}

export const WorkspaceAttachmentChip: FC<WorkspaceAttachmentChipProps> = ({
  attachment,
  onRemove,
  onRetry,
}) => {
  const name = clampAttachmentName(attachment.name);
  const Icon = pickIcon(attachment.contentType);
  const isUploading = attachment.status === 'uploading';
  const isUploaded = attachment.status === 'uploaded';
  const isFailed = attachment.status === 'failed';

  return (
    <div
      data-status={attachment.status}
      className={cn(
        'flex w-full max-w-[280px] flex-col gap-1.5 rounded-md border bg-card px-2 py-1.5',
        'text-[12px] leading-tight text-foreground',
        isFailed ? 'border-destructive' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-sm bg-muted',
            isFailed ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          <Icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Untrusted text, rendered as a React child so it is escaped. */}
          <div
            data-slot="attachment-name"
            className="truncate font-medium text-foreground"
          >
            {name}
          </div>
          {isUploading && (
            <Progress
              value={Math.round(attachment.progress * 100)}
              className="h-1 w-full"
            />
          )}
          {isUploaded && (
            <div className="truncate text-muted-foreground">Ready to send</div>
          )}
        </div>
        {!isFailed && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${name}`}
            className="size-5 shrink-0 opacity-60 hover:opacity-100"
            onClick={onRemove}
          >
            <X className="size-3" strokeWidth={1.5} aria-hidden="true" />
          </Button>
        )}
      </div>
      {isFailed && (
        <div className="flex flex-col gap-1.5">
          {/*
            Real text, not a tooltip and not a `title=`. A title attribute is
            invisible on touch, invisible to anyone who does not hover, and
            this sentence is the only thing telling the person their file is
            not going anywhere.
          */}
          <p className="text-destructive">{attachment.message}</p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2"
              onClick={onRetry}
            >
              Retry
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={onRemove}
            >
              Remove
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
