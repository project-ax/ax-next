import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';
// `@ax/validator-routine/frontmatter` is the pure parser/builder pair (yaml +
// shape validation) — the same single round-trip authority @ax/routines uses
// server-side. The form edits typed fields; toggling to raw serializes via
// buildRoutineMd; toggling back re-parses via parseRoutineFrontmatter. Imported
// via the `/frontmatter` subpath so the plugin entry (kysely/node) stays out of
// the SPA bundle — same shape as DefaultRoutineEditor and SkillEditor.
import {
  buildRoutineMd,
  parseRoutineFrontmatter,
  type RoutineFrontmatterFields,
  type TriggerSpec,
  type WebhookHmacSpec,
  type ActiveHours,
} from '@ax/validator-routine/frontmatter';
import { listChatAgents } from '@/lib/agents';

export type TriggerKind = 'interval' | 'cron' | 'webhook';

export interface RoutineEditorConstraints {
  /** Which trigger kinds the picker offers. Default routines pass
   *  `['interval']` (cron/webhook have no per-agent owner to anchor to). */
  allowedTriggers: readonly TriggerKind[];
  /** Whether to show the create-mode agent picker (per-user create only). */
  showAgentPicker: boolean;
}

export interface RoutineEditorProps {
  /** Existing routine to edit (parsed fields). Omit for create. */
  initial?: RoutineFrontmatterFields;
  constraints: RoutineEditorConstraints;
  /** Persist the assembled routine markdown. `agentId` is the picked agent
   *  (create + showAgentPicker) or null; `name` is the routine slug (the
   *  caller derives the file path from it on create). */
  onSave: (
    sourceMd: string,
    opts: { agentId: string | null; name: string },
  ) => Promise<void>;
  onSaved: () => void;
  onCancel: () => void;
}

// A routine name doubles as the .ax/routines/<name>.md filename stem, so it
// must be a lowercase slug (mirrors the server's ROUTINE_PATH gate + the skill
// name rule). The Save button stays disabled until the name matches.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const TRIGGER_LABELS: Record<TriggerKind, string> = {
  interval: 'Interval',
  cron: 'Schedule',
  webhook: 'Webhook',
};

const browserTz = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

/** Flat, all-fields-present form state — keeps per-kind trigger inputs from
 *  losing their value when the user flips the trigger toggle. `webhookHmac` is
 *  carried (not edited in the form — HMAC config lives in Advanced/raw) so it
 *  survives a form round-trip. */
interface RoutineFormState {
  name: string;
  description: string;
  triggerKind: TriggerKind;
  intervalEvery: string;
  cronExpr: string;
  cronTz: string;
  webhookPath: string;
  webhookEvents: string; // comma-separated raw input
  webhookHmac: WebhookHmacSpec | null;
  conversation: 'per-fire' | 'shared';
  silenceToken: string;
  silenceMaxChars: number;
  activeHours: ActiveHours | null;
  promptBody: string;
}

function emptyForm(defaultKind: TriggerKind): RoutineFormState {
  return {
    name: '',
    description: '',
    triggerKind: defaultKind,
    intervalEvery: '',
    cronExpr: '',
    cronTz: browserTz,
    webhookPath: '',
    webhookEvents: '',
    webhookHmac: null,
    conversation: 'per-fire',
    silenceToken: '',
    silenceMaxChars: 300,
    activeHours: null,
    promptBody: '',
  };
}

function formFromFields(f: RoutineFrontmatterFields, defaultKind: TriggerKind): RoutineFormState {
  const base = emptyForm(defaultKind);
  base.name = f.name;
  base.description = f.description;
  base.conversation = f.conversation;
  base.silenceMaxChars = f.silenceMaxChars;
  base.silenceToken = f.silenceToken ?? '';
  base.activeHours = f.activeHours ?? null;
  base.promptBody = f.promptBody;
  base.triggerKind = f.trigger.kind;
  if (f.trigger.kind === 'interval') {
    base.intervalEvery = f.trigger.every;
  } else if (f.trigger.kind === 'cron') {
    base.cronExpr = f.trigger.expr;
    base.cronTz = f.trigger.tz;
  } else {
    base.webhookPath = f.trigger.path;
    base.webhookEvents = (f.trigger.events ?? []).join(', ');
    base.webhookHmac = f.trigger.hmac ?? null;
  }
  return base;
}

