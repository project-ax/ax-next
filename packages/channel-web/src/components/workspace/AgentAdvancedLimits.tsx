/**
 * "Advanced" on an agent's settings: how long a reply may run, how long the
 * workspace stays ready afterwards, and how big a machine the agent gets.
 *
 * Empty means "use the default" and saves `null`. Typing more than your admin
 * allows is fine: it saves, and the agent runs at the admin's limit. The host
 * doesn't tell the page its limits, so the hint names no numbers.
 *
 * The server stores CPU in millicores and memory in MiB; people see cores and
 * GB. The body mounts only while the section is open, so a closed section
 * costs no request.
 */
import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { AsyncState, Notice } from '@project-ax/ui';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { getAdminAgent, patchAgent, type RunnerSize } from '@/lib/admin';

type Key = 'turn' | 'idle' | 'cpu' | 'mem';
type Form = Record<Key, string>;

const show = (n: number | undefined, per: number): string =>
  n === undefined ? '' : String(Math.round((n / per) * 100) / 100);

// One box per resource. A stored pair with request != limit shows its limit;
// the pair is only rewritten if the person edits that box.
function toForm(a: {
  turnLimitMinutes?: number | null;
  idleMinutes?: number | null;
  runnerSize?: RunnerSize | null;
}): Form {
  const s = a.runnerSize ?? {};
  return {
    turn: a.turnLimitMinutes == null ? '' : String(a.turnLimitMinutes),
    idle: a.idleMinutes == null ? '' : String(a.idleMinutes),
    cpu: show(s.cpuMillis?.limit, 1000),
    mem: show(s.memoryMiB?.limit, 1024),
  };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function minutes(raw: string, label: string): Parsed<number | null> {
  if (raw.trim() === '') return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1440) {
    return { ok: false, error: `${label} needs a whole number of minutes, from 1 to 1440.` };
  }
  return { ok: true, value: n };
}

function size(raw: string, per: number, what: string): Parsed<{ request: number; limit: number } | null> {
  if (raw.trim() === '') return { ok: true, value: null };
  const n = Math.round(Number(raw) * per);
  if (!(n >= 1)) return { ok: false, error: `${what} needs a number above zero.` };
  return { ok: true, value: { request: n, limit: n } };
}

export function AgentAdvancedLimits({ agentId, agentName }: { agentId: string; agentName: string }) {
  return (
    <Collapsible className="mt-8 border-t border-border pt-4">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="group -ml-2 gap-1.5 px-2">
          <ChevronRight
            data-icon="inline-start"
            aria-hidden="true"
            className="transition-transform group-data-[state=open]:rotate-90"
          />
          Advanced
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">
        <Limits agentId={agentId} agentName={agentName} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function Limits({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [form, setForm] = useState<Form | null>(null);
  const [stored, setStored] = useState<RunnerSize | null>(null);
  const [dirty, setDirty] = useState<ReadonlySet<Key>>(new Set());
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    setLoadFailed(false);
    getAdminAgent(agentId).then(
      (a) => {
        if (!live) return;
        setForm(toForm(a));
        setStored(a.runnerSize ?? null);
      },
      () => live && setLoadFailed(true),
    );
    return () => {
      live = false;
    };
  }, [agentId, attempt]);

  if (loadFailed) {
    return (
      <AsyncState
        status="error"
        skeleton="lines"
        loadingLabel="Loading limits"
        error={{ message: "We couldn't load these limits.", onRetry: () => setAttempt((n) => n + 1) }}
      />
    );
  }
  if (form === null) return <AsyncState status="loading" skeleton="lines" loadingLabel="Loading limits" />;

  const set = (k: Key) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setDirty(new Set(dirty).add(k));
    setForm({ ...form, [k]: e.target.value });
  };

  // Only what the person edited goes out, so an untouched value can't move
  // (1000 MiB shows as 0.98 GB) and edits made elsewhere aren't overwritten.
  const save = async () => {
    setError(null);
    setSaved(false);
    if (dirty.size === 0) return;
    const patch: { turnLimitMinutes?: number | null; idleMinutes?: number | null; runnerSize?: RunnerSize | null } = {};
    if (dirty.has('turn')) {
      const r = minutes(form.turn, 'Reply time');
      if (!r.ok) return setError(r.error);
      patch.turnLimitMinutes = r.value;
    }
    if (dirty.has('idle')) {
      const r = minutes(form.idle, 'Warm time');
      if (!r.ok) return setError(r.error);
      patch.idleMinutes = r.value;
    }
    if (dirty.has('cpu') || dirty.has('mem')) {
      // runnerSize is replaced whole, so the half not edited keeps its stored value.
      const next: RunnerSize = { ...(stored ?? {}) };
      if (dirty.has('cpu')) {
        const r = size(form.cpu, 1000, 'Processor');
        if (!r.ok) return setError(r.error);
        if (r.value) next.cpuMillis = r.value;
        else delete next.cpuMillis;
      }
      if (dirty.has('mem')) {
        const r = size(form.mem, 1024, 'Memory');
        if (!r.ok) return setError(r.error);
        if (r.value) next.memoryMiB = r.value;
        else delete next.memoryMiB;
      }
      patch.runnerSize = Object.keys(next).length === 0 ? null : next;
    }
    setBusy(true);
    try {
      await patchAgent(agentId, patch);
      if (patch.runnerSize !== undefined) setStored(patch.runnerSize);
      setDirty(new Set());
      setSaved(true);
    } catch {
      setError("We couldn't save that. Check that you can edit this agent, then try again.");
    } finally {
      setBusy(false);
    }
  };

  const num = (id: string, label: string, k: Key, description: string, extra: { min: number; step?: string }) => (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} type="number" min={extra.min} step={extra.step} inputMode="decimal" placeholder="Default" value={form[k]} onChange={set(k)} />
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );

  return (
    <FieldGroup>
      <p className="text-[12.5px] text-muted-foreground">
        Most agents never need these. Leave a box empty and we'll use the workspace default.
      </p>
      {num('adv-turn', 'Longest one reply can run (minutes)', 'turn',
        `Raise this if ${agentName} runs long tests and gets cut off. Your admin sets a ceiling. Go over it and we'll use the ceiling.`, { min: 1 })}
      {num('adv-idle', 'Stays warm between messages (minutes)', 'idle',
        "While it's warm, files and running programs are still there for the next message. A longer time uses more of the workspace's resources.", { min: 1 })}
      <h3 className="mt-2 text-[13px] font-semibold">Workspace size</h3>
      <p className="text-[12.5px] text-muted-foreground">
        We can't show your admin's ceiling here. If you go over it, we'll use the ceiling.
      </p>
      {num('adv-cpu', 'Processor (cores)', 'cpu', 'More cores make builds and tests faster.', { min: 0, step: '0.1' })}
      {num('adv-mem', 'Memory (GB)', 'mem', 'Raise this if tests crash with out-of-memory errors.', { min: 0, step: '0.5' })}
      {error !== null && <Notice tone="danger">{error}</Notice>}
      <div className="flex items-center gap-3">
        <Button type="button" onClick={() => void save()} disabled={busy}>
          Save
        </Button>
        {saved && <span role="status" className="text-[12.5px] text-muted-foreground">Saved.</span>}
      </div>
    </FieldGroup>
  );
}
