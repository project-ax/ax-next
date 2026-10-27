import { describe, expect, it } from 'vitest';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import * as D from '../definition.js';

const schedule = { kind: 'interval' as const, every: '1h' };
const webhook = { kind: 'webhook' as const, path: '/github', hmac: { header: 'X-Sig', algorithm: 'sha256' as const } };
const definition = () => RoutineDefinitionSchema.parse({ name: 'Review work', promptBody: 'Review the queue.', schedule, webhook });
const now = new Date('2031-01-01T00:00:00Z');

describe('independent runtime definition helpers', () => {
  it('schedules a dual repeat and keeps webhook-only work without a timer', () => {
    expect(D.nextRun(definition(), now)).toEqual(new Date('2031-01-01T01:00:00Z'));
    expect(D.nextRun({ ...definition(), schedule: null }, now)).toBeNull();
    expect(D.nextRun({ ...definition(), enabled: false }, now)).toBeNull();
  });
  it('changes a due date for the schedule but not for app-update settings', () => {
    const value = definition();
    expect(D.schedulingChanged(value, { ...value, schedule: { kind: 'interval', every: '2h' } })).toBe(true);
    expect(D.schedulingChanged(value, { ...value, webhook: { kind: 'webhook', path: '/other' } })).toBe(false);
    expect(D.schedulingChanged(value, { ...value, webhook: null })).toBe(false);
    expect(D.schedulingChanged(value, { ...value, schedule: null })).toBe(true);
  });
  it('finds the independent HMAC configuration without requiring a webhook-only trigger', () => {
    expect(D.hasHmac(definition())).toBe(true);
    expect(D.hasHmac({ ...definition(), webhook: null })).toBe(false);
  });
});

describe('compatible legacy request fingerprints', () => {
  const candidates = (name: string, input: unknown): string[] => {
    const fn = Reflect.get(D, name);
    expect(fn).toBeTypeOf('function');
    return (fn as (input: unknown) => string[])(input);
  };
  it('keeps a v14 create hash only when the canonical definition has one equivalent method', () => {
    const value = { ...definition(), webhook: null };
    const input = { agentId: 'a', requestId: 'q', definition: value };
    const { schedule: previous, webhook: _absent, ...other } = value;
    const old = D.inputHash({ agentId: 'a', definition: { ...other, trigger: previous } });
    const hashes = candidates('createRequestHashes', input);
    expect(hashes[0]).toBe(D.createRequestHash(input));
    expect(hashes).toContain(old);
    expect(candidates('createRequestHashes', { ...input, definition: definition() })).toHaveLength(1);
  });
  it('distinguishes an additive canonical update from an old exclusive replacement', () => {
    const base = { agentId: 'a', routineId: 'r', expectedRevision: 'v', requestId: 'q' };
    const old = D.inputHash({ agentId: 'a', routineId: 'r', expectedRevision: 'v', patch: { trigger: schedule } });
    expect(candidates('updateRequestHashes', { ...base, patch: { schedule } })).not.toContain(old);
    expect(candidates('updateRequestHashes', { ...base, patch: { schedule, webhook: null } })).toContain(old);
    expect(candidates('updateRequestHashes', { ...base, patch: { schedule, webhook } })).toHaveLength(1);
  });
});

describe('accepted webhook execution configuration', () => {
  it('keeps schedule and cosmetic edits independent from accepted app updates', () => {
    const row = RoutineDefinitionSchema.parse({name:'Job',promptBody:'Review',schedule:{kind:'interval',every:'60s'},webhook:{kind:'webhook',path:'/hook'}});
    const base = D.repeatConfigurationHash(row);
    expect(D.repeatConfigurationHash({...row,name:'Renamed',description:'Cosmetic',enabled:false,schedule:{kind:'interval',every:'1h'},activeHours:{start:'09:00',end:'17:00',tz:'UTC'}})).toBe(base);
    expect(D.repeatConfigurationHash({...row,activeHours:{start:'09:00',end:'17:00',tz:'UTC',days:['mon','wed']}})).toBe(base);
    for(const change of [{promptBody:'Different'},{conversation:'shared' as const},{webhook:{kind:'webhook' as const,path:'/other'}}]) expect(D.repeatConfigurationHash({...row,...change})).not.toBe(base);
  });
});
