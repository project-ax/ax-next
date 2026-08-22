/**
 * Memory — split by WHO OWNS IT, which is the whole point.
 *
 * "Rules you gave me" is the human's: verbatim, always injected, and the one
 * file in the memory tree that no automatic writer may touch. `@ax/memory-strata`
 * enforces that (AW-13 / TASK-234), which is what earns us the right to say it
 * here. Before that tier existed, an editor over these files promised
 * "anything you write here sticks" and the storage did not keep the promise.
 *
 * "What it worked out" is the agent's: readable, and NOT presented as a place
 * to write, because it is folded and dropped as the strata consolidates. That
 * sentence is a deliverable, not a disclaimer — a test asserts it renders, so a
 * later copy edit that quietly drops it fails.
 */
import { useEffect, useRef, useState } from 'react';
import { Lock, Sparkles } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { MemoryDoc } from '@/lib/workspace-api';
import { SectionLabel } from './bits';

/**
 * The sentence the agent's own section owes the reader. Exported so the test
 * asserts the SAME string the component renders — a copy edit that loses the
 * meaning has to come here and see why it is here.
 */
export const COMPACTION_NOTICE =
  'We fold these together over time, and drop the ones that stop being useful. If something here needs to stick, move it up to your rules.';

const RULES_PLACEHOLDER =
  'Always cc Priya on customer email.\nNever touch the billing spreadsheet without asking.';

export function AgentMemory({
  docs,
  agentName,
  onSaveRules,
}: {
  docs: MemoryDoc[];
  agentName: string;
  /**
   * Save the human tier. Optional only so a caller with no write path can
   * still render the split read-only; the shell always passes it.
   */
  onSaveRules?: (body: string) => Promise<void>;
}) {
  const rules = docs.find((d) => d.scope === 'rules');
  const learned = docs.filter((d) => d.scope === 'learned');

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-6 py-6">
      {rules === undefined ? (
        <RulesUnreadable />
      ) : (
        <RulesEditor
          agentName={agentName}
          initial={rules.body}
          {...(onSaveRules ? { onSave: onSaveRules } : {})}
        />
      )}
      <LearnedSection docs={learned} agentName={agentName} />
    </div>
  );
}

/**
 * No rules row came back — the server could not read them, or nothing on this
 * deployment keeps them.
 *
 * We show this instead of an empty editor ON PURPOSE. A blank box over storage
 * we could not read invites someone to type a rule, press Save, and overwrite
 * the rules they still have. "We do not know" must never render as "there is
 * nothing here" — least of all on the one tab whose promise is that what you
 * write down stays written down.
 */
function RulesUnreadable() {
  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel>
        <span className="flex items-center gap-2">
          <Lock size={12} aria-hidden="true" />
          Rules you gave me
        </span>
      </SectionLabel>
      <Alert>
        <AlertDescription>
          We could not read your rules just now. Rather than show you an empty
          box you might save over the top of, we are leaving the editor out —
          try again in a moment.
        </AlertDescription>
      </Alert>
    </section>
  );
}

function RulesEditor({
  agentName,
  initial,
  onSave,
}: {
  agentName: string;
  initial: string;
  onSave?: (body: string) => Promise<void>;
}) {
  const [text, setText] = useState(initial);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  const lastServerText = useRef(initial);

  /*
    A re-read from the server replaces what we are showing — but ONLY when the
    user has nothing unsaved. Pulling text out from under someone mid-sentence
    is exactly the small betrayal this tab exists to stop, so an edit in
    progress always wins over a fresh read.
  */
  useEffect(() => {
    if (initial === lastServerText.current) return;
    const hadUnsavedEdits = text !== lastServerText.current;
    lastServerText.current = initial;
    if (!hadUnsavedEdits) setText(initial);
  }, [initial, text]);

  const dirty = text !== initial;

  async function save(): Promise<void> {
    if (onSave === undefined) return;
    setState('saving');
    setError(null);
    try {
      await onSave(text);
      setState('saved');
    } catch (err) {
      // Say so. A Save that failed quietly is how a hand-written rule goes
      // missing, which is the failure this whole tier exists to prevent.
      setState('idle');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel>
        <span className="flex items-center gap-2">
          <Lock size={12} aria-hidden="true" />
          Rules you gave me
        </span>
      </SectionLabel>

      <p className="max-w-[62ch] text-[12.5px] leading-relaxed text-muted-foreground">
        Kept word for word. {agentName} reads them before every run, and nothing
        it does afterwards rewrites them.
      </p>

      <Textarea
        aria-label="Rules you gave me"
        value={text}
        placeholder={RULES_PLACEHOLDER}
        disabled={onSave === undefined || state === 'saving'}
        onChange={(e) => {
          setText(e.target.value);
          setState('idle');
        }}
        className="min-h-[180px] font-mono text-[12.5px] leading-relaxed"
      />

      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>
            We could not save that, so nothing changed. {error}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          size="sm"
          disabled={onSave === undefined || state === 'saving' || !dirty}
          onClick={() => void save()}
        >
          {state === 'saving' ? 'Saving…' : 'Save'}
        </Button>
        <span className="text-[12px] text-muted-foreground">
          {state === 'saved' && !dirty
            ? 'Saved.'
            : dirty
              ? 'Unsaved changes.'
              : ''}
        </span>
      </div>
    </section>
  );
}

function LearnedSection({
  docs,
  agentName,
}: {
  docs: MemoryDoc[];
  agentName: string;
}) {
  const [open, setOpen] = useState(docs[0]?.name ?? '');
  const doc = docs.find((d) => d.name === open) ?? docs[0];

  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel>
        <span className="flex items-center gap-2">
          <Sparkles size={12} aria-hidden="true" />
          What it worked out
        </span>
      </SectionLabel>

      <p className="max-w-[62ch] text-[12.5px] leading-relaxed text-muted-foreground">
        {agentName} wrote these itself. {COMPACTION_NOTICE}
      </p>

      {doc === undefined ? (
        <p className="text-[12.5px] text-muted-foreground">
          Nothing yet — {agentName} writes this down as it works.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {docs.map((d) => (
              <Button
                key={d.name}
                type="button"
                size="sm"
                variant={d.name === doc.name ? 'secondary' : 'ghost'}
                onClick={() => setOpen(d.name)}
              >
                {d.name}
              </Button>
            ))}
          </div>
          {/*
            Model output. It arrives as a plain string and renders as text —
            we never build markup out of it.
          */}
          <pre className="max-h-[340px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-4 py-3 font-mono text-[12px] leading-relaxed">
            {doc.body}
          </pre>
        </>
      )}
    </section>
  );
}
