/**
 * The New / Edit task form (the minimal redesign, 2026-10-29).
 *
 * Only the brief stays as words: the kind, the name, what the agent should do
 * and how we'll know it's going well. Every other setting is a chip that opens
 * a small popover, or sits one click down under ⋯ More options.
 *
 * SAME DRAFT, SAME WRITE. The draft, its validation and its one logical save
 * (request ID kept across an uncertain retry) are `useRoutineDraft`, shared
 * with the Settings routine form, and `RoutineEditor` supplies the very same
 * create/update calls. This form only draws them; a preset is a view of the
 * schedule, never a rewrite of it (see `task-form-helpers.ts`).
 *
 * VALIDATE ON SUBMIT. Start task is never disabled for a missing field. The
 * press shows each problem as a plain sentence under its control (a chip's
 * under the chip row), links it with aria-invalid and aria-describedby, and
 * focuses the first one, opening More options when that's where it is.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { CalendarDays, ChevronDown, Clock, Ellipsis, Plug, Target, type LucideIcon } from 'lucide-react';
import {
  isTaskKind,
  ROUTINE_GOOD_WHEN_MAX_CHARS,
  ROUTINE_NAME_MAX_CHARS,
  type RoutineDefinition,
} from '@ax/routines-contract';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ui/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { describeCron } from '@/lib/cron-describe';
import { browserTimeZone } from '@/lib/task-finish-by';
import { cn } from '@/lib/utils';
import { ActiveHoursDaySelector } from '@/components/routines/ActiveHoursDaySelector';
import { WebhookAddressFields } from '@/components/routines/WebhookAddressFields';
import { WebhookSignatureFields } from '@/components/routines/WebhookSignatureFields';
import { useRoutineDraft } from '@/components/routines/use-routine-draft';
import { AgentTile } from './bits';
import { IconAction, TASK_KIND_ICONS, TASK_KIND_SHORT } from './task-bits';
import {
  durationWords,
  hoursChip,
  intervalPresets,
  MORE_OPTIONS_FIELDS,
  plainIssue,
  RESPOND_PRESETS,
  respondPreset,
  scheduleChip,
  schedulePreset,
  TASK_FIELDS,
  taskField,
  type TaskField,
} from './task-form-helpers';

export interface TaskAgentChoice {
  agents: ReadonlyArray<{ agentId: string; agentName: string }>;
  selected: string;
  onSelect: (agentId: string) => void;
}

type Kind = RoutineDefinition['kind'];
const KINDS = ['stay-on-top', 'get-done', 'repeat'] as const;
const KIND_HELP: Record<Kind, string> = {
  'stay-on-top': 'Keeps checking and fixing. Never finishes.',
  'get-done': 'Works through steps until you say it’s done.',
  repeat: 'Does the same job on a schedule.',
};
const CUSTOM = '__custom';
type Chip = 'agent' | 'schedule' | 'hours' | 'updates';

/** A pill that opens a small popover. Its name carries its current value. */
function SettingChip({ icon: Icon, leading, label, name, open, onOpenChange, invalid, describedBy, disabled, buttonRef, children }: {
  icon?: LucideIcon;
  leading?: ReactNode;
  label: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invalid?: boolean;
  describedBy?: string | undefined;
  disabled?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button ref={buttonRef} type="button" variant="outline" size="sm" disabled={disabled}
          aria-label={name} aria-invalid={invalid || undefined} aria-describedby={describedBy}
          className={cn('h-8 rounded-full px-3 text-[13px] font-normal', invalid && 'border-destructive')}>
          {leading ?? (Icon && <Icon aria-hidden="true" data-icon="inline-start" />)}
          {label}
          <ChevronDown aria-hidden="true" data-icon="inline-end" className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-4">
        {children}
      </PopoverContent>
    </Popover>
  );
}

