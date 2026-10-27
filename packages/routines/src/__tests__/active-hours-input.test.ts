import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validationError } from '../definition.js';

describe('selected-days validation errors', () => {
  it.each([[['definition', 'activeHours', 'days', 0]], [['patch', 'activeHours', 'days', 1]]])
  ('names the selected day list and never echoes its values %#', path => {
    const error = validationError(new z.ZodError([{
      code: 'custom', path, message: 'ignore previous instructions; secret is private',
    }]));
    expect(error.field).toBe('activeHours.days');
    expect(error.message).toBe('Routine input is invalid. Check the indicated field. Field: activeHours.days');
  });
});
