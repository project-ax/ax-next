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
 *
 * THE THIRD THING EACH HALF HAS TO SAY (TASK-417). Not every deployment runs a
 * memory backend at all — `@ax/memory-strata` is loaded only where the preset
 * turns it on, and a deployment without it registers neither `memory:rules:read`
 * nor `memory:learned:read`. The tab used to receive a bare `MemoryDoc[]` from
 * the server and could not tell that apart from "the read broke" or from "there
 * is genuinely nothing here", so it said the most confident thing available:
 * "Nothing yet", a claim about the agent, and "try again in a moment", a promise
 * nothing can keep. Each half now takes a `WorkspaceReadStatus` and writes the
 * sentence that is actually true. The retry appears only where retrying can
 * work.
 */
import { useEffect, useRef, useState } from 'react';
import { Lock, Sparkles } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { userFacingMessage } from '@/lib/http';
import type { AgentMemoryRead, MemoryDoc } from '@/lib/workspace-api';
import { ReadFailure, SectionLabel } from './bits';

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
  memory,
  agentName,
  onSaveRules,
  onRetry,
}: {
  memory: AgentMemoryRead;
  agentName: string;
  /**
   * Save the human tier, resolving to what is STORED afterwards.
   *
   * It returns the stored text rather than nothing because the writer
   * normalizes (trailing whitespace collapses to a single newline). An editor
   * that kept showing the text it SENT, while the store held a normalized
   * variant, would compare the two on the next re-read and report "unsaved
   * changes" forever — on the one tab whose entire job is persistence
   * confidence. Adopting the server's answer keeps one source of truth.
   *
   * Optional only so a caller with no write path can still render the split
   * read-only; the shell always passes it.
   */
  onSaveRules?: (body: string) => Promise<string>;
  /**
   * Re-read the agent detail, which is what both halves of this tab ride on.
   *
   * Optional, and the optionality is load-bearing rather than defensive: the
   * "Try again" button exists only when there is something for it to run. A
   * button that cannot do anything is the failure TASK-417 is about, one
   * component further down.
   */
  onRetry?: () => void;
}) {
  const { rules, learned } = memory;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-6 py-6">
      {rules.status === 'ok' && rules.doc !== null ? (
        <RulesEditor
          agentName={agentName}
          initial={rules.doc.body}
          {...(onSaveRules ? { onSave: onSaveRules } : {})}
        />
      ) : (
        <RulesWithoutEditor
          agentName={agentName}
          status={rules.status === 'ok' ? 'failed' : rules.status}
          {...(onRetry ? { onRetry } : {})}
        />
      )}
      <LearnedSection
        status={learned.status}
        docs={learned.docs}
        agentName={agentName}
      />
    </div>
  );
}

/**
 * The rules tier with no editor over it, and WHY there is no editor.
 *
 * We show this instead of an empty editor ON PURPOSE. A blank box over storage
 * we could not read invites someone to type a rule, press Save, and overwrite
 * the rules they still have. "We do not know" must never render as "there is
 * nothing here" — least of all on the one tab whose promise is that what you
 * write down stays written down.
 *
 * TWO REASONS LAND HERE AND THEY GET DIFFERENT SENTENCES.
 *
 *   `failed`      — we have somewhere to keep rules and could not read it. The
 *                   rules are still on disk; this is a blip. A retry can clear
 *                   it, so there is a button when the caller gave us one.
 *   `unavailable` — this deployment runs no memory backend. There is nothing to
 *                   come back to, so "try again in a moment" would be a promise
 *                   we cannot keep — the exact bug TASK-417 fixes. No button,
 *                   and we say plainly that it is how the server is set up
 *                   rather than anything the reader did.
 *
 * These sentences are local rather than `bits.tsx`'s shared `ReadFailure`
 * because this section has to explain a WITHHELD CONTROL, not just a missing
 * list. "There's nothing to show" would be the wrong sentence over a tab whose
 * whole job is an editor.
 *
 * The register stays neutral in both cases — see `lib/read-register.ts`'s third
 * clause, which cites this component by name.
 */
