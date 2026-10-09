import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutineUpsertDefaultInputSchema } from '@ax/routines-contract';
import {
  upsertDefaultRoutine,
  updateDefaultRoutine,
} from '../lib/default-routines';
const definition = RoutineUpsertDefaultInputSchema.parse({
  name: 'Heartbeat',
  promptBody: 'Run',
  trigger: { kind: 'interval', every: '1h' },
});
afterEach(() => vi.restoreAllMocks());
describe('structured default catalog client', () => {
  it('sends editable canonical interval fields and preserves omitted enabled', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ defaultRoutineId: 'd', created: false }),
            { status: 200 },
          ),
      );
    await upsertDefaultRoutine(definition);
    await updateDefaultRoutine('d', definition);
    for (const call of fetch.mock.calls) {
      expect(JSON.parse(String(call[1]?.body))).toEqual(definition);
      expect(String(call[1]?.body)).not.toContain('sourceMd');
      expect(JSON.parse(String(call[1]?.body))).not.toHaveProperty('enabled');
    }
    expect(fetch.mock.calls[1]?.[0]).toBe('/admin/routines/defaults/d');
  });
  it('redacts arbitrary catalog failure text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'validation',
          field: 'trigger',
          error: 'SECRET',
        }),
        { status: 400 },
      ),
    );
    await expect(upsertDefaultRoutine(definition)).rejects.toMatchObject({
      code: 'validation',
      field: 'trigger',
      status: 400,
    });
  });
});
