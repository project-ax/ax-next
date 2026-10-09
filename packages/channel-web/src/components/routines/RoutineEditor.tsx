import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, Copy } from 'lucide-react';
import {
  RoutineDefinitionSchema,
  editableDefinition,
  validateWebhookPath,
  type RoutineDefinition,
  type RoutinePatch,
  type RoutineView,
  type RoutineUpsertDefaultInput,
} from '@ax/routines-contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
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

interface Props {
  mode: 'create' | 'edit';
  agentId: string;
  agentName: string;
  routine?: RoutineView | undefined;
  onSaved: () => void;
  onCancel: () => void;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}
interface DefaultProps {
  initial?: RoutineDefinition;
  onSave: (definition: RoutineUpsertDefaultInput) => Promise<unknown>;
  onSaved: () => void;
  onCancel: () => void;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}
const empty = (): RoutineDefinition => ({
  name: '',
  description: '',
  promptBody: '',
  enabled: true,
  trigger: {
    kind: 'cron',
    expr: '0 8 * * 1-5',
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  },
  activeHours: null,
  silenceToken: null,
  silenceMaxChars: 300,
  conversation: 'per-fire',
});
const editableKeys = [
  'name',
  'description',
  'promptBody',
  'enabled',
  'trigger',
  'activeHours',
  'silenceToken',
  'silenceMaxChars',
  'conversation',
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
  const [loaded, setLoaded] = useState<RoutineView | null>(null);
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
      agentName={props.agentName}
      initial={loaded ? editableDefinition(loaded) : empty()}
      canEdit={loaded?.permissions.edit ?? true}
      mode={props.mode}
      onCancel={props.onCancel}
      onSaved={props.onSaved}
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
      initial={
        props.initial ?? {
          ...empty(),
          trigger: { kind: 'interval', every: '1h' },
        }
      }
      agentName="The agent"
      mode={props.initial ? 'edit' : 'create'}
      defaults
      onCancel={props.onCancel}
      onSaved={props.onSaved}
      onPendingChange={props.onPendingChange}
      save={async (definition) => {
        if (definition.trigger.kind !== 'interval') return;
        await props.onSave({ ...definition, trigger: definition.trigger });
      }}
    />
  );
}
function RoutineForm({
  initial,
  agentId,
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
  agentName: string;
  mode: 'create' | 'edit';
  defaults?: boolean;
  canEdit?: boolean;
  save: (definition: RoutineDefinition, requestId: string) => Promise<unknown>;
  onSaved: () => void;
  onCancel: () => void;
  onReload?: () => void;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}) {
  const id = useId();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<string | undefined>();
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [optional, setOptional] = useState(false);
  const [receiver, setReceiver] = useState<string | null>(null);
  const [receiverError, setReceiverError] = useState(false);
  const [copyState, setCopyState] = useState('');
  const flight = useRef(false);
  // Exact payload and request ID survive a response-loss retry. Draft controls freeze meanwhile.
  const operation = useRef<{
    requestId: string;
    definition: RoutineDefinition;
  } | null>(null);
  useEffect(() => {
    if (!agentId || form.trigger.kind !== 'webhook') return;
    let active = true;
    setReceiver(null);
    setReceiverError(false);
    void routineApi
      .getReceiver(agentId)
      .then((r) => {
        if (active) setReceiver(r.url);
      })
      .catch(() => {
        if (active) setReceiverError(true);
      });
    return () => {
      active = false;
    };
  }, [agentId, form.trigger.kind]);
  const validation = useMemo(
    () => RoutineDefinitionSchema.safeParse(form),
    [form],
  );
  const dirty = Object.keys(changed(form, initial)).length > 0;
  const disabled = busy || uncertain || !canEdit;
  useEffect(() => {
    onPendingChange?.(busy || uncertain);
  }, [busy, uncertain, onPendingChange]);
  function update<K extends keyof RoutineDefinition>(
    key: K,
    value: RoutineDefinition[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
    setInvalidField(undefined);
    setCopyState('');
  }
  function textField(
    label: string,
    value: string | number,
    field: string,
    onChange: (value: string) => void,
    options: { type?: string; maxLength?: number; disabled?: boolean } = {},
  ) {
    const invalid =
      invalidField === field || invalidField?.startsWith(`${field}.`) === true;
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
      definition: validation.success ? validation.data : form,
    };
    try {
      await save(operation.current.definition, operation.current.requestId);
      operation.current = null;
      setUncertain(false);
      onSaved();
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
  let preview: string | null = null;
  if (
    receiver &&
    form.trigger.kind === 'webhook' &&
    validateWebhookPath(form.trigger.path)
  ) {
    try {
      preview = `${new URL(receiver, window.location.origin).href.replace(/\/$/, '')}${form.trigger.path}`;
    } catch {
      /* Unavailable receiver is never an example token. */
    }
  }
  const savedWebhook =
    initial.trigger.kind === 'webhook' &&
    JSON.stringify(initial.trigger) === JSON.stringify(form.trigger) &&
    mode === 'edit';
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm text-muted-foreground">
        {agentName} runs this work when its trigger fires.
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
        <Field>
          <FieldLabel>When to run</FieldLabel>
          <ToggleGroup
            type="single"
            aria-label="When to run"
            value={form.trigger.kind}
            disabled={disabled}
            onValueChange={(v) => {
              if (v === 'interval')
                update('trigger', { kind: 'interval', every: '1h' });
              if (v === 'cron')
                update('trigger', {
                  kind: 'cron',
                  expr: '0 8 * * 1-5',
                  tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                });
              if (v === 'webhook')
                setForm((f) => ({
                  ...f,
                  activeHours: null,
                  trigger: { kind: 'webhook', path: '/project-updates' },
                }));
            }}
            className="justify-start flex-wrap"
          >
            {!defaults && (
              <ToggleGroupItem value="cron">Schedule</ToggleGroupItem>
            )}
            <ToggleGroupItem value="interval">Interval</ToggleGroupItem>
            {!defaults && (
              <ToggleGroupItem value="webhook">Webhook</ToggleGroupItem>
            )}
          </ToggleGroup>
        </Field>
        {form.trigger.kind === 'interval' &&
          textField('Interval', form.trigger.every, 'trigger.every', (v) =>
            update('trigger', { kind: 'interval', every: v }),
          )}
        {form.trigger.kind === 'cron' && (
          <>
            <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {textField(
                'Schedule',
                form.trigger.expr,
                'trigger.expr',
                (v) => {
                  if (form.trigger.kind === 'cron')
                    update('trigger', { ...form.trigger, expr: v });
                },
                { maxLength: 256 },
              )}
              {textField('Time zone', form.trigger.tz, 'trigger.tz', (v) => {
                if (form.trigger.kind === 'cron')
                  update('trigger', { ...form.trigger, tz: v });
              })}
            </FieldGroup>
            <p className="text-xs text-muted-foreground">
              {describeCron(form.trigger.expr).kind === 'described'
                ? (describeCron(form.trigger.expr) as { text: string }).text
                : 'Custom schedule'}{' '}
              · {form.trigger.tz}
            </p>
          </>
        )}
        {form.trigger.kind === 'webhook' && (
          <>
            <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {textField(
                'Webhook path',
                form.trigger.path,
                'trigger.path',
                (v) => {
                  if (form.trigger.kind === 'webhook')
                    update('trigger', { ...form.trigger, path: v });
                },
                { maxLength: 128 },
              )}
              {textField(
                'Events (comma-separated)',
                (form.trigger.events ?? []).join(', '),
                'trigger.events',
                (v) => {
                  if (form.trigger.kind === 'webhook') {
                    const { events: _events, ...rest } = form.trigger;
                    const events = v
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean);
                    update(
                      'trigger',
                      events.length ? { ...rest, events } : rest,
                    );
                  }
                },
              )}
            </FieldGroup>
            {receiverError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  Webhook URL is unavailable. Receiver permission may be
                  missing.
                </AlertDescription>
              </Alert>
            ) : receiver === null ? (
              <Skeleton
                aria-label="Loading webhook URL"
                className="h-10 w-full"
              />
            ) : preview ? (
              <Field>
                <FieldLabel>Webhook URL</FieldLabel>
                <div className="flex min-w-0 gap-2">
                  <Input aria-label="Webhook URL" readOnly value={preview} />
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="Copy webhook URL"
                    onClick={() => {
                      void navigator.clipboard
                        ?.writeText(preview)
                        .then(() => setCopyState('Copied webhook URL.'))
                        .catch(() =>
                          setCopyState(
                            'Couldn’t copy. Select the URL to copy it.',
                          ),
                        );
                    }}
                  >
                    <Copy data-icon="inline-start" />
                  </Button>
                </div>
                <FieldDescription>
                  {savedWebhook
                    ? 'Saved receiver URL.'
                    : mode === 'create'
                      ? 'Preview only — inactive until Create routine.'
                      : 'Preview only — inactive until Save. Save to apply path changes.'}
                </FieldDescription>
                <span role="status" className="text-xs text-muted-foreground">
                  {copyState}
                </span>
              </Field>
            ) : (
              <FieldDescription>
                Enter a valid path to preview the webhook URL.
              </FieldDescription>
            )}
          </>
        )}
        <Field>
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
        </Field>
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
              <Field orientation="horizontal">
                <FieldLabel htmlFor={`${id}-hours`}>Active hours</FieldLabel>
                <Switch
                  id={`${id}-hours`}
                  checked={form.activeHours !== null}
                  disabled={disabled || form.trigger.kind === 'webhook'}
                  onCheckedChange={(v) =>
                    update(
                      'activeHours',
                      v
                        ? {
                            start: '09:00',
                            end: '17:00',
                            tz:
                              Intl.DateTimeFormat().resolvedOptions()
                                .timeZone || 'UTC',
                          }
                        : null,
                    )
                  }
                />
              </Field>
              {form.trigger.kind === 'webhook' && (
                <FieldDescription>
                  Webhooks run when received; active hours is unavailable.
                </FieldDescription>
              )}
              {form.activeHours && (
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
              )}
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
              {form.trigger.kind === 'webhook' && (
                <>
                  <Field orientation="horizontal">
                    <FieldLabel htmlFor={`${id}-hmac`}>
                      Verify HMAC signature
                    </FieldLabel>
                    <Switch
                      id={`${id}-hmac`}
                      checked={form.trigger.hmac !== undefined}
                      disabled={disabled}
                      onCheckedChange={(v) => {
                        if (form.trigger.kind === 'webhook') {
                          const { hmac: _hmac, ...rest } = form.trigger;
                          update(
                            'trigger',
                            v
                              ? {
                                  ...rest,
                                  hmac: {
                                    header: 'X-Hub-Signature-256',
                                    algorithm: 'sha256',
                                  },
                                }
                              : rest,
                          );
                        }
                      }}
                    />
                  </Field>
                  {form.trigger.hmac && (
                    <>
                      {textField(
                        'Signature header',
                        form.trigger.hmac.header,
                        'trigger.hmac.header',
                        (v) => {
                          if (
                            form.trigger.kind === 'webhook' &&
                            form.trigger.hmac
                          )
                            update('trigger', {
                              ...form.trigger,
                              hmac: { ...form.trigger.hmac, header: v },
                            });
                        },
                        { maxLength: 128 },
                      )}
                      <Field>
                        <FieldLabel>Signature algorithm</FieldLabel>
                        <ToggleGroup
                          type="single"
                          aria-label="Signature algorithm"
                          value={form.trigger.hmac.algorithm}
                          disabled={disabled}
                          onValueChange={(v) => {
                            if (
                              (v === 'sha256' || v === 'sha1') &&
                              form.trigger.kind === 'webhook' &&
                              form.trigger.hmac
                            )
                              update('trigger', {
                                ...form.trigger,
                                hmac: { ...form.trigger.hmac, algorithm: v },
                              });
                          }}
                          className="justify-start"
                        >
                          <ToggleGroupItem value="sha256">
                            SHA256
                          </ToggleGroupItem>
                          <ToggleGroupItem value="sha1">SHA1</ToggleGroupItem>
                        </ToggleGroup>
                      </Field>
                      {textField(
                        'Signature prefix',
                        form.trigger.hmac.prefix ?? '',
                        'trigger.hmac.prefix',
                        (v) => {
                          if (
                            form.trigger.kind === 'webhook' &&
                            form.trigger.hmac
                          ) {
                            const { prefix: _prefix, ...hmac } =
                              form.trigger.hmac;
                            update('trigger', {
                              ...form.trigger,
                              hmac: v ? { ...hmac, prefix: v } : hmac,
                            });
                          }
                        },
                        { maxLength: 128 },
                      )}
                      <FieldDescription>
                        Manage the secret in this saved routine’s credential
                        settings.
                      </FieldDescription>
                    </>
                  )}
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
      {!validation.success && dirty && (
        <p className="text-sm text-destructive" role="status">
          {validation.error.issues[0]?.message}
        </p>
      )}
      {!canEdit && (
        <Alert>
          <AlertDescription>
            You don’t have permission to edit this routine.
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
            disabled={busy || uncertain}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              busy ||
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
