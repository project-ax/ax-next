import { describe, expect, it } from 'vitest';
import { PluginError } from '../errors.js';
import { SafeToolError, safeToolMessage, type SafeToolCode, type SafeToolField } from '../safe-tool-error.js';

describe('safe routine tool failures', () => {
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
});
