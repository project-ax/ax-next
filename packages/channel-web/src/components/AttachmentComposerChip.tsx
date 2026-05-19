import type { FC } from 'react';
import {
  AttachmentPrimitive,
  useAttachment,
} from '@assistant-ui/react';
import {
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

/**
 * Frozen snapshot of the assistant-ui attachment shape we render from.
 * Mirrors `AttachmentState` from `@assistant-ui/core` closely enough
 * that the chip can render either a context-supplied attachment or a
 * test-injected stub through the same code path.
 */
interface AttachmentLike {
  id: string;
  name: string;
  contentType?: string;
  type: 'image' | 'video' | 'audio' | 'document' | 'file' | (string & {});
  status: {
    type: 'running' | 'requires-action' | 'complete' | 'incomplete';
    reason?: string;
    progress?: number;
  };
}

interface AttachmentComposerChipProps {
  /**
   * Test-only escape hatch — when set, the chip renders against this
   * frozen attachment state instead of pulling from the assistant-ui
   * attachment-runtime context. Production composers never pass this;
   * `ComposerPrimitive.Attachments` supplies the context naturally
   * through the `components.Attachment` slot.
   */
  _testAttachment?: AttachmentLike;
}

function pickIcon(mediaType: string | undefined) {
  if (!mediaType) return FileIcon;
  if (mediaType.startsWith('image/')) return ImageIcon;
  if (mediaType.startsWith('text/') || mediaType === 'application/json') {
    return FileText;
  }
  return FileIcon;
}

export const AttachmentComposerChip: FC<AttachmentComposerChipProps> = ({
  _testAttachment,
}) => {
  // useAttachment is gated by an attachment-runtime context — when
  // present, returns the live `AttachmentState`; with `optional: true`
  // it returns `null` outside the context (i.e., in the unit-test
  // harness below). The `_testAttachment` prop short-circuits to a
  // frozen stub so the chip remains renderable in isolation.
  const ctxAttachment = useAttachment({ optional: true }) as
    | AttachmentLike
    | null;
  const attachment = _testAttachment ?? ctxAttachment;
  if (!attachment) return null;

  // `AttachmentPrimitive.unstable_Thumb` reads from the assistant-ui
  // attachment-state via context — it will throw if mounted without a
  // surrounding `AttachmentPrimitive.Root`. In production the
  // `ComposerPrimitive.Attachments` slot wraps each rendered
  // `components.Attachment` in a Root automatically; in unit tests
  // (`_testAttachment` path) no Root is present, so we render the
  // file-icon placeholder instead and keep the deterministic
  // `data-variant` signal.
  const hasRuntimeContext = ctxAttachment !== null;
  const isImage = (attachment.contentType ?? '').startsWith('image/');
  const Icon = pickIcon(attachment.contentType);
  const isUploading = attachment.status.type === 'running';
  const progress =
    isUploading && typeof attachment.status.progress === 'number'
      ? Math.round(attachment.status.progress * 100)
      : null;

  return (
    <div
      data-variant={isImage ? 'image' : 'file'}
      className={cn(
        'group/chip relative flex max-w-[220px] items-center gap-2',
        'rounded-md border border-border bg-card px-2 py-1.5',
        'text-[12px] leading-tight text-foreground',
      )}
    >
      {isImage && hasRuntimeContext ? (
        <AttachmentPrimitive.unstable_Thumb
          className="size-7 shrink-0 rounded-sm bg-muted object-cover"
        />
      ) : (
        <div className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground">
          <Icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground">
          {attachment.name}
        </div>
        {isUploading && progress !== null && (
          <Progress value={progress} className="mt-0.5 h-1 w-full" />
        )}
      </div>
      <AttachmentPrimitive.Remove asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Remove attachment"
          className="size-5 shrink-0 opacity-60 hover:opacity-100"
        >
          <X className="size-3" strokeWidth={1.5} aria-hidden="true" />
        </Button>
      </AttachmentPrimitive.Remove>
    </div>
  );
};
