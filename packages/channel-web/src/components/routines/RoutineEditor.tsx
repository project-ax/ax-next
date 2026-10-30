import { useEffect, useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  RoutineDefinitionSchema,
  activeHoursWriteIssue,
  editableDefinition,
  isTaskKind,
  ROUTINE_GOOD_WHEN_MAX_CHARS,
  type RoutineDefinition,
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
import { routineApi } from '@/lib/routines';
import { describeCron } from '@/lib/cron-describe';
import { TASK_KIND_LABELS } from '@/lib/task-kinds';
import { browserTimeZone } from '@/lib/task-finish-by';
import { TaskForm, type TaskAgentChoice } from '@/components/workspace/TaskForm';
import { ActiveHoursDaySelector } from './ActiveHoursDaySelector';
import { WebhookSignatureFields } from './WebhookSignatureFields';
import { WebhookAddressFields } from './WebhookAddressFields';
import { changed, useRoutineDraft } from './use-routine-draft';

interface Props {
  mode: 'create' | 'edit';
  agentId: string;
  agentName: string;
  routine?: Pick<RoutineView, 'routineId'> | undefined;
  taskMode?: boolean;
  /** Tasks only: the agents a new task may go to, drawn as the form's agent chip. */
  agentChoices?: TaskAgentChoice | undefined;
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
  const shared = {
    initial: loaded ? editableDefinition(loaded) : empty(props.taskMode),
    agentId: props.agentId,
    routineId: loaded?.routineId,
    agentName: props.agentName,
    canEdit: loaded?.permissions.edit ?? true,
    mode: props.mode,
    onCancel: props.onCancel,
    onSaved: (result: unknown) => props.onSaved(result as RoutineView),
    onReload: () => setGeneration((v) => v + 1),
    onPendingChange: props.onPendingChange,
    save: async (definition: RoutineDefinition, requestId: string) =>
      loaded
        ? routineApi.update({
            agentId: props.agentId,
            routineId: loaded.routineId,
            requestId,
            expectedRevision: loaded.revision,
            patch: changed(definition, editableDefinition(loaded)),
          })
        : routineApi.create({ agentId: props.agentId, requestId, definition }),
  };
  // A task gets the minimal Tasks form; both send the same definition through `save`.
  return props.taskMode
    ? <TaskForm key={loaded?.revision ?? 'create'} {...shared} agentChoices={props.agentChoices} />
    : <RoutineForm key={loaded?.revision ?? 'create'} {...shared} />;
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
  canEdit?: boolean;
  save: (definition: RoutineDefinition, requestId: string) => Promise<unknown>;
  onSaved: (result: unknown) => void;
  onCancel: () => void;
  onReload?: () => void;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}) {
  const id = useId();
  const [optional, setOptional] = useState(false);
  const {
    form, eventsDraft, draftDefinition, validation, dirty, disabled, error, invalidField,
    conflict, busy, uncertain, addressBusy, setAddressBusy, update, editEvents,
    toggleSchedule, toggleWebhook, submit,
  } = useRoutineDraft({ initial, mode, canEdit, save, onSaved, onPendingChange });
  // Neither the host (core's TOOL_FIELDS) nor RoutineApiError can name
  // goodWhen, so its invalid state is the contract's own check here, which
  // already keeps Save off (TASK-953, row 10).
  const firstIssue =
    !validation.success && (dirty || activeHoursWriteIssue(draftDefinition.activeHours) !== null) ? validation.error.issues[0] : undefined;
  const goodWhenInvalid = firstIssue?.path[0] === 'goodWhen';
  const activeDaysInvalid = (firstIssue?.path[0] === 'activeHours' && firstIssue?.path[1] === 'days') || invalidField === 'activeHours.days';
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
                  {textField(
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
      {isTaskKind(form.kind) && (
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
        {scheduleFields}
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
                editEvents,
              )}
            </FieldGroup>
            {agentId && canEdit && <WebhookAddressFields key={`${agentId}/${routineId ?? 'create'}`} agentId={agentId} routineId={initial.webhook === null ? undefined : routineId}
              path={form.webhook.path} saved={savedWebhook} disabled={disabled} onPendingChange={setAddressBusy} />}
          </>
        )}
        {conversationFields}
        <Collapsible open={optional} onOpenChange={setOptional}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-between"
            >
              Optional settings
              <ChevronRight data-icon="inline-end" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <FieldGroup className="gap-4">
              {hoursFields}
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
              {form.webhook !== null && (
                <>
                  <WebhookSignatureFields
                    value={form.webhook.hmac}
                    disabled={disabled}
                    taskMode={false}
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
                  ? 'Create routine'
                  : 'Save'}
          </Button>
        </div>
      </div>
    </form>
  );
}
