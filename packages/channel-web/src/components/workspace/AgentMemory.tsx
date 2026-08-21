/**
 * Memory — split by WHO OWNS IT, which is the whole point.
 *
 * "Rules you gave me" is the human's: verbatim, always injected, safe to
 * hand-edit, never touched by rollup. "What it worked out" is the agent's:
 * inspectable and editable, but subject to the same compaction and GC as the
 * rest of the strata, so a hand-edit there can be rewritten later.
 *
 * The design this came from put both in one editor under the promise "anything
 * you write here sticks". For half the files that promise is false, and finding
 * that out by having your note eaten is the kind of thing a user never forgives.
 */
import { useEffect, useState } from 'react';
import { FileText, Lock, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { MemoryDoc } from '@/lib/workspace-api';
import { SectionLabel } from './bits';

export function AgentMemory({
  docs,
  agentName,
  onSave,
}: {
  docs: MemoryDoc[];
  agentName: string;
  onSave: (name: string, body: string) => void;
}) {
  const [name, setName] = useState(docs[0]?.name ?? '');
  const doc = docs.find((d) => d.name === name) ?? docs[0];
  const [text, setText] = useState(doc?.body ?? '');
  const [saved, setSaved] = useState(true);

  useEffect(() => {
    setText(doc?.body ?? '');
    setSaved(true);
  }, [doc?.name, doc?.body]);

  if (!doc) {
    return (
      <div className="px-6 py-10 text-center text-[13.5px] text-muted-foreground">
        {agentName} has no memory yet.
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
            : `${agentName} wrote this itself. You can edit it, but it may be rewritten as it learns more.`}
        </p>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <FileText size={13} className="text-muted-foreground" />
          <span className="font-mono text-[13px]">memory/{doc.name}</span>
          <span className="text-[12px] text-muted-foreground">
            {saved ? 'Saved' : 'Unsaved changes'}
          </span>
          <Button
            size="sm"
            className="ml-auto"
            disabled={saved}
            onClick={() => {
              onSave(doc.name, text);
              setSaved(true);
            }}
          >
            Save
          </Button>
        </div>
        <Textarea
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setSaved(false);
          }}
          className="flex-1 resize-none rounded-none border-0 px-5 py-4 font-mono text-[12.5px] leading-relaxed focus-visible:ring-0"
        />
        <div className="border-t border-border px-5 py-2.5 text-[11.5px] text-muted-foreground">
          Markdown · {text.length} characters · {agentName} reads this before its
          next run
        </div>
      </div>
    </div>
  );
}