export function TaskForm({
  initial,
  agentId,
  routineId,
  agentName,
  mode,
  canEdit = true,
  agentChoices,
  save,
  onSaved,
  onCancel,
  onReload,
  onPendingChange,
}: {
  initial: RoutineDefinition;
  agentId: string;
  routineId?: string | undefined;
  agentName: string;
  mode: 'create' | 'edit';
  canEdit?: boolean;
  agentChoices?: TaskAgentChoice | undefined;
  save: (definition: RoutineDefinition, requestId: string) => Promise<unknown>;
  onSaved: (result: unknown) => void;
  onCancel: () => void;
  onReload?: () => void;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}) {
  const id = useId();
  const {
    form, eventsDraft, draftDefinition, validation, dirty, disabled, error, invalidField,
    conflict, busy, uncertain, addressBusy, setAddressBusy, update, editEvents,
    toggleSchedule, toggleWebhook, changeKind, submit,
  } = useRoutineDraft({ initial, mode, canEdit, save, onSaved, onPendingChange });
  const [attempted, setAttempted] = useState(false);
  const [more, setMore] = useState(false);
  const [chip, setChip] = useState<Chip | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const focusNext = useRef<TaskField | null>(null);
  const controls = useRef(new Map<TaskField, HTMLElement | null>());
  const register = (field: TaskField) => (element: HTMLElement | null) => { controls.current.set(field, element); };
  const task = isTaskKind(form.kind);
  const preset = schedulePreset(form.schedule, form.kind);
  // A cron that isn't a preset is edited under More options, so its problems show there.
  const customCron = form.schedule?.kind === 'cron' && preset === null;

  const issues = useMemo(() => {
    const found = new Map<TaskField, string>();
    if (draftDefinition.promptBody.trim() === '') found.set('promptBody', `Tell ${agentName} what to do.`);
    if (!validation.success) {
      for (const issue of validation.error.issues) {
        const field = taskField(issue.path.join('.'), customCron);
        if (!found.has(field)) found.set(field, plainIssue(field, issue, agentName));
      }
    }
    return found;
  }, [validation, draftDefinition.promptBody, customCron, agentName]);
  // Shown after the first press, then kept current as the person fixes them.
  const shown = useMemo(() => {
    const visible = new Map(attempted ? issues : []);
    // The host named a field it refused; say so there, in our words.
    if (invalidField !== undefined) {
      const field = taskField(invalidField, customCron);
      if (field !== 'form' && !visible.has(field)) visible.set(field, plainIssue(field, {}, agentName));
    }
    return visible;
  }, [attempted, issues, invalidField, customCron, agentName]);

  useEffect(() => {
    const field = focusNext.current;
    if (field === null) return;
    focusNext.current = null;
    const scheduleInput = controls.current.get('customSchedule');
    const element = field === 'schedule' && more && scheduleInput ? scheduleInput : controls.current.get(field);
    if (!element) return;
    const target = element.matches('input, textarea, button, [tabindex]') ? element
      : element.querySelector<HTMLElement>('[aria-invalid="true"], input, textarea, button, [tabindex]');
    target?.focus();
  }, [focusTick, more]);

  function onSubmit() {
    // An uncertain save retries the very same request, whatever the draft says now.
    if (uncertain) { void submit(); return; }
    setAttempted(true);
    const first = TASK_FIELDS.find(field => issues.has(field));
    if (first !== undefined) {
      if (MORE_OPTIONS_FIELDS.has(first)) setMore(true);
      setChip(null);
      focusNext.current = first;
      setFocusTick(tick => tick + 1);
      return;
    }
    // Nothing changed: there's nothing to send.
    if (mode === 'edit' && !dirty) { onCancel(); return; }
    void submit();
  }

  const errorId = (field: TaskField) => `${id}-${field}-error`;
  const invalid = (field: TaskField) => shown.has(field);
  const describedBy = (field: TaskField, ...extra: Array<string | undefined>) =>
    [invalid(field) ? errorId(field) : undefined, ...extra].filter(Boolean).join(' ') || undefined;
  const fieldError = (field: TaskField) => shown.has(field)
    ? <FieldError id={errorId(field)}>{shown.get(field)}</FieldError> : null;
  // A popover's own copy of its chip's problem, so it reads there too.
  const popoverError = (field: TaskField) => shown.has(field)
    ? <p className="text-sm text-destructive">{shown.get(field)}</p> : null;
  const openChip = (name: Chip) => (open: boolean) => setChip(open ? name : null);

  function textInput(label: string, field: TaskField, value: string | number, onChange: (value: string) => void,
    options: { type?: string; maxLength?: number; placeholder?: string; help?: string; key?: string; focus?: boolean } = {}) {
    const helpId = options.help ? `${id}-${field}-${options.key ?? 'help'}` : undefined;
    return (
      <Field key={options.key} data-invalid={invalid(field) || undefined} data-disabled={disabled || undefined}>
        <FieldLabel htmlFor={`${id}-${field}-${options.key ?? 'input'}`}>{label}</FieldLabel>
        <Input id={`${id}-${field}-${options.key ?? 'input'}`} ref={options.focus === false ? undefined : register(field)} value={value}
          onChange={event => onChange(event.target.value)} disabled={disabled}
          aria-invalid={invalid(field) || undefined} aria-describedby={describedBy(field, helpId)}
          {...(options.type ? { type: options.type } : {})}
          {...(options.maxLength ? { maxLength: options.maxLength } : {})}
          {...(options.placeholder ? { placeholder: options.placeholder } : {})} />
        {options.help && <FieldDescription id={helpId}>{options.help}</FieldDescription>}
        {fieldError(field)}
      </Field>
    );
  }

  const intervals = intervalPresets(form.kind);
  const scheduleValue = form.schedule === null ? '' : preset
    ?? (form.schedule.kind === 'interval' ? form.schedule.every : CUSTOM);
  const extraInterval = form.schedule?.kind === 'interval' && preset === null ? form.schedule.every : null;
  const respondValue = form.webhook === null ? '' : respondPreset(form.webhook.respondWithin) ?? form.webhook.respondWithin ?? '5m';
  const respondExtra = form.webhook !== null && respondPreset(form.webhook.respondWithin) === null ? form.webhook.respondWithin : undefined;
  const hoursLabel = hoursChip(form.activeHours);
  const scheduleLabel = scheduleChip(form.schedule, form.kind);
  const updatesOn = form.webhook !== null;
  const chosenAgent = agentChoices?.agents.find(agent => agent.agentId === agentChoices.selected);
  const savedWebhook = initial.webhook !== null && initial.webhook.path === form.webhook?.path && mode === 'edit';
  const showQuiet = form.kind === 'repeat' || form.silenceToken !== null;

  return (
    <form noValidate className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
      <Field className="gap-2">
        <FieldLabel className="sr-only">Kind of task</FieldLabel>
        <ToggleGroup type="single" aria-label="Kind of task" aria-describedby={`${id}-kind-help`} value={form.kind}
          disabled={disabled} className="w-full gap-1 rounded-lg bg-muted p-1"
          onValueChange={value => { if (value === 'repeat' || isTaskKind(value)) changeKind(value); }}>
          {KINDS.map(kind => {
            const Icon = TASK_KIND_ICONS[kind];
            return (
              <ToggleGroupItem key={kind} value={kind}
                className="h-9 flex-1 text-[13px] font-normal text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm">
                <Icon aria-hidden="true" className={cn(form.kind === kind && 'text-primary')} />
                {TASK_KIND_SHORT[kind]}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <FieldDescription id={`${id}-kind-help`} className="text-[13px]">{KIND_HELP[form.kind]}</FieldDescription>
      </Field>
      {mode === 'edit' && form.kind !== initial.kind && (
        <Alert><AlertDescription>
          Switching kinds starts this task over. Its steps, latest update, notes and finish date will be cleared.
        </AlertDescription></Alert>
      )}

      <FieldGroup className="gap-3">
        <Field data-invalid={invalid('name') || undefined} data-disabled={disabled || undefined}>
          <FieldLabel htmlFor={`${id}-name`} className="sr-only">Name</FieldLabel>
          <Input id={`${id}-name`} ref={register('name')} placeholder="Name" value={form.name}
            maxLength={ROUTINE_NAME_MAX_CHARS} disabled={disabled}
            onChange={event => update('name', event.target.value)}
            aria-invalid={invalid('name') || undefined} aria-describedby={describedBy('name')} />
          {fieldError('name')}
        </Field>
        <Field data-invalid={invalid('promptBody') || undefined} data-disabled={disabled || undefined}>
          <FieldLabel htmlFor={`${id}-promptBody`} className="sr-only">What should {agentName} do?</FieldLabel>
          <Textarea id={`${id}-promptBody`} ref={register('promptBody')} rows={3}
            placeholder={`What should ${agentName} do?`} value={form.promptBody} disabled={disabled}
            onChange={event => update('promptBody', event.target.value)}
            aria-invalid={invalid('promptBody') || undefined} aria-describedby={describedBy('promptBody')} />
          {fieldError('promptBody')}
        </Field>
        {task && (
          <Field data-invalid={invalid('goodWhen') || undefined} data-disabled={disabled || undefined}>
            <FieldLabel htmlFor={`${id}-goodWhen`} className="sr-only">Going well when</FieldLabel>
            <InputGroup>
              <InputGroupAddon><Target aria-hidden="true" /></InputGroupAddon>
              {/* A textarea, not an input: a saved line break would be stripped by an input. */}
              <InputGroupTextarea id={`${id}-goodWhen`} ref={register('goodWhen')} rows={1}
                className="min-h-0 resize-none py-2" placeholder="Going well when…"
                maxLength={ROUTINE_GOOD_WHEN_MAX_CHARS} value={form.goodWhen ?? ''} disabled={disabled}
                onChange={event => update('goodWhen', event.target.value)}
                aria-invalid={invalid('goodWhen') || undefined} aria-describedby={describedBy('goodWhen')} />
            </InputGroup>
            {fieldError('goodWhen')}
          </Field>
        )}
      </FieldGroup>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          {mode === 'create' && agentChoices !== undefined && agentChoices.agents.length > 1 && chosenAgent && (
            <SettingChip leading={<AgentTile agent={{ name: chosenAgent.agentName }} size={18} />}
              label={chosenAgent.agentName} name={`Agent: ${chosenAgent.agentName}`}
              open={chip === 'agent'} onOpenChange={openChip('agent')} disabled={disabled}>
              <RadioGroup aria-label="Agent" value={agentChoices.selected} disabled={disabled}
                className="max-h-64 overflow-y-auto"
                onValueChange={value => { agentChoices.onSelect(value); setChip(null); }}>
                {agentChoices.agents.map(agent => (
                  <Field key={agent.agentId} orientation="horizontal">
                    <RadioGroupItem id={`${id}-agent-${agent.agentId}`} value={agent.agentId} />
                    <FieldLabel htmlFor={`${id}-agent-${agent.agentId}`} className="font-normal">
                      <AgentTile agent={{ name: agent.agentName }} size={20} />
                      {agent.agentName}
                    </FieldLabel>
                  </Field>
                ))}
              </RadioGroup>
            </SettingChip>
          )}
          <SettingChip icon={Clock} label={scheduleLabel} name={`How often: ${scheduleLabel}`}
            open={chip === 'schedule'} onOpenChange={openChip('schedule')}
            invalid={invalid('schedule')} describedBy={describedBy('schedule')} buttonRef={register('schedule')}>
            {form.kind === 'repeat' && (
              <Field orientation="horizontal">
                <FieldLabel htmlFor={`${id}-scheduled`}>On a schedule</FieldLabel>
                <Switch id={`${id}-scheduled`} checked={form.schedule !== null} disabled={disabled}
                  onCheckedChange={toggleSchedule} />
              </Field>
            )}
            {form.schedule !== null && (
              <Field>
                <FieldLabel htmlFor={`${id}-every`}>Every</FieldLabel>
                <Select value={scheduleValue} disabled={disabled} onValueChange={value => {
                  if (value === CUSTOM) { setChip(null); setMore(true); return; }
                  if (value !== extraInterval) update('schedule', { kind: 'interval', every: value });
                }}>
                  <SelectTrigger id={`${id}-every`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>
                    {intervals.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                    {extraInterval !== null && <SelectItem value={extraInterval}>{durationWords(extraInterval)}</SelectItem>}
                    <SelectItem value={CUSTOM}>Custom schedule…</SelectItem>
                  </SelectGroup></SelectContent>
                </Select>
              </Field>
            )}
            {task && <FieldDescription>The schedule stays on as a safety check, even when apps send updates.</FieldDescription>}
            {popoverError('schedule')}
          </SettingChip>
          <SettingChip icon={CalendarDays} label={hoursLabel} name={`Active hours: ${hoursLabel}`}
            open={chip === 'hours'} onOpenChange={openChip('hours')}
            invalid={invalid('hours')} describedBy={describedBy('hours')} buttonRef={register('hours')}>
            <Field orientation="horizontal">
              <FieldLabel htmlFor={`${id}-hours`}>Only at certain hours</FieldLabel>
              <Switch id={`${id}-hours`} checked={form.activeHours !== null} disabled={disabled || form.schedule === null}
                onCheckedChange={on => update('activeHours', on ? { start: '09:00', end: '17:00', tz: browserTimeZone() ?? 'UTC' } : null)} />
            </Field>
            {form.schedule === null && <FieldDescription>Turn on a schedule first.</FieldDescription>}
            {form.webhook !== null && form.activeHours !== null && <FieldDescription>
              {task ? 'Updates received outside these hours wait for the next active window.' : 'App updates run when received. Active hours apply to the schedule.'}
            </FieldDescription>}
            {form.activeHours && <>
              <Field>
                <FieldLabel>Days</FieldLabel>
                <ActiveHoursDaySelector value={form.activeHours.days} disabled={disabled}
                  invalid={invalid('hours') && form.activeHours.days?.length === 0}
                  describedBy={`${id}-days-help`}
                  onChange={days => { if (form.activeHours) update('activeHours', { ...form.activeHours, days }); }} />
                <FieldDescription id={`${id}-days-help`}>
                  Days name when the window starts. Overnight hours continue into the next morning.
                </FieldDescription>
              </Field>
              <FieldGroup className="grid grid-cols-2 gap-3">
                {(['start', 'end'] as const).map(edge => (
                  <Field key={edge} data-invalid={invalid('hours') || undefined}>
                    <FieldLabel htmlFor={`${id}-hours-${edge}`}>{edge === 'start' ? 'Start' : 'End'}</FieldLabel>
                    <Input id={`${id}-hours-${edge}`} value={form.activeHours?.[edge] ?? ''} placeholder={edge === 'start' ? '09:00' : '17:00'}
                      disabled={disabled} aria-invalid={invalid('hours') || undefined}
                      onChange={event => { if (form.activeHours) update('activeHours', { ...form.activeHours, [edge]: event.target.value }); }} />
                  </Field>
                ))}
              </FieldGroup>
            </>}
            {popoverError('hours')}
          </SettingChip>
          <SettingChip icon={Plug} label={updatesOn ? 'App updates on' : 'App updates'}
            name={`App updates: ${updatesOn ? `On${task ? `, react within ${durationWords(form.webhook?.respondWithin ?? '5m')}` : ''}` : 'Off'}`}
            open={chip === 'updates'} onOpenChange={openChip('updates')}
            invalid={invalid('updates')} describedBy={describedBy('updates')} buttonRef={register('updates')}>
            <Field orientation="horizontal">
              <FieldLabel htmlFor={`${id}-updates`}>When another app sends an update</FieldLabel>
              <Switch id={`${id}-updates`} checked={updatesOn} disabled={disabled} onCheckedChange={toggleWebhook} />
            </Field>
            {form.webhook !== null && task && (
              <Field>
                <FieldLabel htmlFor={`${id}-respond`}>React within</FieldLabel>
                <Select value={respondValue} disabled={disabled} onValueChange={value => {
                  if (form.webhook !== null && value !== respondExtra) update('webhook', { ...form.webhook, respondWithin: value });
                }}>
                  <SelectTrigger id={`${id}-respond`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>
                    {RESPOND_PRESETS.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                    {respondExtra !== undefined && <SelectItem value={respondExtra}>{durationWords(respondExtra)}</SelectItem>}
                  </SelectGroup></SelectContent>
                </Select>
                <FieldDescription>Updates that arrive close together are handled in one check-in.</FieldDescription>
              </Field>
            )}
            {form.webhook !== null && <FieldDescription>
              {savedWebhook ? 'Its address and signature settings are under More options.'
                : mode === 'create' ? 'You’ll connect the app after you start the task.' : 'You’ll connect the app after you save.'}
            </FieldDescription>}
            {popoverError('updates')}
          </SettingChip>
        </div>
        {(['schedule', 'hours', 'updates'] as const).map(field => <div key={field}>{fieldError(field)}</div>)}
      </div>

      <Collapsible open={more} onOpenChange={setMore}>
        <CollapsibleContent id={`${id}-more`}>
          <FieldGroup className="gap-4">
            <Separator />
            {form.schedule !== null && <>
              <Field>
                <FieldLabel>Schedule</FieldLabel>
                <ToggleGroup type="single" aria-label="Schedule" value={form.schedule.kind} disabled={disabled}
                  className="flex-wrap justify-start" onValueChange={value => {
                    if (value === 'interval' && form.schedule?.kind !== 'interval') update('schedule', { kind: 'interval', every: '1h' });
                    if (value === 'cron' && form.schedule?.kind !== 'cron') update('schedule', { kind: 'cron', expr: '0 8 * * 1-5', tz: browserTimeZone() ?? 'UTC' });
                  }}>
                  <ToggleGroupItem value="interval">Interval</ToggleGroupItem>
                  <ToggleGroupItem value="cron">Custom schedule</ToggleGroupItem>
                </ToggleGroup>
              </Field>
              {form.schedule.kind === 'interval'
                ? textInput('Interval', 'customSchedule', form.schedule.every, value => update('schedule', { kind: 'interval', every: value }),
                  { key: 'every', placeholder: '45m', help: 'A number and a unit: m for minutes, h for hours, d for days.' })
                : <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {textInput('Cron expression', 'customSchedule', form.schedule.expr, value => {
                    if (form.schedule?.kind === 'cron') update('schedule', { ...form.schedule, expr: value });
                  }, { key: 'expr' })}
                  {textInput('Time zone', 'customSchedule', form.schedule.tz, value => {
                    if (form.schedule?.kind === 'cron') update('schedule', { ...form.schedule, tz: value });
                  }, { key: 'tz', focus: false })}
                </FieldGroup>}
              {form.schedule.kind === 'cron' && <FieldDescription>
                {(() => { const words = describeCron(form.schedule.expr); return words.kind === 'described' ? words.text : 'Custom schedule'; })()} · {form.schedule.tz}
              </FieldDescription>}
            </>}
            {form.activeHours && textInput('Active hours time zone', 'hoursZone', form.activeHours.tz,
              value => { if (form.activeHours) update('activeHours', { ...form.activeHours, tz: value }); })}
            {form.webhook !== null && <>
              {textInput('Address name', 'address', form.webhook.path, value => {
                if (form.webhook !== null) update('webhook', { ...form.webhook, path: value });
              }, { maxLength: 128, help: 'The end of the web address the other app sends updates to.' })}
              {textInput('Only these kinds of updates', 'events', eventsDraft, editEvents,
                { placeholder: 'push, issue_comment', help: 'Event names, separated by commas. Leave it empty for every update.' })}
              {savedWebhook && canEdit && routineId !== undefined && (
                <WebhookAddressFields key={`${agentId}/${routineId}`} agentId={agentId} routineId={routineId}
                  path={form.webhook.path} saved={savedWebhook} disabled={disabled} onPendingChange={setAddressBusy} />
              )}
              <div ref={register('signature')} className="contents">
                <WebhookSignatureFields value={form.webhook.hmac} disabled={disabled} taskMode
                  invalidField={invalidField ?? (attempted && !validation.success ? validation.error.issues.find(issue => issue.path[0] === 'webhook' && issue.path[1] === 'hmac')?.path.join('.') : undefined)}
                  onChange={value => {
                    if (form.webhook === null) return;
                    const { hmac: _hmac, ...webhook } = form.webhook;
                    update('webhook', value === undefined ? webhook : { ...webhook, hmac: value });
                  }} />
              </div>
              {fieldError('signature')}
            </>}
            {form.kind === 'repeat' && (
              <Field>
                <FieldLabel>Memory between runs</FieldLabel>
                <ToggleGroup type="single" aria-label="Memory between runs" value={form.conversation} disabled={disabled}
                  className="flex-wrap justify-start" ref={register('conversation')}
                  onValueChange={value => { if (value === 'per-fire' || value === 'shared') update('conversation', value); }}>
                  <ToggleGroupItem value="per-fire">Start fresh each time</ToggleGroupItem>
                  <ToggleGroupItem value="shared">Keep one running conversation</ToggleGroupItem>
                </ToggleGroup>
                {fieldError('conversation')}
              </Field>
            )}
            {showQuiet && textInput('Quiet word (optional)', 'quietWord', form.silenceToken ?? '',
              value => update('silenceToken', value === '' ? null : value),
              { maxLength: 128, help: `When ${agentName}’s reply starts or ends with this word, we drop the reply and mark the run as finished quietly. Leave it empty to keep every reply.` })}
            {showQuiet && form.silenceToken !== null && textInput('Treat replies this short as quiet', 'quietLength', form.silenceMaxChars,
              value => update('silenceMaxChars', Number(value)),
              { type: 'number', help: 'In characters, not counting the quiet word. A longer reply is kept even when it has the quiet word.' })}
            <Field data-invalid={invalid('description') || undefined} data-disabled={disabled || undefined}>
              <FieldLabel htmlFor={`${id}-description`}>Note for you (optional)</FieldLabel>
              <Textarea id={`${id}-description`} ref={register('description')} rows={2} maxLength={2048}
                value={form.description} disabled={disabled} onChange={event => update('description', event.target.value)}
                aria-invalid={invalid('description') || undefined} aria-describedby={describedBy('description')} />
              {fieldError('description')}
            </Field>
            {mode === 'create' && (
              <Field orientation="horizontal">
                <FieldLabel htmlFor={`${id}-enabled`}>Start right away</FieldLabel>
                <Switch id={`${id}-enabled`} checked={form.enabled} disabled={disabled}
                  onCheckedChange={on => update('enabled', on)} />
              </Field>
            )}
          </FieldGroup>
        </CollapsibleContent>
      </Collapsible>

      {shown.has('form') && <FieldError>{shown.get('form')}</FieldError>}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}
            {conflict && onReload && (
              <Button type="button" variant="outline" onClick={onReload}>Reload and discard my changes</Button>
            )}
            {uncertain && <p>We couldn’t confirm the result. Retry sends the same change.</p>}
          </AlertDescription>
        </Alert>
      )}
      {!canEdit && (
        <Alert><AlertDescription>You don’t have permission to edit this task.</AlertDescription></Alert>
      )}

      <div className="sticky bottom-0 -mx-6 -mb-6 flex items-center gap-2 bg-background px-6 pb-6 pt-3">
        <IconAction icon={Ellipsis} label="More options" variant="ghost" aria-expanded={more} aria-controls={`${id}-more`}
          onClick={() => setMore(open => !open)} />
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="ghost" disabled={busy || uncertain || addressBusy} onClick={onCancel}>Cancel</Button>
          <Button type="submit" disabled={busy || addressBusy || !canEdit}>
            {busy ? 'Saving…' : uncertain ? 'Retry save' : mode === 'create' ? 'Start task' : 'Save'}
          </Button>
        </div>
      </div>
    </form>
  );
}
