import { useState } from 'react';
import { cn } from '@/lib/utils';

export interface BundleFileViewProps {
  /** Files to browse, in display order. SKILL.md (reconstructed) first. */
  files: { path: string; contents: string }[];
}

/**
 * Read-only browser for a skill bundle's files (the §9.2 tree). File list on
 * the left, the selected file's contents on the right.
 *
 * SECURITY: `path`s and `contents` are UNTRUSTED (a user/agent authored them).
 * They render as escaped text only — file names are React text nodes, contents
 * sit inside a <pre> text node. We do NOT use any raw-HTML injection sink and
 * NO markdown→HTML path, so an `<img onerror>` (or any markup) in the bytes is
 * shown literally and creates no element.
 */
export function BundleFileView({ files }: BundleFileViewProps) {
  const [selected, setSelected] = useState<string>(files[0]?.path ?? '');
  const current = files.find((f) => f.path === selected) ?? files[0];

  if (files.length === 0) {
    return <p className="text-sm text-muted-foreground">No files.</p>;
  }

  return (
    <div className="grid grid-cols-[200px_1fr] gap-3">
      <ul className="flex flex-col gap-px list-none m-0 p-0 max-h-[400px] overflow-auto rounded-md border border-border">
        {files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => setSelected(f.path)}
              className={cn(
                'w-full text-left px-2 py-1.5 text-xs font-mono truncate transition-colors',
                f.path === current?.path
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
            >
              {f.path}
            </button>
          </li>
        ))}
      </ul>
      <pre className="font-mono text-xs whitespace-pre-wrap break-words max-h-[400px] overflow-auto rounded-md border border-border bg-muted/30 p-3 m-0">
        {current?.contents}
      </pre>
    </div>
  );
}
