import { createTestHarness } from '@ax/test-harness';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../evaluate.js';
import { createToolPolicyPlugin } from '../plugin.js';
import { BUILTIN_RULES } from '../rules.js';
import type { PolicyRule } from '../types.js';

const rule: PolicyRule = {
  id: 'routines.create', match: { tool: 'routine_create' }, verdict: 'hold',
  capability: 'create routines', subject: 'agent', providedBy: 'host',
  routineConsent: 'create-update',
};

describe('routine consent policy', () => {
  it('relaxes only a matched opted-in create/update hold and preserves disclosures', () => {
    const call = { name: 'routine_create', input: {} };
    expect(evaluate([rule], call).verdict).toBe('hold');
    expect(evaluate([rule], call, { routineConsentAllowed: true })).toEqual({
      verdict: 'allow', ruleId: rule.id, capability: rule.capability, irreversible: false, effect: [],
    });
    expect(evaluate([{ ...rule, verdict: 'deny' }], call, { routineConsentAllowed: true }).verdict).toBe('deny');
    const { routineConsent: _consent, ...unopted } = rule;
    expect(evaluate([unopted], call, { routineConsentAllowed: true }).verdict).toBe('hold');
    for (const name of ['routine_delete', 'routine_fire_now', 'other']) {
      expect(evaluate([{ ...rule, match: { tool: name } }], { name, input: {} }, { routineConsentAllowed: true }).verdict).toBe('hold');
    }
    expect(evaluate([{ ...rule, match: { tool: 'routine_create', when: { field: 'enabled', equals: true } } }, unopted], call, { routineConsentAllowed: true }).verdict).toBe('hold');
  });

  it('declares exact host rules with create/update approval, delete once and irreversible fire once', () => {
    const selected = BUILTIN_RULES.filter(r => r.match.tool.startsWith('routine_'));
    expect(selected.map(r => r.match.tool).sort()).toEqual(['routine_create', 'routine_delete', 'routine_fire_now', 'routine_get', 'routine_list', 'routine_report', 'routine_update']);
    for (const r of selected) {
      expect(r.providedBy).toBe('host');
      expect(r.verdict).toBe(['routine_list', 'routine_get', 'routine_report'].includes(r.match.tool) ? 'allow' : 'hold');
      expect(r.routineConsent).toBe(['routine_create', 'routine_update'].includes(r.match.tool) ? 'create-update' : undefined);
      expect(r.irreversible === true).toBe(r.match.tool === 'routine_fire_now');
      expect(r.effect).toEqual(r.match.tool === 'routine_fire_now' ? ['spends', 'outward'] : undefined);
    }
  });

  it('holds without a database and rejects consent services explicitly', async () => {
    const h = await createTestHarness({ plugins: [createToolPolicyPlugin()] });
    try {
      const ctx = h.ctx({ userId: 'alice', agentId: 'agent-1' });
      for (const name of ['routine_create', 'routine_update', 'routine_delete', 'routine_fire_now']) {
        expect(await h.bus.call('tool-policy:evaluate', ctx, { call: { name, input: {} }, agentId: 'agent-1' })).toMatchObject({ verdict: 'hold' });
      }
      for (const service of ['get', 'revoke']) {
        await expect(h.bus.call(`tool-policy:${service}-routine-consent`, ctx, { agentId: 'agent-1' })).rejects.toMatchObject({ code: 'consent-unavailable' });
      }
      ctx.state.set('decisions:routine-consent-grant', { decisionId: 'decision-1', expectedRevision: '0', agentId: ctx.agentId, userId: ctx.userId, toolName: 'routine_create' });
      await expect(h.bus.call('tool-policy:grant-routine-consent', ctx, { decisionId: 'decision-1', expectedRevision: '0' })).rejects.toMatchObject({ code: 'consent-unavailable' });
    } finally { await h.close(); }
  });
});