function triggerFromForm(form: RoutineFormState): TriggerSpec {
  if (form.triggerKind === 'interval') {
    return { kind: 'interval', every: form.intervalEvery };
  }
  if (form.triggerKind === 'cron') {
    return { kind: 'cron', expr: form.cronExpr, tz: form.cronTz };
  }
  const events = form.webhookEvents
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const webhook: Extract<TriggerSpec, { kind: 'webhook' }> = {
    kind: 'webhook',
    path: form.webhookPath,
  };
  if (events.length > 0) webhook.events = events;
  if (form.webhookHmac !== null) webhook.hmac = form.webhookHmac;
  return webhook;
}

function fieldsFromForm(form: RoutineFormState): RoutineFrontmatterFields {
  const fields: RoutineFrontmatterFields = {
    name: form.name,
    description: form.description,
    trigger: triggerFromForm(form),
    silenceMaxChars: form.silenceMaxChars,
    conversation: form.conversation,
    promptBody: form.promptBody,
  };
  if (form.activeHours !== null) fields.activeHours = form.activeHours;
  if (form.silenceToken.length > 0) fields.silenceToken = form.silenceToken;
  return fields;
}

function assembleMd(form: RoutineFormState): string {
  return buildRoutineMd(fieldsFromForm(form));
}

interface AgentOption {
  agentId: string;
  displayName: string;
}

