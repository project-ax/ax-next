import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { SetupShell } from '../setup/SetupShell';
import { bootstrapAgent } from '../../lib/agent-bootstrap';
import { hydrateAgentsOnce } from '../../lib/hydrate-agents';
import { agentStoreActions } from '../../lib/agent-store';

type Step = 'name' | 'soul' | 'purpose' | 'done';

const NAME_SUGGESTIONS = ['Ada', 'Sol', 'Wren', 'Pilot'] as const;

const TRAIT_CHIPS: ReadonlyArray<{ label: string; sentence: string }> = [
  { label: 'Warm & encouraging', sentence: 'You are warm and encouraging, and never make me feel dumb for asking.' },
  { label: 'Direct & concise', sentence: 'You are direct and concise — you get to the point without padding.' },
  { label: 'Playful', sentence: 'You keep a light, playful tone and a sense of humor.' },
  { label: 'Careful & thorough', sentence: 'You are careful and thorough, and double-check your work before sharing it.' },
  { label: 'Asks before acting', sentence: 'You check in with me before taking any significant or irreversible action.' },
];

const PURPOSE_CHIPS: ReadonlyArray<{ label: string; sentence: string }> = [
  { label: 'Help me write', sentence: 'help me draft and edit writing' },
  { label: 'Think through problems', sentence: 'think through hard problems with me' },
  { label: 'Organize my work', sentence: 'help me organize and keep track of my work' },
  { label: 'Learn alongside me', sentence: 'help me learn new things' },
  { label: 'A bit of everything', sentence: 'be a general-purpose assistant for whatever comes up' },
];

// The installed badge.tsx is a plain <div> with no Radix Slot (no `asChild`
// support), so a chip can't render `<Badge asChild><button/></Badge>`. We use
// a plain <button> styled with badge-equivalent classes + semantic tokens
// instead (Invariant #6 — semantic tokens, no raw colors).
const CHIP_CLASS =
  'inline-flex items-center rounded-full border border-border px-2.5 py-0.5 text-xs ' +
  'text-foreground transition-colors hover:bg-muted focus:outline-none focus:ring-2 ' +
  'focus:ring-ring focus:ring-offset-2';

function appendSentence(current: string, sentence: string): string {
  const trimmed = current.trim();
  if (trimmed.includes(sentence)) return current;
  return trimmed.length === 0 ? sentence : `${trimmed} ${sentence}`;
}

/**
 * Compose the agent's system prompt from the bootstrap answers.
 *
 * The chosen name is ALWAYS stated first, as the agent's identity. Without it
 * the model has no name anywhere in its prompt and answers "what's your name?"
 * with its trained default ("I'm Claude"): the runner passes this string as the
 * SDK's `systemPrompt`, which REPLACES the default `claude_code` preset, so
 * nothing downstream supplies a name. (The earlier version only named the agent
 * in the empty-soul fallback, so any chosen personality silently dropped the
 * name.) The optional personality (soul) and purpose follow.
 */
export function composeSystemPrompt(opts: { name: string; soul: string; purpose: string }): string {
  const parts: string[] = [`You are ${opts.name}, a helpful personal assistant.`];
  const soul = opts.soul.trim();
  if (soul.length > 0) parts.push(soul);
  const purpose = opts.purpose.trim();
  if (purpose.length > 0) parts.push(`Your job: ${purpose}`);
  return parts.join('\n\n');
}

export interface AgentBootstrapProps {
  /** Called when the user finishes (clicks "Start chatting") or after a fresh agent is active. */
  onDone: () => void;
  /** When true, show a "Back to chat" escape (used for the steady-state "+ New agent" entry). */
  canCancel?: boolean;
  onCancel?: () => void;
}

