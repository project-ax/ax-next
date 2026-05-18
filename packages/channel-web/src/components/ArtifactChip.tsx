import type { FC } from 'react';
import { Download, FileSymlink, FileText, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface BaseProps {
  variant: 'inline' | 'link';
  conversationId: string;
}

interface ResolvedProps extends BaseProps {
  path: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  artifactId?: string;
}

interface UnknownProps extends BaseProps {
  artifactId: string;
  path?: undefined;
}

export type ArtifactChipProps = ResolvedProps | UnknownProps;

function pickIcon(mediaType: string) {
  if (mediaType.startsWith('image/')) return ImageIcon;
  if (mediaType.startsWith('text/') || mediaType === 'application/json') return FileText;
  return FileSymlink;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadUrl(path: string, conversationId: string): string {
  return `/api/files?path=${encodeURIComponent(path)}&conversationId=${encodeURIComponent(conversationId)}`;
}

export const ArtifactChip: FC<ArtifactChipProps> = (props) => {
  if (!('path' in props) || props.path === undefined) {
    // Unknown artifact — render disabled pill.
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-md',
          'border border-dashed border-border bg-muted/50 px-2 py-0.5',
          'text-[12px] text-muted-foreground',
        )}
        aria-label={`Unknown artifact ${props.artifactId}`}
      >
        <FileSymlink className="size-3" strokeWidth={1.5} aria-hidden="true" />
        unknown artifact
      </span>
    );
  }

  const Icon = pickIcon(props.mediaType);
  const href = downloadUrl(props.path, props.conversationId);

  if (props.variant === 'link') {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          'inline-flex items-center gap-1 align-baseline',
          'underline decoration-dotted underline-offset-2',
          'text-foreground hover:text-primary transition-colors',
        )}
      >
        <Icon className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
        {props.displayName}
      </a>
    );
  }

  // Inline variant — full chip card.
  const onDownload = () => {
    window.open(href, '_blank', 'noopener,noreferrer');
  };
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 max-w-[320px]',
        'rounded-md border border-border bg-card px-2.5 py-1.5 mt-2',
        'text-[12px] leading-tight text-foreground',
      )}
      data-testid="artifact-chip"
    >
      <div className="size-7 shrink-0 rounded-sm bg-muted flex items-center justify-center text-muted-foreground">
        <Icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate font-medium">{props.displayName}</div>
        <div className="font-mono text-[10px] text-muted-foreground">
          {formatSize(props.sizeBytes)}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Download ${props.displayName}`}
        className="size-5 shrink-0 opacity-60 hover:opacity-100"
        onClick={onDownload}
      >
        <Download className="size-3" strokeWidth={1.5} aria-hidden="true" />
      </Button>
    </div>
  );
};