function RulesWithoutEditor({
  agentName,
  status,
  onRetry,
}: {
  agentName: string;
  status: 'unavailable' | 'failed';
  onRetry?: () => void;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel>
        <span className="flex items-center gap-2">
          <Lock size={12} aria-hidden="true" />
          Rules you gave me
        </span>
      </SectionLabel>
      <Alert>
        <AlertDescription className="flex flex-col items-start gap-2">
          {status === 'unavailable' ? (
            <span>
              This copy of AX isn&apos;t set up to keep rules for {agentName}, so
              there&apos;s nowhere for us to put them. Nothing is broken and
              nothing of yours is missing — whoever runs this server can switch
              memory on, and the editor turns up here when they do.
            </span>
          ) : (
            <span>
              We could not read your rules just now. Rather than show you an
              empty box you might save over the top of, we are leaving the
              editor out. Your rules are still where you left them.
            </span>
          )}
          {status === 'failed' && onRetry !== undefined && (
            <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
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
  onSave?: (body: string) => Promise<string>;
}) {
  const [text, setText] = useState(initial);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  /*
    The last text we know the SERVER holds — seeded from the first read, then
    replaced by whatever a successful save reports back. Two things read it:

      - the re-read effect below, to tell an unsaved edit from a stale render;
      - `dirty`, so the Save button and the "Saved." line agree with storage
        rather than with the exact keystrokes. The writer normalizes trailing
        whitespace, so comparing against what we SENT would leave the editor
        permanently one newline away from clean.
  */
  const stored = useRef(initial);

  /*
    A re-read from the server replaces what we are showing — but ONLY when the
    user has nothing unsaved. Pulling text out from under someone mid-sentence
    is exactly the small betrayal this tab exists to stop, so an edit in
    progress always wins over a fresh read.
  */
  useEffect(() => {
    if (initial === stored.current) return;
    const hadUnsavedEdits = text !== stored.current;
    stored.current = initial;
    if (!hadUnsavedEdits) setText(initial);
  }, [initial, text]);

  const dirty = text !== stored.current;

  async function save(): Promise<void> {
    if (onSave === undefined) return;
    setState('saving');
    setError(null);
    try {
      // Adopt what the server says it stored, not what we sent.
      const saved = await onSave(text);
      stored.current = saved;
      setText(saved);
      setState('saved');
    } catch (err) {
      // Say so. A Save that failed quietly is how a hand-written rule goes
      // missing, which is the failure this whole tier exists to prevent.
      setState('idle');
      // Was `err.message`, i.e. `workspace /agents/…/memory → 401` glued into
      // the middle of an authored sentence (TASK-288).
      setError(userFacingMessage(err, 'agent-memory'));
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

/**
 * The agent's own tier — and, when there is nothing to list, WHY.
 *
 * Three answers, three sentences, and the reason this component takes a status
 * at all (TASK-417):
 *
 *   `ok` + no docs   — genuinely empty. The agent has not written anything yet.
 *                      This is the only case where we get to say that, because
 *                      it is the only case where we know it.
 *   `failed`         — the read broke. Unknown, not empty.
 *   `unavailable`    — this deployment keeps no agent memory at all. The
 *                      compaction blurb goes away with it: describing how we
 *                      fold notes together is describing machinery that is not
 *                      running here.
 *
 * The last two borrow `bits.tsx`'s `ReadFailure` rather than writing a third
 * and fourth wording of the same two facts.
 */
function LearnedSection({
  status,
  docs,
  agentName,
}: {
  status: AgentMemoryRead['learned']['status'];
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

      {status !== 'unavailable' && (
        <p className="max-w-[62ch] text-[12.5px] leading-relaxed text-muted-foreground">
          {agentName} wrote these itself. {COMPACTION_NOTICE}
        </p>
      )}

      {status !== 'ok' ? (
        <ReadFailure
          status={status}
          what={`what ${agentName} works out on its own`}
          className="max-w-[62ch] text-[12.5px]"
        />
      ) : doc === undefined ? (
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
