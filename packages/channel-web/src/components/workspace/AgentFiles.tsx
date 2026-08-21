/**
 * Files the agent wrote, in the workspace it owns.
 *
 * Read-only on purpose for now: these are the agent's outputs, and the useful
 * question a human asks here is "what did it actually produce", not "let me
 * edit it". Editing belongs to Memory, where the human genuinely is an author.
 */
import { useState } from 'react';
import { FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { WorkspaceFile } from '@/lib/workspace-api';
import { SectionLabel } from './bits';

export function AgentFiles({
  files,
  agentName,
}: {
  files: WorkspaceFile[];
  agentName: string;
}) {
  const [idx, setIdx] = useState(0);
  const file = files[idx];

  if (!file) {
    return (
      <div className="px-6 py-10 text-center text-[13.5px] text-muted-foreground">
        {agentName} has not written anything yet.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-[240px] shrink-0 overflow-y-auto border-r border-border px-3 pb-6">
        <SectionLabel>Workspace</SectionLabel>
        <div className="flex flex-col gap-0.5">
          {files.map((f, i) => (
            <button
              key={f.name}
              type="button"
              onClick={() => setIdx(i)}
              className={
                i === idx
                  ? 'flex items-center gap-2 truncate rounded-md bg-primary-soft px-2.5 py-2 text-left text-[13px] text-primary'
                  : 'flex items-center gap-2 truncate rounded-md px-2.5 py-2 text-left text-[13px] text-muted-foreground hover:bg-muted'
              }
            >
              <FileText size={13} className="shrink-0" />
              <span className="truncate">{f.name}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-8 pt-5">
        <div className="mb-1 flex items-center gap-2.5">
          <span className="font-mono text-[13px]">{file.name}</span>
          <Badge variant="secondary">written by {agentName}</Badge>
        </div>
        <div className="text-[12.5px] text-muted-foreground">{file.meta}</div>

        <div className="mt-5 max-w-[680px] rounded-lg border border-border bg-card p-6 shadow-sm">
          <h2 className="mb-4 text-[15px] font-medium">{file.title}</h2>
          {file.blocks.map(([kind, text], i) => {
            if (kind === 'h')
              return (
                <h3 key={i} className="mb-1.5 text-[13px] font-medium">
                  {text}
                </h3>
              );
            if (kind === 'mono')
              return (
                <pre
                  key={i}
                  className="mb-3.5 whitespace-pre-wrap rounded-md bg-muted px-3.5 py-3 font-mono text-[12px] leading-relaxed text-muted-foreground"
                >
                  {text}
                </pre>
              );
            return (
              <p
                key={i}
                className="mb-3.5 text-[13.5px] leading-relaxed text-muted-foreground text-pretty"
              >
                {text}
              </p>
            );
          })}
        </div>
      </div>
    </div>
  );
}
