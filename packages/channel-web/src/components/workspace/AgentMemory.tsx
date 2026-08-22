/**
 * Memory — split by WHO OWNS IT, which is the whole point.
 *
 * "Rules you gave me" is the human's: verbatim, always injected, never touched
 * by rollup. "What it worked out" is the agent's: inspectable, but subject to
 * the same compaction and GC as the rest of the strata.
 *
 * READ-ONLY in this task. There is no route that saves a memory doc, and an
 * editor with a Save button that posts nowhere makes exactly the promise this
 * split exists to avoid — "anything you write here sticks" — and then breaks
 * it. AW-13 brings the write path and the editor back together.
 */
import { useState } from 'react';
import { FileText, Lock, Sparkles } from 'lucide-react';
import type { MemoryDoc } from '@/lib/workspace-api';
import { SectionLabel } from './bits';

export function AgentMemory({
  docs,
  agentName,
}: {
  docs: MemoryDoc[];
  agentName: string;
}) {
  // Picking which doc to READ is navigation, not authoring — it survives the
  // editor's removal.
  const [name, setName] = useState('');
  const doc = docs.find((d) => d.name === name) ?? docs[0];

  /*
    Empty is the only thing this tab shows today — nothing reads the strata
    into `memory` yet (AW-13).
  */
  if (!doc) {
    return (
      <div className="flex flex-col gap-1.5 px-6 py-10 text-center">
        <p className="text-[13.5px] text-muted-foreground">
          Nothing has been written down yet.
        </p>
        <p className="mx-auto max-w-[420px] text-[12.5px] leading-relaxed text-muted-foreground">
          This is where the rules we give {agentName} and the things it works
          out for itself will live, each kept separately.
        </p>
      </div>
    );
  }

  const rules = docs.filter((d) => d.scope === 'rules');
  const learned = docs.filter((d) => d.scope === 'learned');

  const group = (label: string, list: MemoryDoc[], Icon: typeof Lock) => (
    <>
      <SectionLabel>{label}</SectionLabel>
      <div className="flex flex-col gap-0.5">
        {list.map((d) => (
          <button
            key={d.name}
            type="button"
            onClick={() => setName(d.name)}
            className={
              d.name === doc.name
                ? 'flex items-center gap-2 truncate rounded-md bg-primary-soft px-2.5 py-2 text-left text-[13px] text-primary'
                : 'flex items-center gap-2 truncate rounded-md px-2.5 py-2 text-left text-[13px] text-muted-foreground hover:bg-muted'
            }
          >
            <Icon size={13} className="shrink-0" />
            <span className="truncate">{d.name}</span>
          </button>
        ))}
      </div>
    </>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-[240px] shrink-0 overflow-y-auto border-r border-border px-3 pb-6">
        {rules.length > 0 && group('Rules you gave me', rules, Lock)}
        {learned.length > 0 && group('What it worked out', learned, Sparkles)}
        <p className="mt-5 rounded-lg bg-muted px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          {doc.scope === 'rules'
            ? `Your rules are kept word for word. ${agentName} reads them before every run and never rewrites them.`
            : `${agentName} wrote this itself, and may rewrite it as it learns more.`}
        </p>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <FileText size={13} className="text-muted-foreground" />
          <span className="font-mono text-[13px]">memory/{doc.name}</span>
          <span className="text-[12px] text-muted-foreground">Read-only</span>
        </div>
        <pre className="flex-1 overflow-auto whitespace-pre-wrap px-5 py-4 font-mono text-[12.5px] leading-relaxed">
          {doc.body}
        </pre>
        <div className="border-t border-border px-5 py-2.5 text-[11.5px] text-muted-foreground">
          We can read this here, but we cannot change it yet.
        </div>
      </div>
    </div>
  );
}
