/**
 * `isConfirmedRefusal` (TASK-949): the one rule for whether a failed write was
 * answered, shared by the reply box and the task page's steps. A request id is
 * dropped after an answered refusal and kept for a retry after anything else,
 * so a wrong answer here either replays a refused change or applies one twice.
 */
import { describe, expect, it } from 'vitest';
import { HttpError, isConfirmedRefusal } from '../http';

describe('isConfirmedRefusal', () => {
  it.each([400, 401, 403, 404, 422, 499])('a %s is an answered refusal', (status) => {
    expect(isConfirmedRefusal(new HttpError('/x', status))).toBe(true);
  });

  it.each([0, 408, 429, 500, 502, 503])(
    'a %s leaves it unknown whether the change happened',
    (status) => {
      expect(isConfirmedRefusal(new HttpError('/x', status))).toBe(false);
    },
  );

  it.each<[string, unknown]>([
    ['a network failure', new TypeError('Failed to fetch')],
    ['a plain error', new Error('boom')],
    ['a thrown string', 'boom'],
    ['nothing', undefined],
  ])('%s is not an answer', (_label, e) => {
    expect(isConfirmedRefusal(e)).toBe(false);
  });
});