export function RoutineEditor({
  initial,
  constraints,
  onSave,
  onSaved,
  onCancel,
}: RoutineEditorProps) {
  const defaultKind = constraints.allowedTriggers[0] ?? 'interval';
  const [form, setForm] = useState<RoutineFormState>(() =>
    initial ? formFromFields(initial, defaultKind) : emptyForm(defaultKind),
  );
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Advanced raw-md escape hatch (mirrors SkillEditor): `advanced` flips the
  // raw textarea; `rawText` is authoritative only while advanced is on.
  const [advanced, setAdvanced] = useState(false);
  const [rawText, setRawText] = useState('');

  // Create-mode agent picker.
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);

  useEffect(() => {
    if (!constraints.showAgentPicker) return;
    let cancelled = false;
    listChatAgents()
      .then((list) => {
        if (!cancelled) {
          setAgents(list.map((a) => ({ agentId: a.agentId, displayName: a.displayName })));
        }
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [constraints.showAgentPicker]);

  // Live parse of the active surface — the single validity authority for the
  // Save gate (same recipe as SkillEditor).
  const activeMd = advanced ? rawText : assembleMd(form);
  const parsed = useMemo(() => parseRoutineFrontmatter(activeMd), [activeMd]);

  const slugValid = SLUG_RE.test(form.name);
  const agentOk = !constraints.showAgentPicker || agentId !== null;
  // In raw mode the name comes from the parsed md; in form mode the slug gate
  // applies (the filename is derived from it on create).
  const saveDisabled =
    saving || !parsed.ok || (!advanced && !slugValid) || !agentOk;

  function enterAdvanced(): void {
    setRawText(assembleMd(form));
    setAdvanced(true);
  }
  function exitAdvanced(): void {
    const reparsed = parseRoutineFrontmatter(rawText);
    if (!reparsed.ok) return; // stay in raw; the error is already shown
    setForm(formFromFields(reparsed.fields, defaultKind));
    setAdvanced(false);
  }

  async function handleSave(): Promise<void> {
    setSaving(true);
    setServerError(null);
    const effectiveName = advanced
      ? parsed.ok
        ? parsed.fields.name
        : ''
      : form.name;
    try {
      await onSave(activeMd, {
        agentId: constraints.showAgentPicker ? agentId : null,
        name: effectiveName,
      });
      onSaved();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const saveLabel = saving ? 'Saving…' : initial ? 'Update' : 'Create';
  const triggerOptions = constraints.allowedTriggers;
  const liveError = !parsed.ok ? parsed.reason : null;
  const selectedAgentLabel =
    agents.find((a) => a.agentId === agentId)?.displayName ?? null;

  return (
    <div className="flex flex-col gap-4 max-h-[72vh] overflow-y-auto pr-1">
      {/* Advanced toggle — demotes the raw .md editor to an opt-in escape
          hatch. Form is the default surface. */}
      <div className="flex items-start gap-2">
        <Checkbox
          id="advanced-raw-routine"
          checked={advanced}
          onCheckedChange={(v) => (v === true ? enterAdvanced() : exitAdvanced())}
        />
        <div className="flex flex-col gap-0.5 leading-none">
          <label htmlFor="advanced-raw-routine" className="text-sm font-medium">
            Advanced — edit raw <code className="font-mono text-xs">.md</code>
          </label>
          <p className="text-xs text-muted-foreground">
            Edit the underlying routine file directly. Changes stay in sync with
            the form.
          </p>
        </div>
      </div>

      {advanced ? (
        <RawEditor value={rawText} onChange={setRawText} liveError={liveError} />
      ) : (
        <div className="flex flex-col gap-4">
          {constraints.showAgentPicker && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Agent</Label>
              <Popover open={agentPickerOpen} onOpenChange={setAgentPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-label="Agent"
                    aria-expanded={agentPickerOpen}
                    className="justify-between font-normal"
                  >
                    {selectedAgentLabel ?? 'Select an agent…'}
                    <ChevronsUpDown className="ml-1 h-3.5 w-3.5 opacity-60" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="p-0 w-[280px]" align="start">
                  <Command>
                    <CommandInput placeholder="Search agents…" />
                    <CommandList>
                      <CommandEmpty>No agents found.</CommandEmpty>
                      <CommandGroup>
                        {agents.map((a) => (
                          <CommandItem
                            key={a.agentId}
                            value={a.displayName}
                            onSelect={() => {
                              setAgentId(a.agentId);
                              setAgentPickerOpen(false);
                            }}
                            className="text-sm"
                          >
                            <span className="flex-1">{a.displayName}</span>
                            <Check
                              className={cn(
                                'h-3.5 w-3.5 text-primary',
                                agentId === a.agentId ? 'opacity-100' : 'opacity-0',
                              )}
                            />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <p className="text-xs text-muted-foreground">
                The agent this routine belongs to.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="routine-name" className="text-xs font-medium text-muted-foreground">
              Name
            </Label>
            <Input
              id="routine-name"
              className="font-mono text-sm"
              placeholder="daily-digest"
              value={form.name}
              aria-invalid={form.name.length > 0 && !slugValid}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              Lowercase slug — becomes the routine filename. Letters, digits, and
              dashes.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="routine-description" className="text-xs font-medium text-muted-foreground">
              Description
            </Label>
            <Input
              id="routine-description"
              className="text-sm"
              placeholder="What this routine does."
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>

          {/* Trigger kind — hidden when only one kind is allowed (defaults). */}
          {triggerOptions.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Trigger</Label>
              <ToggleGroup
                type="single"
                value={form.triggerKind}
                onValueChange={(v) => {
                  if (v) setForm((f) => ({ ...f, triggerKind: v as TriggerKind }));
                }}
                className="justify-start"
              >
                {triggerOptions.map((k) => (
                  <ToggleGroupItem key={k} value={k}>
                    {TRIGGER_LABELS[k]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          )}

          <TriggerFields form={form} setForm={setForm} />

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Conversation</Label>
            <ToggleGroup
              type="single"
              value={form.conversation}
              onValueChange={(v) => {
                if (v === 'per-fire' || v === 'shared') {
                  setForm((f) => ({ ...f, conversation: v }));
                }
              }}
              className="justify-start"
            >
              <ToggleGroupItem value="per-fire">Per-fire</ToggleGroupItem>
              <ToggleGroupItem value="shared">Shared</ToggleGroupItem>
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              Per-fire opens a fresh conversation each run; shared appends to one
              ongoing thread.
            </p>
          </div>

          <OptionsSection form={form} setForm={setForm} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="routine-prompt" className="text-xs font-medium text-muted-foreground">
              Prompt
            </Label>
            <Textarea
              id="routine-prompt"
              className="font-mono text-xs min-h-[160px]"
              placeholder="The instruction the agent receives on every fire."
              value={form.promptBody}
              onChange={(e) => setForm((f) => ({ ...f, promptBody: e.target.value }))}
            />
          </div>

          {liveError !== null && (
            <Alert variant="destructive">
              <AlertDescription className="text-xs">{liveError}</AlertDescription>
            </Alert>
          )}
        </div>
      )}

      {serverError !== null && (
        <Alert variant="destructive">
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void handleSave()} disabled={saveDisabled}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

// ── Trigger-specific fields ──────────────────────────────────────────────────

interface FieldProps {
  form: RoutineFormState;
  setForm: React.Dispatch<React.SetStateAction<RoutineFormState>>;
}

function TriggerFields({ form, setForm }: FieldProps) {
  if (form.triggerKind === 'interval') {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="routine-interval" className="text-xs font-medium text-muted-foreground">
          Interval
        </Label>
        <Input
          id="routine-interval"
          className="font-mono text-sm"
          placeholder="1h"
          value={form.intervalEvery}
          onChange={(e) => setForm((f) => ({ ...f, intervalEvery: e.target.value }))}
        />
        <p className="text-xs text-muted-foreground">
          How often to run: <code className="font-mono">30s</code>,{' '}
          <code className="font-mono">5m</code>, <code className="font-mono">1h</code>,{' '}
          <code className="font-mono">1d</code> (minimum 60s).
        </p>
      </div>
    );
  }
  if (form.triggerKind === 'cron') {
    return (
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="routine-cron-expr" className="text-xs font-medium text-muted-foreground">
            Cron expression
          </Label>
          <Input
            id="routine-cron-expr"
            className="font-mono text-sm"
            placeholder="0 2 * * *"
            value={form.cronExpr}
            onChange={(e) => setForm((f) => ({ ...f, cronExpr: e.target.value }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="routine-cron-tz" className="text-xs font-medium text-muted-foreground">
            Timezone
          </Label>
          <Input
            id="routine-cron-tz"
            className="font-mono text-sm"
            placeholder="America/New_York"
            value={form.cronTz}
            onChange={(e) => setForm((f) => ({ ...f, cronTz: e.target.value }))}
          />
        </div>
      </div>
    );
  }
  // webhook
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="routine-webhook-path" className="text-xs font-medium text-muted-foreground">
          Webhook path
        </Label>
        <Input
          id="routine-webhook-path"
          className="font-mono text-sm"
          placeholder="/gh/push"
          value={form.webhookPath}
          onChange={(e) => setForm((f) => ({ ...f, webhookPath: e.target.value }))}
        />
        <p className="text-xs text-muted-foreground">
          Must start with <code className="font-mono">/</code>. The full receiver
          URL includes a per-agent token prefix.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="routine-webhook-events" className="text-xs font-medium text-muted-foreground">
          Events (comma-separated)
        </Label>
        <Input
          id="routine-webhook-events"
          className="font-mono text-sm"
          placeholder="push, pull_request"
          value={form.webhookEvents}
          onChange={(e) => setForm((f) => ({ ...f, webhookEvents: e.target.value }))}
        />
        <p className="text-xs text-muted-foreground">
          Optional GitHub-style event filter. HMAC signing is configured in
          Advanced (raw) mode.
        </p>
      </div>
      {form.webhookHmac !== null && (
        <p className="text-xs text-muted-foreground">
          HMAC verification is configured (
          <code className="font-mono">{form.webhookHmac.header}</code>). Edit it in
          Advanced mode.
        </p>
      )}
    </div>
  );
}

// ── Optional fields (silence + active hours) ─────────────────────────────────

function OptionsSection({ form, setForm }: FieldProps) {
  const [open, setOpen] = useState(false);
  const activeHoursOn = form.activeHours !== null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="self-start px-1 text-xs text-muted-foreground">
          {open ? 'Hide options' : 'More options'}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 pt-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="routine-silence-token" className="text-xs font-medium text-muted-foreground">
            Silence token
          </Label>
          <Input
            id="routine-silence-token"
            className="font-mono text-sm"
            placeholder="NOTHING_TO_REPORT"
            value={form.silenceToken}
            onChange={(e) => setForm((f) => ({ ...f, silenceToken: e.target.value }))}
          />
          <p className="text-xs text-muted-foreground">
            If the run outputs only this token (within the limit below), the fire
            is silenced.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="routine-silence-max" className="text-xs font-medium text-muted-foreground">
            Silence max chars
          </Label>
          <Input
            id="routine-silence-max"
            type="number"
            className="font-mono text-sm w-32"
            value={String(form.silenceMaxChars)}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              setForm((f) => ({ ...f, silenceMaxChars: Number.isNaN(n) ? 0 : n }));
            }}
          />
        </div>
        <div className="flex items-start gap-2">
          <Checkbox
            id="routine-active-hours"
            checked={activeHoursOn}
            onCheckedChange={(v) =>
              setForm((f) => ({
                ...f,
                activeHours: v === true ? { start: '09:00', end: '17:00', tz: browserTz } : null,
              }))
            }
          />
          <label htmlFor="routine-active-hours" className="text-sm font-medium leading-none">
            Restrict to active hours
          </label>
        </div>
        {activeHoursOn && form.activeHours !== null && (
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="routine-ah-start" className="text-xs font-medium text-muted-foreground">
                Start
              </Label>
              <Input
                id="routine-ah-start"
                className="font-mono text-sm"
                placeholder="09:00"
                value={form.activeHours.start}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    activeHours: { ...f.activeHours!, start: e.target.value },
                  }))
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="routine-ah-end" className="text-xs font-medium text-muted-foreground">
                End
              </Label>
              <Input
                id="routine-ah-end"
                className="font-mono text-sm"
                placeholder="17:00"
                value={form.activeHours.end}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    activeHours: { ...f.activeHours!, end: e.target.value },
                  }))
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="routine-ah-tz" className="text-xs font-medium text-muted-foreground">
                Timezone
              </Label>
              <Input
                id="routine-ah-tz"
                className="font-mono text-sm"
                value={form.activeHours.tz}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    activeHours: { ...f.activeHours!, tz: e.target.value },
                  }))
                }
              />
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Raw editor surface (the opt-in escape hatch) ─────────────────────────────

function RawEditor({
  value,
  onChange,
  liveError,
}: {
  value: string;
  onChange: (v: string) => void;
  liveError: string | null;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="flex flex-col gap-1">
        <Label className="text-xs font-medium text-muted-foreground">Routine .md</Label>
        <Textarea
          aria-label="Raw routine .md"
          className="font-mono text-xs min-h-[400px]"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label className="text-xs font-medium text-muted-foreground">Status</Label>
        {liveError === null ? (
          <div className="rounded-md border border-border p-3 bg-muted/30">
            <Badge variant="secondary" className="text-xs">
              Parses ✓
            </Badge>
          </div>
        ) : (
          <Alert variant="destructive">
            <AlertDescription className="text-xs">{liveError}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
