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
 * Renders one bundle file's body. Contents are UNTRUSTED — they render as
 * escaped text inside a <pre> (React text nodes), never as HTML.
 */
function FileBody({ entry }: { entry: BundleFileEntry }) {
  if (entry.status === 'unchanged') {
    return <p className="text-xs text-muted-foreground px-3 py-2">Unchanged.</p>;
  }
  // added → all-add diff; removed → all-remove diff; modified → real diff.
  const lines = diffLines(entry.before ?? '', entry.after ?? '');
  return (
    <pre className="font-mono text-xs leading-relaxed overflow-auto max-h-[320px] m-0 p-0">
      {lines.map((l, i) => (
        <div
          key={i}
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