export function AgentBootstrap({ onDone, canCancel = false, onCancel }: AgentBootstrapProps) {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [soul, setSoul] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Stash the freshly-created agent id so the done-step handler can select it.
  // We deliberately defer hydrating the agent store + selecting the agent until
  // the user leaves the done screen — populating the store mid-create flips the
  // App-level `noAgents` gate to false and unmounts this component before the
  // 'done' step ever paints (the first-run path keeps `createAgentOpen` false,
  // so the gate has nothing else to hold it open). See App.tsx's gate.
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);

  // canCancel is true exactly when there's already an existing agent (the
  // steady-state "+ New agent" entry), which means this is NOT the first-run.
  const isFirstRun = !canCancel;

  const trimmedName = name.trim();

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const agent = await bootstrapAgent({
        displayName: trimmedName,
        systemPrompt: composeSystemPrompt({ name: trimmedName, soul, purpose }),
      });
      // Do NOT hydrate / select here — that would unmount us before 'done'
      // paints (first-run). The store stays empty so `noAgents` stays true and
      // the done screen renders; we commit the store mutation on "Start chatting".
      setCreatedAgentId(agent.agentId);
      setStep('done');
    } catch {
      setErr("We couldn't create your agent just now. This is on us, not you — give it another go in a moment.");
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    // Commit the store mutation now, as the user leaves the done screen: select
    // the new agent, hydrate the store (this flips the App-level `noAgents` gate
    // and unmounts us), then hand control back so the chat shell renders it.
    if (createdAgentId !== null) {
      agentStoreActions.setSelectedAgent(createdAgentId);
      await hydrateAgentsOnce();
    }
    onDone();
  }

  const backToChat =
    canCancel && onCancel ? (
      <Button variant="ghost" className="w-full mt-1" onClick={onCancel} type="button">
        ← Back to chat
      </Button>
    ) : null;

  if (step === 'done') {
    return (
      <SetupShell
        title={`${trimmedName} is ready`}
        description={`That's it — ${trimmedName} is yours. Say hi, ask anything, and tweak the details whenever you like.`}
      >
        <Button className="w-full" onClick={() => void finish()} type="button">
          Start chatting →
        </Button>
      </SetupShell>
    );
  }

  if (step === 'name') {
    return (
      <SetupShell
        title={isFirstRun ? "Let's make your first agent" : 'Make another agent'}
        description={
          isFirstRun
            ? 'Think of this as hiring a teammate — except it never steals your lunch. Three quick steps, and you can change everything later.'
            : "Building out the team? Three quick steps, and you can change everything later. The first one didn't even ask for a raise."
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="bootstrap-name">What should we call them?</Label>
            <Input
              id="bootstrap-name"
              autoFocus
              maxLength={128}
              placeholder="Ada"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A name makes it feel less like a tool and more like a teammate. You can rename it later.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10.5px] tracking-[0.04em] uppercase text-muted-foreground">Need a nudge?</span>
            <div className="flex flex-wrap gap-1.5">
              {NAME_SUGGESTIONS.map((s) => (
                <button key={s} type="button" className={CHIP_CLASS} onClick={() => setName(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2 pt-1">
            <Button type="button" disabled={trimmedName.length === 0} onClick={() => setStep('soul')}>
              Continue
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setName(NAME_SUGGESTIONS[Math.floor(Math.random() * NAME_SUGGESTIONS.length)]!)}
            >
              Surprise me
            </Button>
            {backToChat}
          </div>
        </div>
      </SetupShell>
    );
  }

  if (step === 'soul') {
    return (
      <SetupShell
        title={`Give ${trimmedName} a personality`}
        description={`How should ${trimmedName} talk to you? Warm and chatty, or short and to the point? No wrong answers — and we won't tell ${trimmedName} you hesitated.`}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="bootstrap-soul">Personality</Label>
            <Textarea
              id="bootstrap-soul"
              rows={4}
              placeholder="Friendly and encouraging. Explains things in plain language and never makes me feel dumb for asking."
              value={soul}
              onChange={(e) => setSoul(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">You can rewrite this anytime in settings.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10.5px] tracking-[0.04em] uppercase text-muted-foreground">Or start from a vibe:</span>
            <div className="flex flex-wrap gap-1.5">
              {TRAIT_CHIPS.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  className={CHIP_CLASS}
                  onClick={() => setSoul((c) => appendSentence(c, t.sentence))}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2 pt-1">
            <Button type="button" onClick={() => setStep('purpose')}>
              Continue
            </Button>
            <Button type="button" variant="ghost" onClick={() => setStep('purpose')}>
              Keep it simple
            </Button>
            {backToChat}
          </div>
        </div>
      </SetupShell>
    );
  }

  // step === 'purpose'
  return (
    <SetupShell
      title={`What's ${trimmedName} here to help with?`}
      description={`A rough idea is plenty — "help me write" or "think through hard problems" both work. ${trimmedName} figures out the rest with you.`}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="bootstrap-purpose">What should it help with?</Label>
          <Textarea
            id="bootstrap-purpose"
            rows={3}
            placeholder="Help me draft and edit writing, and talk through ideas before I commit to them."
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[10.5px] tracking-[0.04em] uppercase text-muted-foreground">Or pick a starting point:</span>
          <div className="flex flex-wrap gap-1.5">
            {PURPOSE_CHIPS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={CHIP_CLASS}
                onClick={() => setPurpose((c) => appendSentence(c, p.sentence))}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {err !== null && (
          <Alert variant="destructive">
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-2 pt-1">
          <Button type="button" disabled={busy} onClick={() => void create()}>
            {busy ? 'Creating…' : `Create ${trimmedName}`}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void create()}
            className={cn(busy && 'pointer-events-none')}
          >
            Just give me the basics
          </Button>
          {backToChat}
        </div>
      </div>
    </SetupShell>
  );
}
