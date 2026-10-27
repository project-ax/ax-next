import { describe, expect, it } from 'vitest';
import { PluginError } from '../errors.js';
import { SafeToolError, safeToolMessage, type SafeToolCode, type SafeToolField } from '../safe-tool-error.js';

describe('safe routine tool failures', () => {
  it('names the selected active days without accepting arbitrary day values', () => {
    const error = new SafeToolError('validation', 'activeHours.days' as SafeToolField);
    expect(error.field).toBe('activeHours.days');
    expect(error.message).toBe('Routine input is invalid. Check the indicated field. Field: activeHours.days');
    expect(new SafeToolError('validation', 'activeHours.days.evil' as SafeToolField).field).toBe('input');
  });
  it('is a PluginError and carries closed actionable fields', () => {
    const error = new SafeToolError('revision-conflict', 'expectedRevision');
    expect(error).toBeInstanceOf(PluginError);
    expect(error).toMatchObject({ code: 'invalid-payload', toolCode: 'revision-conflict', field: 'expectedRevision' });
    expect(error.message).toBe('The routine changed. Read it with routine_get and submit a fresh edit. Field: expectedRevision');
  });
  it('checks runtime values, including inherited object keys', () => {
    for (const code of ['secret', 'toString', '__proto__']) {
      const error = new SafeToolError(code as SafeToolCode, 'private bearer secret' as SafeToolField);
      expect(error.toolCode).toBe('unavailable');
      expect(error.field).toBe('input');
      expect(error.message).toBe('Routine management is temporarily unavailable. Field: input');
      expect(safeToolMessage(code as SafeToolCode, 'secret' as SafeToolField)).toBe(error.message);
    }
  });
  it('does not accept non-string codes via property-key coercion', () => {
    const code = { toString: () => 'validation' } as unknown as SafeToolCode;
    const error = new SafeToolError(code, 'input');
    expect(error.toolCode).toBe('unavailable');
    expect(safeToolMessage(code, 'input')).toBe('Routine management is temporarily unavailable. Field: input');
  });
  it('recomputes a receipt-safe message after mutation', () => {
    const error = new SafeToolError('validation', 'name');
    error.message = 'private bearer secret';
    expect(safeToolMessage(error.toolCode, error.field)).toBe('Routine input is invalid. Check the indicated field. Field: name');
  });
  it('names the one place a task report works', () => {
    const error = new SafeToolError('not-in-check-in', 'input');
    expect(error.toolCode).toBe('not-in-check-in');
    expect(error.field).toBe('input');
    expect(error.message).toBe('This works only during a task check-in. Field: input');
    expect(safeToolMessage('not-in-check-in', 'input')).toBe('This works only during a task check-in. Field: input');
  });
  it('names a task report’s own fields (TASK-907)', () => {
    // TASK-952: its reading too, and the reading's own fields, since a refusal names the issue's whole path.
    for (const field of ['status', 'update', 'ask', 'notes', 'reading', 'reading.value', 'reading.label'] as const) {
      const error = new SafeToolError('validation', field);
      expect(error.field).toBe(field);
      expect(error.message).toBe(`Routine input is invalid. Check the indicated field. Field: ${field}`);
      expect(safeToolMessage('validation', field)).toBe(error.message);
    }
    // The view's name for the notes is no input field.
    expect(new SafeToolError('validation', 'agentNotes' as SafeToolField).field).toBe('input');
  });
  it('names a report’s steps (TASK-948)', () => {
    const error = new SafeToolError('validation', 'steps');
    expect(error.field).toBe('steps');
    expect(error.message).toBe('Routine input is invalid. Check the indicated field. Field: steps');
    expect(safeToolMessage('validation', 'steps')).toBe(error.message);
  });
  it('names a report’s done (TASK-950)', () => {
    const error = new SafeToolError('validation', 'done');
    expect(error.field).toBe('done');
    expect(error.message).toBe('Routine input is invalid. Check the indicated field. Field: done');
    expect(safeToolMessage('validation', 'done')).toBe(error.message);
  });
});
