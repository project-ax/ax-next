import { useEffect, useMemo, useRef, useState } from 'react';
import {
  RoutineDefinitionSchema,
  activeHoursWriteIssue,
  repeatScheduleWriteIssue,
  type RoutineDefinition,
  type RoutinePatch,
  type RoutineSchedule,
  type WebhookTrigger,
} from '@ax/routines-contract';
import { RoutineApiError, type RoutineErrorCode } from '@/lib/routines';

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
export function changed(
  form: RoutineDefinition,
  loaded: RoutineDefinition,
): RoutinePatch {
  const patch: RoutinePatch = {};
  for (const key of editableKeys)
    if (JSON.stringify(form[key]) !== JSON.stringify(loaded[key]))
      Object.assign(patch, { [key]: form[key] });
  return patch;
}

/**
 * One routine draft: its state, its validation and its single logical save.
 * The Settings routine form and the Tasks form draw it differently, but both
 * edit and send exactly this, so a task saves the same definition through the
 * same calls whichever form wrote it.
 */
export function useRoutineDraft({
  initial,
  mode,
  canEdit,
  save,
  onSaved,
  onPendingChange,
}: {
  initial: RoutineDefinition;
  mode: 'create' | 'edit';
  canEdit: boolean;
  save: (definition: RoutineDefinition, requestId: string) => Promise<unknown>;
  onSaved: (result: unknown) => void;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}) {
  const [form, setForm] = useState(initial);
  const [eventsDraft, setEventsDraft] = useState(
    (initial.webhook?.events ?? []).join(', '),
  );
  const [error, setError] = useState<string | null>(null);
  // Which refusal `error` words, so a form can say it its own way; null when it wasn't the host's.
  const [errorCode, setErrorCode] = useState<RoutineErrorCode | null>(null);
  const [invalidField, setInvalidField] = useState<string | undefined>();
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
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
  const disabled = busy || uncertain || addressBusy || !canEdit;
  useEffect(() => {
    onPendingChange?.(busy || uncertain || addressBusy);
  }, [busy, uncertain, addressBusy, onPendingChange]);
  function clearErrors() {
    setError(null);
    setInvalidField(undefined);
  }
  function update<K extends keyof RoutineDefinition>(
    key: K,
    value: RoutineDefinition[K],
  ) {
    if (key === 'schedule' && value !== null) scheduleDraft.current = value as RoutineSchedule;
    if (key === 'webhook' && value !== null) webhookDraft.current = value as WebhookTrigger;
    if (key === 'activeHours') hoursDraft.current = value as RoutineDefinition['activeHours'];
    setForm((f) => ({ ...f, [key]: value }));
    clearErrors();
  }
  function editEvents(value: string) {
    setEventsDraft(value);
    clearErrors();
  }
  function toggleSchedule(on: boolean) {
    if (!on) {
      if (form.schedule !== null) scheduleDraft.current = form.schedule;
      hoursDraft.current = form.activeHours;
    }
    setForm(f => ({ ...f, schedule: on ? scheduleDraft.current : null, activeHours: on ? hoursDraft.current : null }));
    clearErrors();
  }
  function toggleWebhook(on: boolean) {
    if (!on && form.webhook !== null) webhookDraft.current = form.webhook;
    update('webhook', on ? webhookDraft.current : null);
  }
  /** A task keeps a schedule and a fresh conversation; Repeat has no response timing or going-well line. */
  function changeKind(value: RoutineDefinition['kind']) {
    if (value === 'repeat') {
      const { respondWithin: _respondWithin, ...webhook } = webhookDraft.current;
      webhookDraft.current = webhook;
    }
    setForm(f => ({ ...f, kind: value, goodWhen: value === 'repeat' ? null : (f.goodWhen ?? ''),
      schedule: value === 'repeat' ? f.schedule : (f.schedule ?? { kind: 'interval', every: '1h' }),
      webhook: value === 'repeat' && f.webhook !== null ? webhookDraft.current : f.webhook,
      conversation: value === 'repeat' ? f.conversation : 'per-fire' }));
    clearErrors();
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
      setErrorCode(safe ? e.code : null);
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
  return {
    form,
    eventsDraft,
    draftDefinition,
    validation,
    dirty,
    disabled,
    error,
    errorCode,
    invalidField,
    conflict,
    busy,
    uncertain,
    addressBusy,
    setAddressBusy,
    update,
    editEvents,
    toggleSchedule,
    toggleWebhook,
    changeKind,
    submit,
  };
}
