import { describe, expect, it } from 'vitest';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type Plugin,
} from '@ax/core';
import {
  createValidatorServicePlugin,
  validateServices,
  type ServicesValidateOutput,
} from '../plugin.js';

const PINNED = 'docker.io/library/postgres@sha256:' + 'a'.repeat(64);

function wellFormed(): Record<string, unknown> {
  return {
    name: 'postgres',
    image: PINNED,
    ports: [5432],
    env: { POSTGRES_PASSWORD: 'x' },
    healthcheck: { kind: 'tcp', port: 5432 },
    writablePaths: ['/var/lib/postgresql/data'],
  };
}

async function bootstrapEnv(): Promise<{ bus: HookBus; ctx: AgentContext }> {
  const bus = new HookBus();
  const plugins: Plugin[] = [createValidatorServicePlugin()];
  await bootstrap({ bus, plugins, config: {} });
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
  return { bus, ctx };
}

describe('createValidatorServicePlugin — manifest', () => {
  it('registers services:validate, calls nothing', () => {
    const p = createValidatorServicePlugin();
    expect(p.manifest.name).toBe('@ax/validator-service');
    expect(p.manifest.registers).toEqual(['services:validate']);
    expect(p.manifest.calls).toEqual([]);
    expect(p.manifest.subscribes).toEqual([]);
  });
});

describe('validateServices (pure)', () => {
  it('accepts a clean descriptor', () => {
    expect(validateServices([wellFormed()])).toEqual({ verdict: 'clean' });
  });

  it('accepts an empty list', () => {
    expect(validateServices([])).toEqual({ verdict: 'clean' });
  });

  it('rejects a non-pinned (floating-tag) image (I8)', () => {
    const r = validateServices([{ ...wellFormed(), image: 'postgres:16' }]);
    expect(r.verdict).toBe('invalid');
    if (r.verdict === 'invalid') expect(r.reason).toMatch(/digest-pinned/);
  });

  it('rejects a descriptor whose writablePaths are not absolute', () => {
    const r = validateServices([{ ...wellFormed(), writablePaths: ['var/lib/data'] }]);
    expect(r.verdict).toBe('invalid');
    if (r.verdict === 'invalid') expect(r.reason).toMatch(/absolute/);
  });

  it('rejects smuggled backend vocabulary with a NAMED reason (I2)', () => {
    const r = validateServices([{ ...wellFormed(), securityContext: { privileged: true } }]);
    expect(r.verdict).toBe('invalid');
    if (r.verdict === 'invalid') {
      expect(r.reason).toMatch(/forbidden backend vocabulary/);
      expect(r.reason).toMatch(/securityContext/);
    }
  });

  it('catches forbidden vocab nested deep (beyond the schema strict() top level)', () => {
    // A forbidden key buried inside an otherwise-shaped object. `.strict()` on
    // the descriptor root would miss a key one level down; the deep scan catches it.
    const r = validateServices([
      { ...wellFormed(), healthcheck: { kind: 'tcp', port: 5432, restartPolicy: 'Always' } },
    ]);
    expect(r.verdict).toBe('invalid');
    if (r.verdict === 'invalid') expect(r.reason).toMatch(/restartPolicy/);
  });

  it('does NOT flag a legitimate env var whose NAME collides with forbidden vocab', () => {
    // `env` keys are user-defined env-var names, not descriptor structure. An env
    // var literally named `container` must pass — it cannot influence scheduling.
    const r = validateServices([{ ...wellFormed(), env: { container: 'app', pod: 'web' } }]);
    expect(r).toEqual({ verdict: 'clean' });
  });

  it('rejects an over-cap env (>32 entries)', () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 33; i++) env[`K${i}`] = 'v';
    const r = validateServices([{ ...wellFormed(), env }]);
    expect(r.verdict).toBe('invalid');
    if (r.verdict === 'invalid') expect(r.reason).toMatch(/at most 32/);
  });

  it('rejects more than 8 services (carrier cap)', () => {
    const services = Array.from({ length: 9 }, (_, i) => ({ ...wellFormed(), name: `svc-${i}` }));
    const r = validateServices(services);
    expect(r.verdict).toBe('invalid');
    if (r.verdict === 'invalid') expect(r.reason).toMatch(/at most 8/);
  });

  it('reports the index of the offending service', () => {
    const r = validateServices([wellFormed(), { ...wellFormed(), image: 'bad:tag' }]);
    expect(r.verdict).toBe('invalid');
    if (r.verdict === 'invalid') expect(r.reason).toMatch(/services\[1\]/);
  });

  it('rejects a non-array input', () => {
    const r = validateServices('nope' as unknown as unknown[]);
    expect(r.verdict).toBe('invalid');
  });
});

describe('services:validate service hook', () => {
  it('returns clean for a well-formed descriptor list', async () => {
    const { bus, ctx } = await bootstrapEnv();
    const out = await bus.call<{ services: unknown[] }, ServicesValidateOutput>(
      'services:validate',
      ctx,
      { services: [wellFormed()] },
    );
    expect(out).toEqual({ verdict: 'clean' });
  });

  it('returns invalid for a non-pinned image', async () => {
    const { bus, ctx } = await bootstrapEnv();
    const out = await bus.call<{ services: unknown[] }, ServicesValidateOutput>(
      'services:validate',
      ctx,
      { services: [{ ...wellFormed(), image: 'redis:7' }] },
    );
    expect(out.verdict).toBe('invalid');
  });
});
