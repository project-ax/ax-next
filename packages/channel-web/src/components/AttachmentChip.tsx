import type { FC } from 'react';
import { Download, File as FileIcon, FileText, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface AttachmentChipProps {
  /** Workspace-relative path (e.g. ".ax/uploads/<conv>/<turn>/<file>"). */
  path: string;
  displayName: string;
  mediaType: string;
  conversationId: string;
  /** Optional sizeBytes — when present, shown as a formatted suffix. */
  sizeBytes?: number;
}

function pickIcon(mediaType: string) {
  if (mediaType.startsWith('image/')) return ImageIcon;
  if (mediaType.startsWith('text/') || mediaType === 'application/json') return FileText;
  return FileIcon;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadUrl(path: string, conversationId: string): string {
  return `/api/files?path=${encodeURIComponent(path)}&conversationId=${encodeURIComponent(conversationId)}`;
}

export const AttachmentChip: FC<AttachmentChipProps> = ({
  path,
  displayName,
  mediaType,
  conversationId,
  sizeBytes,
}) => {
  const isImage = mediaType.startsWith('image/');
  const Icon = pickIcon(mediaType);
  const href = downloadUrl(path, conversationId);

  const onDownload = () => {
    // Use window.open with a sandboxed target so the browser's
    // download UI fires from the Content-Disposition header on the
    // server response. Same-origin, no popup blocker concerns.
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  if (isImage) {
    return (
      <button
        type="button"
        aria-label={`Download ${displayName}`}
        onClick={onDownload}
        className={cn(
          'group/chip block max-w-[280px] overflow-hidden',
          'rounded-md border border-border bg-card',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        )}
      >
        <img
          src={href}
          alt={displayName}
          className="block max-h-[200px] w-auto object-contain bg-muted"
        />
        <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-muted-foreground">
          <Icon className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span className="truncate">{displayName}</span>
        </div>
      </button>
    );
  }

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 max-w-[280px]',
        'rounded-md border border-border bg-card px-2.5 py-1.5',
        'text-[12px] leading-tight text-foreground',
      )}
    >
      <div className="size-7 shrink-0 rounded-sm bg-muted flex items-center justify-center text-muted-foreground">
        <Icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate font-medium">{displayName}</div>
        {typeof sizeBytes === 'number' && sizeBytes > 0 && (
          <div className="font-mono text-[10px] text-muted-foreground">
            {formatSize(sizeBytes)}
          </div>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Download ${displayName}`}
        className="size-5 shrink-0 opacity-60 hover:opacity-100"
        onClick={onDownload}
      >
        <Download className="size-3" strokeWidth={1.5} aria-hidden="true" />
      </Button>
    </div>
  );
};
