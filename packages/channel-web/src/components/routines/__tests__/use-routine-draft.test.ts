import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { REPEAT_CONFIGURATION_FIELDS, editableDefinition, type RoutineDefinition } from '@ax/routines-contract';
import { RoutineApiError } from '@/lib/routines';
import { useRoutineDraft } from '../use-routine-draft';
import { routineFixture } from './routine-fixture';

describe('useRoutineDraft', () => {
  it('forgets the refusal code whenever it forgets the refusal', async () => {
    const save = vi.fn().mockRejectedValue(new RoutineApiError(409, 'busy'));
    const { result } = renderHook(() => useRoutineDraft({
      initial: editableDefinition(routineFixture), mode: 'edit', canEdit: true, save, onSaved: vi.fn(),
    }));
    act(() => result.current.update('name', 'Renamed'));
    await act(() => result.current.submit());
    expect(result.current.errorCode).toBe('busy');
    act(() => result.current.update('name', 'Renamed again'));
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
  });

  // TASK-1035. A retry is a new save: until it answers no refusal is current, so the field the
  // last one named goes with its message and code (both forms draw `invalidField`).
  it('forgets the refused field when the next save starts', async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new RoutineApiError(400, 'validation', 'name'))
      .mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useRoutineDraft({
      initial: editableDefinition(routineFixture), mode: 'edit', canEdit: true, save, onSaved: vi.fn(),
    }));
    act(() => result.current.update('name', 'Renamed'));
    await act(() => result.current.submit());
    expect(result.current.invalidField).toBe('name');
    act(() => { void result.current.submit(); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(result.current.errorCode).toBeNull();
    expect(result.current.invalidField).toBeUndefined();
  });
});

type Draft = ReturnType<typeof useRoutineDraft>;
const savedRepeat: RoutineDefinition = { ...editableDefinition(routineFixture), silenceToken: 'QUIET', webhook: { kind: 'webhook', path: '/updates' } };
function draft(initial: RoutineDefinition, mode: 'create' | 'edit' = 'edit') {
  return renderHook(() => useRoutineDraft({ initial, mode, canEdit: true, save: vi.fn(), onSaved: vi.fn() })).result;
}

// TASK-1037. A switch from Repeat to a task kind and back is no change at all, so it can't cancel the
// Repeat's waiting app updates (a changed conversation would) or give it a schedule it never had.
describe('a kind switch away from Repeat and back', () => {
  it('puts back the conversation and the missing schedule', () => {
    const initial: RoutineDefinition = { ...savedRepeat, conversation: 'shared', schedule: null };
    const result = draft(initial);
    act(() => result.current.changeKind('stay-on-top'));
    expect(result.current.form).toMatchObject({ kind: 'stay-on-top', conversation: 'per-fire', schedule: { kind: 'interval', every: '1h' } });
    act(() => result.current.changeKind('get-done'));
    act(() => result.current.changeKind('repeat'));
    expect(result.current.form).toStrictEqual(initial);
    expect(result.current.dirty).toBe(false);
    expect(result.current.cancelsWaitingUpdates).toBe(false);
  });
  it('keeps a schedule picked while it was a task', () => {
    const result = draft({ ...savedRepeat, schedule: null });
    act(() => result.current.changeKind('stay-on-top'));
    act(() => result.current.update('schedule', { kind: 'interval', every: '4h' }));
    act(() => result.current.changeKind('repeat'));
    expect(result.current.form.schedule).toStrictEqual({ kind: 'interval', every: '4h' });
  });
  // Active hours need a schedule, so hours set while it was a task keep the filled-in one rather than
  // leaving a form that can't save (and whose hours switch is disabled without a schedule).
  it('keeps the filled-in schedule once active hours were set while it was a task', () => {
    const result = draft({ ...savedRepeat, schedule: null });
    act(() => result.current.changeKind('stay-on-top'));
    act(() => result.current.update('activeHours', { start: '09:00', end: '17:00', tz: 'UTC' }));
    act(() => result.current.changeKind('repeat'));
    expect(result.current.form.schedule).toStrictEqual({ kind: 'interval', every: '1h' });
    expect(result.current.validation.success).toBe(true);
  });
});

