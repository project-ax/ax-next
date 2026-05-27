import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { diffLines, type BundleFileEntry } from '@/lib/bundle-diff';

const STATUS_VARIANT: Record<BundleFileEntry['status'], 'secondary' | 'outline' | 'destructive'> = {
  added: 'secondary',
  modified: 'secondary',
  unchanged: 'outline',
  removed: 'destructive',
};

/**
 * Cap on the number of diff lines RENDERED as DOM nodes. Bundle contents are
 * UNTRUSTED and a single file may be up to 256 KiB — a file that is mostly
 * newlines yields hundreds of thousands of diff lines. diffLines already bounds
 * the *computation*, but rendering one <div> per line would still freeze the
 * admin review dialog when an admin opens such a share. Above this cap we render
 * the first MAX_RENDERED_DIFF_LINES rows and a truncation notice — the reviewer
 * sees the file is oversized and is told the remainder is not shown inline
 * (honest, never silent, and bounded DOM).
 */
const MAX_RENDERED_DIFF_LINES = 500;

/**
 * Renders one bundle file's body. Contents are UNTRUSTED — they render as
 * escaped text inside a <pre> (React text nodes), never as HTML.
 */
function FileBody({ entry }: { entry: BundleFileEntry }) {
  if (entry.status === 'unchanged') {
    return <p className="text-xs text-muted-foreground px-3 py-2">Unchanged.</p>;
  }
  // added → all-add diff; removed → all-remove diff; modified → real diff.
  const lines = diffLines(entry.before ?? '', entry.after ?? '');
  const shown = lines.slice(0, MAX_RENDERED_DIFF_LINES);
  const hidden = lines.length - shown.length;
  return (
    <pre className="font-mono text-xs leading-relaxed overflow-auto max-h-[320px] m-0 p-0">
      {shown.map((l, i) => (
        <div
          key={i}
          data-diff-line
          className={cn(
            'px-3 whitespace-pre-wrap break-words',
            l.type === 'add' && 'bg-primary-soft text-primary',
            l.type === 'remove' && 'bg-destructive-soft text-destructive',
            l.type === 'context' && 'text-muted-foreground',
          )}
        >
          {l.type === 'add' ? '+ ' : l.type === 'remove' ? '- ' : '  '}
          {l.text}
        </div>
      ))}
      {hidden > 0 && (
        <div className="px-3 py-1.5 text-xs text-muted-foreground bg-muted/40 border-t border-border">
          … {hidden.toLocaleString()} more line{hidden === 1 ? '' : 's'} not shown inline (file too
          large to diff in full).
        </div>
      )}
    </pre>
  );
}

export function BundleDiffView({ entries }: { entries: BundleFileEntry[] }) {
  return (
    <div className="flex flex-col gap-3">
      {entries.map((entry) => (
        <div key={entry.path} className="rounded-md border border-border overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-muted/40 border-b border-border">
            <span className="font-mono text-xs truncate">{entry.path}</span>
            <Badge variant={STATUS_VARIANT[entry.status]} className="text-[10px] capitalize">
              {entry.status}
            </Badge>
          </div>
          <FileBody entry={entry} />
        </div>
      ))}
    </div>
  );
}
