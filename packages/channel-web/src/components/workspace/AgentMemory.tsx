/**
 * Memory — the human's tier: "Rules you gave me".
 *
 * Verbatim, always injected, and the one file in the memory tree that no
 * automatic writer may touch. Today that tier is served by @ax/memory's
 * `memory:rules:read` / `memory:rules:write` (registered when its `rules`
 * option is on), and the no-automatic-writer promise is enforced below it:
 * the rules file is in core's `RUNNER_IMMUTABLE_PATHS`, so an agent's sandbox
 * can never author it, and @ax/memory writes it only through that write
 * hook, on a person's Save. That is what earns us the right to say "nothing it does afterwards
 * rewrites them" here.
 *
 * This component is the Memory tab only on deployments WITHOUT facts memory
 * (`MemorySurface` in `FactsMemory.tsx` falls back to it when
 * `factsAvailable !== true`). It used to carry a second section, "What it
 * worked out", over `memory:learned:read`; that hook's only provider,
 * @ax/memory-strata, was deleted in TASK-608 and the section went with it.
 *
 * THE THIRD THING THE TIER HAS TO SAY (TASK-417). Not every deployment runs a
 * rules provider at all, and a deployment without one registers no
 * `memory:rules:read`. The tab used to receive a bare `MemoryDoc[]` from the
 * server and could not tell that apart from "the read broke" or from "there
 * is genuinely nothing here", so it said the most confident thing available —
 * "try again in a moment", a promise nothing can keep. The tier now takes a
 * `WorkspaceReadStatus` and writes the sentence that is actually true. The
 * retry appears only where retrying can work.
 */
import { useEffect, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { userFacingMessage } from '@/lib/http';
import type { AgentMemoryRead } from '@/lib/workspace-api';
import { SectionLabel } from './bits';

const RULES_PLACEHOLDER =
  'No rules yet. For example:\nAlways cc Priya on customer email.\nNever touch the billing spreadsheet without asking.';

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
   * Re-read the agent detail, which is what this tab rides on.
   *
   * Optional, and the optionality is load-bearing rather than defensive: the
   * "Try again" button exists only when there is something for it to run. A
   * button that cannot do anything is the failure TASK-417 is about, one
   * component further down.
   */
  onRetry?: () => void;
}) {
  const { rules } = memory;

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
          /*
            `ok` with no doc is a server-contract violation, not a state the
            route can produce (`readMemory` sets the doc on every `ok`). If it
            ever does happen, `failed` is the only safe reading of the three:
            `ok` would draw an editor over storage we cannot vouch for — the
            destructive case this whole section exists to prevent — and
            `unavailable` would tell the reader their rules are gone when we
            simply do not know.
          */
          status={rules.status === 'ok' ? 'failed' : rules.status}
          {...(onRetry ? { onRetry } : {})}
        />
      )}
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
 * The register stays neutral in both cases. `lib/read-register.ts`'s third
 * clause is the ruling, and it had to be WIDENED for the `unavailable` half:
 * as written it covered only reads that were still retryable, and this one
 * never will be. Neutral is still right — nothing malfunctioned and nothing of
 * the reader's is at risk — but that is now argued there rather than assumed
 * here.
 */
export function RulesWithoutEditor({
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
              Memory rules for {agentName} aren&apos;t switched on for this
              workspace yet. Ask your workspace administrator about enabling them.
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

export function RulesEditor({
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
