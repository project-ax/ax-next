import * as shared from '@ax/core/turn-error-text';
import { expect, it } from 'vitest';
import * as web from '../turn-error-labels';

it('re-exports the shared table and function, not copies (TASK-1250)', () => {
  expect(web.ERROR_LABELS).toBe(shared.ERROR_LABELS);
  expect(web.turnErrorText).toBe(shared.turnErrorText);
  expect(web.DEFAULT_TURN_ERROR).toBe(shared.DEFAULT_TURN_ERROR);
  expect(web.MAX_DETAIL_CHARS).toBe(shared.MAX_DETAIL_CHARS);
});
