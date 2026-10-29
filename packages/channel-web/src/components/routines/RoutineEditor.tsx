import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  RoutineDefinitionSchema,
  activeHoursWriteIssue,
  repeatScheduleWriteIssue,
  type RoutineSchedule,
  type WebhookTrigger,
  editableDefinition,
  isTaskKind,
  ROUTINE_GOOD_WHEN_MAX_CHARS,
  type RoutineDefinition,
  type RoutinePatch,
  type RoutineView,
  type RoutineUpsertDefaultInput,
} from '@ax/routines-contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { routineApi, RoutineApiError } from '@/lib/routines';
import { describeCron } from '@/lib/cron-describe';
import { TASK_KIND_LABELS } from '@/lib/task-kinds';
import { browserTimeZone } from '@/lib/task-finish-by';
import { ActiveHoursDaySelector } from './ActiveHoursDaySelector';
import { WebhookSignatureFields } from './WebhookSignatureFields';
import { WebhookAddressFields } from './WebhookAddressFields';

interface Props {
  mode: 'create' | 'edit';
  agentId: string;
  agentName: string;
  routine?: Pick<RoutineView, 'routineId'> | undefined;
  taskMode?: boolean;
  onSaved: (routine: RoutineView) => void;
  onCancel: () => void;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}
interface DefaultProps {
  initial?: RoutineDefinition | RoutineUpsertDefaultInput;
  onSave: (definition: RoutineUpsertDefaultInput) => Promise<unknown>;
  onSaved: () => void;
  onCancel: () => void;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}
