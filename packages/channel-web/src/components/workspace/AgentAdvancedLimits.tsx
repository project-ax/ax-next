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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { getAdminAgent, patchAgent, type RunnerSize } from '@/lib/admin';

const CAP_HINT = "If you go over your admin's limit, the agent runs at that limit instead.";

interface Form {
  turn: string;
  idle: string;
  cpuRequest: string;
  cpuLimit: string;
  memRequest: string;
  memLimit: string;
}

const show = (n: number | undefined, per: number): string =>
  n === undefined ? '' : String(Math.round((n / per) * 100) / 100);

function toForm(a: {
  turnLimitMinutes?: number | null;
  idleMinutes?: number | null;
  runnerSize?: RunnerSize | null;
}): Form {
  const s = a.runnerSize ?? {};
  return {
    turn: a.turnLimitMinutes == null ? '' : String(a.turnLimitMinutes),
    idle: a.idleMinutes == null ? '' : String(a.idleMinutes),
    cpuRequest: show(s.cpuMillis?.request, 1000),
    cpuLimit: show(s.cpuMillis?.limit, 1000),
    memRequest: show(s.memoryMiB?.request, 1024),
    memLimit: show(s.memoryMiB?.limit, 1024),
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

function pair(
  reqRaw: string,
  limRaw: string,
  per: number,
  what: string,
): Parsed<{ request: number; limit: number } | null> {
  if (reqRaw.trim() === '' && limRaw.trim() === '') return { ok: true, value: null };
  if (reqRaw.trim() === '' || limRaw.trim() === '') {
    return { ok: false, error: `Fill in both ${what} boxes, or leave both empty.` };
  }
  const request = Math.round(Number(reqRaw) * per);
  const limit = Math.round(Number(limRaw) * per);
  if (!(request >= 1) || !(limit >= 1)) {
    return { ok: false, error: `The ${what} boxes need a number above zero.` };
  }
  if (request > limit) {
    return { ok: false, error: `For ${what}, the guaranteed amount can't be more than the most it can use.` };
  }
  return { ok: true, value: { request, limit } };
}

export function AgentAdvancedLimits({ agentId }: { agentId: string }) {
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
        <Limits agentId={agentId} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function Limits({ agentId }: { agentId: string }) {
  const [form, setForm] = useState<Form | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    getAdminAgent(agentId).then(
      (a) => live && setForm(toForm(a)),
      () => live && setLoadFailed(true),
    );
    return () => {
      live = false;
    };
  }, [agentId]);

  if (loadFailed) {
    return (
      <Alert variant="destructive">
        <AlertDescription>We couldn't load these limits. Try reloading the page.</AlertDescription>
      </Alert>
    );
  }
  if (form === null) return <p className="text-[12.5px] text-muted-foreground">Loading…</p>;

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setForm({ ...form, [k]: e.target.value });
  };

  const save = async () => {
    setError(null);
    setSaved(false);
    const turn = minutes(form.turn, 'The reply time');
    const idle = minutes(form.idle, 'The ready time');
    const cpu = pair(form.cpuRequest, form.cpuLimit, 1000, 'processor');
    const mem = pair(form.memRequest, form.memLimit, 1024, 'memory');
    const bad = [turn, idle, cpu, mem].find((p) => !p.ok);
    if (bad && !bad.ok) return setError(bad.error);
    if (!turn.ok || !idle.ok || !cpu.ok || !mem.ok) return;
    const size: RunnerSize = {};
    if (cpu.value) size.cpuMillis = cpu.value;
    if (mem.value) size.memoryMiB = mem.value;
    setBusy(true);
    try {
      await patchAgent(agentId, {
        turnLimitMinutes: turn.value,
        idleMinutes: idle.value,
        runnerSize: Object.keys(size).length === 0 ? null : size,
      });
      setSaved(true);
    } catch {
      setError("We couldn't save that. You may not have permission to change this agent.");
    } finally {
      setBusy(false);
    }
  };

  const num = (id: string, label: string, k: keyof Form, step?: string) => (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} type="number" min={0} step={step} inputMode="decimal" placeholder="Default" value={form[k]} onChange={set(k)} />
    </Field>
  );

  return (
    <FieldGroup>
      <p className="text-[12.5px] text-muted-foreground">
        Leave a box empty to use the workspace default. {CAP_HINT}
      </p>
      {num('adv-turn', 'Longest a reply can take (minutes)', 'turn')}
      {num('adv-idle', 'Stays ready after a reply (minutes)', 'idle')}
      <FieldDescription>
        Staying ready keeps files and running programs around for the next message.
      </FieldDescription>
      <div className="grid gap-4 sm:grid-cols-2">
        {num('adv-cpu-req', 'Processor guaranteed (cores)', 'cpuRequest', '0.1')}
        {num('adv-cpu-lim', 'Processor most it can use (cores)', 'cpuLimit', '0.1')}
        {num('adv-mem-req', 'Memory guaranteed (GB)', 'memRequest', '0.5')}
        {num('adv-mem-lim', 'Memory most it can use (GB)', 'memLimit', '0.5')}
      </div>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center gap-3">
        <Button type="button" onClick={() => void save()} disabled={busy}>
          Save limits
        </Button>
        {saved && <span role="status" className="text-[12.5px] text-muted-foreground">Saved.</span>}
      </div>
    </FieldGroup>
  );
}