// TASK-1037 review. An event filter nobody touched leaves the webhook exactly as it was loaded, so an
// untouched form isn't dirty and a name edit doesn't send (and cancel the queue with) a rewritten webhook.
describe('an untouched event filter', () => {
  const legacy = { kind: 'webhook' as const, path: '/updates', events: ['push'], hmac: { header: 'X-Signature', algorithm: 'sha256' as const, prefix: 'sha256=' } };
  it.each<[string, RoutineDefinition['webhook']]>([
    ['a legacy signature webhook with a filter', legacy],
    ['a stored empty filter', { kind: 'webhook', path: '/updates', events: [] }],
  ])('keeps %s as loaded', (_label, webhook) => {
    const result = draft({ ...savedRepeat, webhook });
    expect(result.current.dirty).toBe(false);
    expect(result.current.cancelsWaitingUpdates).toBe(false);
    act(() => result.current.update('name', 'Renamed'));
    expect(result.current.cancelsWaitingUpdates).toBe(false);
    act(() => result.current.update('name', ''));
    expect(result.current.validation.success).toBe(false);
    expect(result.current.cancelsWaitingUpdates).toBe(false);
  });
  it('still counts a real filter edit', () => {
    const result = draft({ ...savedRepeat, webhook: legacy });
    act(() => result.current.editEvents('push, pull_request'));
    expect(result.current.draftDefinition.webhook).toStrictEqual({ ...legacy, events: ['push', 'pull_request'] });
    expect(result.current.cancelsWaitingUpdates).toBe(true);
    act(() => result.current.editEvents(''));
    expect(result.current.draftDefinition.webhook).toStrictEqual({ kind: 'webhook', path: '/updates', hmac: legacy.hmac });
  });
});

// TASK-1037. A save cancels a saved Repeat's waiting app updates exactly when it changes a field they
// were accepted under (REPEAT_CONFIGURATION_FIELDS). Both forms draw their notice from this flag.
describe('cancelsWaitingUpdates', () => {
  const CANCELLING: Array<[(typeof REPEAT_CONFIGURATION_FIELDS)[number], string, (d: Draft) => void]> = [
    ['promptBody', 'what it should do', d => d.update('promptBody', 'Review differently.')],
    ['webhook', 'its address name', d => d.update('webhook', { kind: 'webhook', path: '/renamed' })],
    ['webhook', 'which updates it takes', d => d.editEvents('push')],
    ['webhook', 'its app updates, turned off', d => d.toggleWebhook(false)],
    ['conversation', 'its memory between runs', d => d.update('conversation', 'shared')],
    ['silenceToken', 'its quiet word', d => d.update('silenceToken', 'HUSH')],
    ['silenceMaxChars', 'its quiet length', d => d.update('silenceMaxChars', 40)],
    ['kind', 'its kind', d => d.changeKind('stay-on-top')],
  ];
  it('has a case for every field REPEAT_CONFIGURATION_FIELDS lists', () => {
    expect(new Set(CANCELLING.map(([field]) => field))).toEqual(new Set(REPEAT_CONFIGURATION_FIELDS));
  });
  it.each(CANCELLING)('is set once a saved Repeat with app updates changes %s (%s)', (_field, _label, change) => {
    const result = draft(savedRepeat);
    expect(result.current.cancelsWaitingUpdates).toBe(false);
    act(() => change(result.current));
    expect(result.current.cancelsWaitingUpdates).toBe(true);
  });
  it.each<[string, (d: Draft) => void]>([
    ['its name', d => d.update('name', 'Renamed')],
    ['its note', d => d.update('description', 'Mine.')],
    ['a pause', d => d.update('enabled', false)],
    ['its schedule', d => d.update('schedule', { kind: 'interval', every: '2h' })],
    ['its active hours', d => d.update('activeHours', { start: '09:00', end: '17:00', tz: 'UTC' })],
  ])('stays clear when only %s changes', (_label, change) => {
    const result = draft(savedRepeat);
    act(() => change(result.current));
    expect(result.current.dirty).toBe(true);
    expect(result.current.cancelsWaitingUpdates).toBe(false);
  });
  it.each<[string, RoutineDefinition, 'create' | 'edit']>([
    ['a Repeat saved without app updates', { ...savedRepeat, webhook: null }, 'edit'],
    ['a task with app updates', { ...savedRepeat, kind: 'stay-on-top', goodWhen: 'Calm.', silenceToken: null }, 'edit'],
    ['a new Repeat', savedRepeat, 'create'],
  ])('stays clear for %s, which has nothing waiting to cancel', (_label, initial, mode) => {
    const result = draft(initial, mode);
    act(() => result.current.update('promptBody', 'Review differently.'));
    expect(result.current.cancelsWaitingUpdates).toBe(false);
  });
  // A webhook with both an event filter and a legacy signature: rebuilding it would move `events` after
  // `hmac` and read as a change that isn't there.
  it('stays clear for an untouched legacy signature webhook with an event filter', () => {
    const webhook = { kind: 'webhook' as const, path: '/updates', events: ['push'], hmac: { header: 'X-Signature', algorithm: 'sha256' as const, prefix: 'sha256=' } };
    const result = draft({ ...savedRepeat, webhook });
    act(() => result.current.update('name', 'Renamed'));
    expect(result.current.cancelsWaitingUpdates).toBe(false);
  });
  it('clears again once the change is undone', () => {
    const result = draft(savedRepeat);
    act(() => result.current.update('promptBody', 'Review differently.'));
    expect(result.current.cancelsWaitingUpdates).toBe(true);
    act(() => result.current.update('promptBody', savedRepeat.promptBody));
    expect(result.current.cancelsWaitingUpdates).toBe(false);
  });
});