const empty = (taskMode = false): RoutineDefinition => ({
  name: '',
  description: '',
  promptBody: '',
  enabled: true,
  schedule: taskMode ? { kind: 'interval', every: '1h' } : {
    kind: 'cron',
    expr: '0 8 * * 1-5',
    tz: browserTimeZone() ?? 'UTC',
  },
  webhook: null,
  activeHours: null,
  silenceToken: null,
  silenceMaxChars: 300,
  conversation: 'per-fire',
  kind: taskMode ? 'stay-on-top' : 'repeat',
  goodWhen: taskMode ? '' : null,
});
const editableKeys = [
  'name',
  'description',
  'promptBody',
  'enabled',
  'schedule',
  'webhook',
  'activeHours',
  'silenceToken',
  'silenceMaxChars',
  'conversation',
  'kind',
  'goodWhen',
] as const;
function changed(
  form: RoutineDefinition,
  loaded: RoutineDefinition,
): RoutinePatch {
  const patch: RoutinePatch = {};
  for (const key of editableKeys)
    if (JSON.stringify(form[key]) !== JSON.stringify(loaded[key]))
      Object.assign(patch, { [key]: form[key] });
  return patch;
}
export function RoutineEditor(props: Props) {
  const [loadedState, setLoaded] = useState<RoutineView | null>(null);
  const loaded = props.mode === 'edit' && loadedState?.agentId === props.agentId && loadedState.routineId === props.routine?.routineId ? loadedState : null;
  const [loadError, setLoadError] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (props.mode !== 'edit' || !props.routine) return;
    let active = true;
    setLoaded(null);
    setLoadError(false);
    void routineApi
      .get({ agentId: props.agentId, routineId: props.routine.routineId })
      .then((r) => {
        if (active) setLoaded(r);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [props.agentId, props.mode, props.routine?.routineId, generation]);
  if (props.mode === 'edit' && loaded === null)
    return loadError ? (
      <Alert variant="destructive">
        <AlertDescription>
          We couldn’t load this routine.{' '}
          <Button variant="outline" onClick={() => setGeneration((v) => v + 1)}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    ) : (
      <Skeleton aria-label="Loading routine" className="h-64 w-full" />
    );
  return (
    <RoutineForm
      key={loaded?.revision ?? 'create'}
      agentId={props.agentId}
      routineId={loaded?.routineId}
      agentName={props.agentName}
      initial={loaded ? editableDefinition(loaded) : empty(props.taskMode)}
      taskMode={props.taskMode === true}
      canEdit={loaded?.permissions.edit ?? true}
      mode={props.mode}
      onCancel={props.onCancel}
      onSaved={result => props.onSaved(result as RoutineView)}
      onReload={() => setGeneration((v) => v + 1)}
      onPendingChange={props.onPendingChange}
      save={async (definition, requestId) =>
        loaded
          ? routineApi.update({
              agentId: props.agentId,
              routineId: loaded.routineId,
              requestId,
              expectedRevision: loaded.revision,
              patch: changed(definition, editableDefinition(loaded)),
            })
          : routineApi.create({ agentId: props.agentId, requestId, definition })
      }
    />
  );
}
/** Defaults share the fields; their existing catalog remains interval-only. */
export function DefaultRoutineEditor(props: DefaultProps) {
  return (
    <RoutineForm
      initial={props.initial ? RoutineDefinitionSchema.parse(props.initial) : {
        ...empty(), schedule: { kind: 'interval', every: '1h' }, webhook: null,
      }}
      agentName="The agent"
      mode={props.initial ? 'edit' : 'create'}
      defaults
      onCancel={props.onCancel}
      onSaved={props.onSaved}
      onPendingChange={props.onPendingChange}
      save={async (definition) => {
        if (definition.schedule?.kind !== 'interval') return;
        const { schedule, webhook: _webhook, ...fields } = definition;
        await props.onSave({ ...fields, kind: 'repeat', goodWhen: null, trigger: schedule });
      }}
    />
  );
}
function RoutineForm({
  initial,
  agentId,
  routineId,
  agentName,
  mode,
  defaults = false,
  taskMode = false,
  canEdit = true,
  save,
  onSaved,
  onCancel,
  onReload,
  onPendingChange,
}: {
  initial: RoutineDefinition;
  agentId?: string | undefined;
  routineId?: string | undefined;
  agentName: string;
  mode: 'create' | 'edit';
  defaults?: boolean;
  taskMode?: boolean;
  canEdit?: boolean;
  save: (definition: RoutineDefinition, requestId: string) => Promise<unknown>;
  onSaved: (result: unknown) => void;
  onCancel: () => void;
  onReload?: () => void;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}) {
  const id = useId();
  const [form, setForm] = useState(initial);
  const [eventsDraft, setEventsDraft] = useState(
    (initial.webhook?.events ?? []).join(', '),
  );
  const [error, setError] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<string | undefined>();
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [optional, setOptional] = useState(false);
  const [addressBusy, setAddressBusy] = useState(false);
  const scheduleDraft = useRef<RoutineSchedule>(initial.schedule ?? { kind: 'interval', every: '1h' });
  const webhookDraft = useRef<WebhookTrigger>(initial.webhook ?? { kind: 'webhook', path: '/project-updates' });
  const hoursDraft = useRef(initial.activeHours);
  const flight = useRef(false);
  // Exact payload and request ID survive a response-loss retry. Draft controls freeze meanwhile.
  const operation = useRef<{
    requestId: string;
    definition: RoutineDefinition;
  } | null>(null);
  // Keep separators in the input; normalize only the definition being validated/saved.
  const draftDefinition = useMemo(() => {
    if (form.webhook === null) return form;
    const { events: _events, ...webhook } = form.webhook;
    const events = eventsDraft
      .split(',')
      .map((event) => event.trim())
      .filter(Boolean);
    return { ...form, webhook: events.length ? { ...webhook, events } : webhook };
  }, [form, eventsDraft]);
  const validation = useMemo(() => {
    const parsed = RoutineDefinitionSchema.safeParse(draftDefinition);
    if (parsed.success) {
      const issue = activeHoursWriteIssue(parsed.data.activeHours);
      if (issue !== null) return { success: false as const, error: { issues: [{ path: ['activeHours', 'end'], message: issue }] } };
    }
    if (parsed.success && parsed.data.kind === 'repeat') {
      const issue = repeatScheduleWriteIssue(parsed.data.schedule, mode === 'edit' ? initial.schedule : undefined);
      if (issue !== null) return { success: false as const, error: { issues: [{ path: ['schedule', 'expr'], message: issue }] } };
    }
    return parsed;
  }, [draftDefinition, initial.schedule, mode]);
  const dirty = Object.keys(changed(draftDefinition, initial)).length > 0;
  // Neither the host (core's TOOL_FIELDS) nor RoutineApiError can name
  // goodWhen, so its invalid state is the contract's own check here, which
  // already keeps Save off (TASK-953, row 10).
  const firstIssue =
    !validation.success && (dirty || activeHoursWriteIssue(draftDefinition.activeHours) !== null) ? validation.error.issues[0] : undefined;
  const goodWhenInvalid = firstIssue?.path[0] === 'goodWhen';
  const activeDaysInvalid = (firstIssue?.path[0] === 'activeHours' && firstIssue?.path[1] === 'days') || invalidField === 'activeHours.days';
  const disabled = busy || uncertain || addressBusy || !canEdit;
  useEffect(() => {
    onPendingChange?.(busy || uncertain || addressBusy);
  }, [busy, uncertain, addressBusy, onPendingChange]);
  function update<K extends keyof RoutineDefinition>(
    key: K,
    value: RoutineDefinition[K],
  ) {
    if (key === 'schedule' && value !== null) scheduleDraft.current = value as RoutineSchedule;
    if (key === 'webhook' && value !== null) webhookDraft.current = value as WebhookTrigger;
    if (key === 'activeHours') hoursDraft.current = value as RoutineDefinition['activeHours'];
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
    setInvalidField(undefined);
  }
  function toggleSchedule(on: boolean) {
    if (!on) {
      if (form.schedule !== null) scheduleDraft.current = form.schedule;
      hoursDraft.current = form.activeHours;
    }
    setForm(f => ({ ...f, schedule: on ? scheduleDraft.current : null, activeHours: on ? hoursDraft.current : null }));
    setError(null); setInvalidField(undefined);
  }
  function toggleWebhook(on: boolean) {
    if (!on && form.webhook !== null) webhookDraft.current = form.webhook;
    update('webhook', on ? webhookDraft.current : null);
  }
  function textField(
    label: string,
    value: string | number,
    field: string,
    onChange: (value: string) => void,
    options: { type?: string; maxLength?: number; disabled?: boolean } = {},
  ) {
    const invalid =
      invalidField === field || invalidField?.startsWith(`${field}.`) === true ||
      firstIssue?.path.join('.') === field || firstIssue?.path.join('.').startsWith(`${field}.`) === true;
    return (
      <Field
        data-invalid={invalid || undefined}
        data-disabled={disabled || options.disabled || undefined}
      >
        <FieldLabel htmlFor={`${id}-${field}`}>{label}</FieldLabel>
        <Input
          id={`${id}-${field}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid || undefined}
          {...options}
          disabled={disabled || options.disabled}
        />
      </Field>
    );
  }
  async function submit() {
    if (
      flight.current ||
      !canEdit ||
      (!operation.current &&
        (!validation.success || (mode === 'edit' && !dirty)))
    )
      return;
    flight.current = true;
    setBusy(true);
    setError(null);
    setConflict(false);
    operation.current ??= {
      requestId: crypto.randomUUID(),
      definition: validation.success ? validation.data : draftDefinition,
    };
    try {
      const result = await save(operation.current.definition, operation.current.requestId);
      operation.current = null;
      setUncertain(false);
      onSaved(result);
    } catch (e) {
      const safe = e instanceof RoutineApiError;
      setError(safe ? e.message : 'We couldn’t save this routine. Try again.');
      setInvalidField(safe ? e.field : undefined);
      setConflict(safe && e.code === 'revision-conflict');
      if (!safe || e.status === 0 || e.status >= 500) setUncertain(true);
      else {
        operation.current = null;
        setUncertain(false);
      }
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  const savedWebhook =
    initial.webhook !== null &&
    initial.webhook.path === form.webhook?.path &&
    mode === 'edit';
  const scheduleFields = (form.schedule !== null && (
          <>
            <Field>
              <FieldLabel>Schedule</FieldLabel>
              <ToggleGroup type="single" aria-label="Schedule" value={form.schedule.kind} disabled={disabled} onValueChange={value => {
                if (value === 'interval') update('schedule', { kind: 'interval', every: '1h' });
                if (value === 'cron' && !defaults) update('schedule', { kind: 'cron', expr: '0 8 * * 1-5', tz: browserTimeZone() ?? 'UTC' });
              }} className="justify-start flex-wrap">
                <ToggleGroupItem value="interval">Interval</ToggleGroupItem>
                {!defaults && <ToggleGroupItem value="cron">Custom schedule</ToggleGroupItem>}
              </ToggleGroup>
            </Field>
            {form.schedule.kind === 'interval' && textField('Interval', form.schedule.every, 'schedule.every', value => update('schedule', { kind: 'interval', every: value }))}
            {form.schedule.kind === 'cron' && (
              <>
                <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {textField('Cron expression', form.schedule.expr, 'schedule.expr', value => { if (form.schedule?.kind === 'cron') update('schedule', { ...form.schedule, expr: value }); })}
                  {textField('Time zone', form.schedule.tz, 'schedule.tz', value => { if (form.schedule?.kind === 'cron') update('schedule', { ...form.schedule, tz: value }); })}
                </FieldGroup>
                <FieldDescription>{describeCron(form.schedule.expr).kind === 'described' ? (describeCron(form.schedule.expr) as { text: string }).text : 'Custom schedule'} · {form.schedule.tz}</FieldDescription>
              </>
            )}
          </>
        ));
  const conversationFields = (<Field>
          <FieldLabel>Conversation</FieldLabel>
          <ToggleGroup
            type="single"
            aria-label="Conversation"
            value={form.conversation}
            disabled={disabled}
            onValueChange={(v) => {
              if (v === 'per-fire' || v === 'shared') update('conversation', v);
            }}
            className="justify-start flex-wrap"
          >
            <ToggleGroupItem value="per-fire">New each run</ToggleGroupItem>
            <ToggleGroupItem value="shared">One ongoing thread</ToggleGroupItem>
          </ToggleGroup>
          <FieldDescription>
            {form.conversation === 'per-fire'
              ? 'Each run starts in a fresh conversation.'
              : 'Runs continue in one ongoing conversation.'}
          </FieldDescription>
        </Field>);
  const hoursFields = (<><Field orientation="horizontal">
                <FieldLabel htmlFor={`${id}-hours`}>Active hours</FieldLabel>
                <Switch
                  id={`${id}-hours`}
                  checked={form.activeHours !== null}
                  disabled={disabled || form.schedule === null}
                  onCheckedChange={(v) =>
                    update(
                      'activeHours',
                      v
                        ? {
                            start: '09:00',
                            end: '17:00',
                            tz: browserTimeZone() ?? 'UTC',
                          }
                        : null,
                    )
                  }
                />
              </Field>
              {form.webhook !== null && <FieldDescription>{isTaskKind(form.kind) ? 'Updates received outside active hours wait for the next active window.' : 'App updates run when received. Active hours apply to the schedule.'}</FieldDescription>}
              {form.activeHours && (
                <>
                <Field data-invalid={activeDaysInvalid || undefined}>
                  <FieldLabel>Active days</FieldLabel>
                  <ActiveHoursDaySelector value={form.activeHours.days} disabled={disabled}
                    invalid={activeDaysInvalid}
                    describedBy={activeDaysInvalid ? `${id}-days-error ${id}-days-help` : `${id}-days-help`}
                    onChange={days => { if (form.activeHours) update('activeHours', { ...form.activeHours, days }); }} />
                  <FieldDescription id={`${id}-days-help`}>
                    Selected days name when the window starts. Overnight hours continue into the next morning.
                  </FieldDescription>
                  {activeDaysInvalid && <FieldError id={`${id}-days-error`}>Choose at least one active day.</FieldError>}
                </Field>
                <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  {textField(
                    'Start',
                    form.activeHours.start,
                    'activeHours.start',
                    (v) => {
                      if (form.activeHours)
                        update('activeHours', {
                          ...form.activeHours,
                          start: v,
                        });
                    },
                  )}
                  {textField(
                    'End',
                    form.activeHours.end,
                    'activeHours.end',
                    (v) => {
                      if (form.activeHours)
                        update('activeHours', { ...form.activeHours, end: v });
                    },
                  )}
                  {!taskMode && textField(
                    'Active hours time zone',
                    form.activeHours.tz,
                    'activeHours.tz',
                    (v) => {
                      if (form.activeHours)
                        update('activeHours', { ...form.activeHours, tz: v });
                    },
                  )}
                </FieldGroup>
                </>
              )}</>);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {taskMode && <Field>
        <FieldLabel>What kind of help do you need?</FieldLabel>
        <ToggleGroup type="single" aria-label="Task kind" value={form.kind} disabled={disabled}
          className="flex-wrap justify-start" onValueChange={value => {
            if (value !== 'repeat' && value !== 'stay-on-top' && value !== 'get-done') return;
            if (value === 'repeat') {
              const { respondWithin: _respondWithin, ...webhook } = webhookDraft.current;
              webhookDraft.current = webhook;
            }
            setForm(f => ({ ...f, kind: value, goodWhen: value === 'repeat' ? null : (f.goodWhen ?? ''),
              schedule: value === 'repeat' ? f.schedule : (f.schedule ?? { kind: 'interval', every: '1h' }),
              webhook: value === 'repeat' && f.webhook !== null ? webhookDraft.current : f.webhook,
              conversation: value === 'repeat' ? f.conversation : 'per-fire' }));
            setError(null); setInvalidField(undefined);
          }}>
          {(['stay-on-top', 'get-done', 'repeat'] as const).map(kind => <ToggleGroupItem key={kind} value={kind}>{TASK_KIND_LABELS[kind]}</ToggleGroupItem>)}
        </ToggleGroup>
      </Field>}
      {taskMode && mode === 'edit' && form.kind !== initial.kind && <Alert><AlertDescription>
        Changing the kind clears steps, latest update, notes, claim, Done status, and finish date.
      </AlertDescription></Alert>}
      {!taskMode && isTaskKind(form.kind) && (
        <p className="text-sm text-muted-foreground">
          {TASK_KIND_LABELS[form.kind]}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        {isTaskKind(form.kind) ? `${agentName} checks in on schedule and batches updates from connected apps.` : `${agentName} runs this work on its schedule or when an app sends an update.`}
      </p>
      <FieldGroup className="gap-4">
        <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {textField('Name', form.name, 'name', (v) => update('name', v), {
            maxLength: 128,
            disabled: defaults && mode === 'edit',
          })}
          {textField(
            'Description',
            form.description,
            'description',
            (v) => update('description', v),
            { maxLength: 2048 },
          )}
        </FieldGroup>
        <Field data-invalid={invalidField === 'promptBody' || undefined}>
          <FieldLabel htmlFor={`${id}-promptBody`}>
            What should {agentName} do?
          </FieldLabel>
          <Textarea
            id={`${id}-promptBody`}
            rows={3}
            value={form.promptBody}
            onChange={(e) => update('promptBody', e.target.value)}
            disabled={disabled}
            aria-invalid={invalidField === 'promptBody' || undefined}
          />
        </Field>
        {isTaskKind(form.kind) && (
          <Field data-invalid={goodWhenInvalid || undefined}>
            <FieldLabel htmlFor={`${id}-goodWhen`}>Going well when</FieldLabel>
            <Textarea
              id={`${id}-goodWhen`}
              rows={2}
              maxLength={ROUTINE_GOOD_WHEN_MAX_CHARS}
              value={form.goodWhen ?? ''}
              onChange={(e) => update('goodWhen', e.target.value)}
              disabled={disabled}
              aria-invalid={goodWhenInvalid || undefined}
            />
          </Field>
        )}
        {!defaults && (
          <FieldSet className="gap-3">
            <FieldLegend variant="label">When to run</FieldLegend>
            <Field orientation="horizontal">
              <Checkbox id={`${id}-scheduled`} checked={form.schedule !== null} disabled={disabled || isTaskKind(form.kind)} onCheckedChange={value => toggleSchedule(value === true)} />
              <FieldLabel htmlFor={`${id}-scheduled`}>On a schedule</FieldLabel>
            </Field>
            {isTaskKind(form.kind) && <FieldDescription>The schedule stays on for full check-ins, even if an app misses an update.</FieldDescription>}
            <Field orientation="horizontal">
              <Checkbox id={`${id}-updates`} checked={form.webhook !== null} disabled={disabled} onCheckedChange={value => toggleWebhook(value === true)} />
              <FieldLabel htmlFor={`${id}-updates`}>When another app sends an update</FieldLabel>
            </Field>
          </FieldSet>
        )}
        {!taskMode ? scheduleFields : form.schedule !== null && !optional && (
          form.schedule.kind === 'interval'
            ? textField('Interval', form.schedule.every, 'schedule.every', value => update('schedule', { kind: 'interval', every: value }))
            : <FieldDescription>Custom schedule. Open More options to review its time zone and cron expression.</FieldDescription>
        )}
        {form.webhook !== null && (
          <>
            {isTaskKind(form.kind) && <>
              {textField('Respond within', form.webhook.respondWithin ?? '5m', 'webhook.respondWithin', value => {
                if (form.webhook !== null) update('webhook', { ...form.webhook, respondWithin: value });
              }, { maxLength: 32 })}
              <FieldDescription>Batch app updates into one check-in. Use 1m to 24h; 5m means fewer check-ins on a busy day. Extra waiting batches follow after the current check-in.</FieldDescription>
            </>}
            <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {textField(
                'Webhook path',
                form.webhook.path,
                'webhook.path',
                (v) => {
                  if (form.webhook !== null)
                    update('webhook', { ...form.webhook, path: v });
                },
                { maxLength: 128 },
              )}
              {textField(
                'Events (comma-separated)',
                eventsDraft,
                'webhook.events',
                (v) => {
                  setEventsDraft(v);
                  setError(null);
                  setInvalidField(undefined);
                },
              )}
            </FieldGroup>
            {agentId && canEdit && <WebhookAddressFields key={`${agentId}/${routineId ?? 'create'}`} agentId={agentId} routineId={initial.webhook === null ? undefined : routineId}
              path={form.webhook.path} saved={savedWebhook} disabled={disabled} onPendingChange={setAddressBusy} />}
          </>
        )}
        {taskMode && hoursFields}
        {!taskMode && conversationFields}
        <Collapsible open={optional} onOpenChange={setOptional}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-between"
            >
              {taskMode ? 'More options' : 'Optional settings'}
              <ChevronRight data-icon="inline-end" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <FieldGroup className="gap-4">
              {taskMode && scheduleFields}
              {taskMode && form.kind === 'repeat' && conversationFields}
              {taskMode && form.activeHours && textField('Active hours time zone', form.activeHours.tz, 'activeHours.tz', value => { if (form.activeHours) update('activeHours', { ...form.activeHours, tz: value }); })}
              {!taskMode && hoursFields}
              {(!taskMode || form.kind === 'repeat') && <>
{textField(
                'Silence token',
                form.silenceToken ?? '',
                'silenceToken',
                (v) => update('silenceToken', v === '' ? null : v),
                { maxLength: 128 },
              )}
              {textField(
                'Maximum quiet response characters',
                form.silenceMaxChars,
                'silenceMaxChars',
                (v) => update('silenceMaxChars', Number(v)),
                { type: 'number' },
              )}
              </>}
              {form.webhook !== null && (
                <>
                  <WebhookSignatureFields
                    value={form.webhook.hmac}
                    disabled={disabled}
                    taskMode={taskMode}
                    invalidField={invalidField ?? firstIssue?.path.join('.')}
                    onChange={value => {
                      if (form.webhook === null) return;
                      const { hmac: _hmac, ...webhook } = form.webhook;
                      update('webhook', value === undefined ? webhook : { ...webhook, hmac: value });
                    }}
                  />
                </>
              )}
            </FieldGroup>
          </CollapsibleContent>
        </Collapsible>
      </FieldGroup>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}
            {conflict && onReload && (
              <Button type="button" variant="outline" onClick={onReload}>
                Reload and discard my changes
              </Button>
            )}
            {uncertain && (
              <p>
                We couldn’t confirm the result. Retry sends the same change.
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}
      {!validation.success && firstIssue && !activeDaysInvalid && (
        <p className="text-sm text-destructive" role="status">
          {validation.error.issues[0]?.message}
        </p>
      )}
      {!canEdit && (
        <Alert>
          <AlertDescription>
            You don’t have permission to edit this task.
          </AlertDescription>
        </Alert>
      )}
      <Separator />
      <div className="flex flex-wrap items-center gap-2">
        <Field orientation="horizontal" className="w-auto">
          <FieldLabel htmlFor={`${id}-enabled`}>Enabled</FieldLabel>
          <Switch
            id={`${id}-enabled`}
            checked={form.enabled}
            disabled={disabled}
            onCheckedChange={(v) => update('enabled', v)}
          />
        </Field>
        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy || uncertain || addressBusy}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              busy || addressBusy ||
              !canEdit ||
              (!uncertain &&
                (!validation.success || (mode === 'edit' && !dirty)))
            }
          >
            {busy
              ? 'Saving…'
              : uncertain
                ? 'Retry save'
                : mode === 'create'
                  ? taskMode ? 'Start task' : 'Create routine'
                  : 'Save'}
          </Button>
        </div>
      </div>
    </form>
  );
}
