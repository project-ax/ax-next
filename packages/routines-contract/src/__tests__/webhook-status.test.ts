import { describe, expect, it } from 'vitest';
import { RoutineWebhookStatusOutputSchema } from '../services.js';
const evidence = { agentId: 'a', routineId: 'r', setupReady: true, app: null, lastAcceptedAt: null, signatureChecked: false, timestampChecked: false, verifiedAt: null, windowStart: '2031-01-01T11:01:00.000Z', refusals: [{ reason: 'signature', count: 4 }] };
const without = (field: string) => Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== field));
describe('private connection evidence contract', () => {
  it('accepts setup and receipt evidence without implying a run result', () => {
    expect(RoutineWebhookStatusOutputSchema.parse(evidence)).toEqual(evidence);
    expect(RoutineWebhookStatusOutputSchema.parse({ ...evidence, lastAcceptedAt: '2031-01-01T12:00:00.000Z', signatureChecked: true })).toMatchObject({ signatureChecked: true });
  });
  it('refuses arbitrary reasons, private request content and unbounded counts', () => {
    for (const patch of [{ body: 'outside text' }, { token: 'secret' }, { headers: {} }, { outcome: 'success' }, { refusals: [{ reason: 'outside text', count: 1 }] }, { refusals: [{ reason: 'signature', count: 0 }] }, { refusals: [{ reason: 'signature', count: Number.MAX_SAFE_INTEGER + 1 }] }]) expect(RoutineWebhookStatusOutputSchema.safeParse({ ...evidence, ...patch }).success).toBe(false);
  });
  it('names the detected app, or none yet, and whether its timestamp was checked (TASK-1026)', () => {
    for (const app of ['stripe', 'slack', 'zendesk', 'github', 'linear', 'other', null]) {
      expect(RoutineWebhookStatusOutputSchema.parse({ ...evidence, app }), String(app)).toMatchObject({ app });
    }
    expect(RoutineWebhookStatusOutputSchema.parse({ ...evidence, lastAcceptedAt: '2031-01-01T12:00:00.000Z', signatureChecked: true, timestampChecked: true, app: 'stripe' })).toMatchObject({ timestampChecked: true });
    for (const app of ['unknown', 'App', '', 'constructor']) expect(RoutineWebhookStatusOutputSchema.safeParse({ ...evidence, app }).success, app).toBe(false);
    expect(RoutineWebhookStatusOutputSchema.safeParse(without('timestampChecked')).success).toBe(false);
    expect(RoutineWebhookStatusOutputSchema.safeParse(without('app')).success).toBe(false);
    expect(RoutineWebhookStatusOutputSchema.safeParse({ ...evidence, timestampChecked: 'yes' }).success).toBe(false);
  });
});
