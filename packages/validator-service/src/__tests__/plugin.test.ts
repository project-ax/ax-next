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

  it('rejects more than 16 services (carrier cap)', () => {
    const services = Array.from({ length: 17 }, (_, i) => ({ ...wellFormed(), name: `svc-${i}` }));
    const r = validateServices(services);
    expect(r.verdict).toBe('invalid');
    if (r.verdict === 'invalid') expect(r.reason).toMatch(/at most 16/);
  });

  it('a job with publishedPorts is invalid', () => {
    const r = validateServices([
      { ...wellFormed(), job: true, publishedPorts: [{ published: 6000, target: 5432 }] },
    ]);
    expect(r.verdict).toBe('invalid');
    if (r.verdict === 'invalid') expect(r.reason).toMatch(/job.*publishedPorts/);
  });

  it('a published port equal to another container port is invalid', () => {
    const r = validateServices([
      wellFormed(),
      { ...wellFormed(), name: 'proxy', ports: [8080], publishedPorts: [{ published: 5432, target: 8080 }] },
    ]);
    expect(r.verdict).toBe('invalid');
    if (r.verdict === 'invalid') {
      expect(r.reason).toContain('proxy');
      expect(r.reason).toContain('postgres');
    }
  });

  it('a published port equal to its own container port is invalid', () => {
    const r = validateServices([
      { ...wellFormed(), publishedPorts: [{ published: 5432, target: 5432 }] },
    ]);
    expect(r.verdict).toBe('invalid');
    if (r.verdict === 'invalid') {
      expect(r.reason).toContain('postgres');
      expect(r.reason).toMatch(/own container port/);
    }
  });

  it('a published target that is not one of the service\'s own ports is invalid', () => {
    const r = validateServices([{ ...wellFormed(), publishedPorts: [{ published: 6000, target: 9999 }] }]);
    expect(r.verdict).toBe('invalid');
    if (r.verdict === 'invalid') expect(r.reason).toMatch(/target 9999.*not one of the service's own ports/);
  });

  it('more than 64 published ports across services is invalid; 64 is fine', () => {
    const many = (n: number) => {
      const out: Array<Record<string, unknown>> = [];
      for (let i = 0; i < n; i += 16) {
        // Each service on its own container port: one network namespace (A1).
        const port = 5432 + i / 16;
        out.push({
          ...wellFormed(), name: `s${i / 16}`, ports: [port], healthcheck: { kind: 'tcp', port },
          publishedPorts: Array.from({ length: Math.min(16, n - i) }, (_, j) => ({ published: 10000 + i + j, target: port })),
        });
      }
      return out;
    };
    expect(validateServices(many(64)).verdict).toBe('clean');
    const r = validateServices(many(65));
    expect(r.verdict).toBe('invalid');
    if (r.verdict === 'invalid') expect(r.reason).toMatch(/at most 64 published ports/);
  });

  it('two services publishing the same port is invalid, naming both', () => {
    const r = validateServices([
      { ...wellFormed(), name: 'a', publishedPorts: [{ published: 6000, target: 5432 }] },
      { ...wellFormed(), name: 'b', ports: [9000], publishedPorts: [{ published: 6000, target: 9000 }] },
    ]);
    expect(r.verdict).toBe('invalid');
    if (r.verdict === 'invalid') {
      expect(r.reason).toContain('"a"');
      expect(r.reason).toContain('"b"');
    }
  });

  it('two services on the same container port are invalid, naming both (A1)', () => {
    const r = validateServices([
      { ...wellFormed(), name: 'a' },
      { ...wellFormed(), name: 'b' },
    ]);
    expect(r).toEqual({
      verdict: 'invalid',
      reason: 'container port 5432 is used by both "a" and "b" (all services share one network namespace)',
    });
  });

  it('the e2e-shaped fixture is clean', () => {
    const img = (c: string): string => `docker.io/example/${c}@sha256:` + c.repeat(64);
    const svc = (
      name: string,
      c: string,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({ name, image: img(c), ports: [], env: {}, ...extra });
    const fixture = [
      svc('configsvr', 'a', { ports: [27019] }),
      svc('configsvr-init', 'b', { job: true }),
      svc('shard0', 'c', { ports: [27018] }),
      svc('shard-init', 'd', { job: true }),
      svc('mongos', 'e', { ports: [27017], publishedPorts: [{ published: 47017, target: 27017 }] }),
      svc('mongo-init', 'f', { job: true }),
      svc('kafka', '1', { ports: [9094], publishedPorts: [{ published: 9294, target: 9094 }] }),
      svc('redis', '2', { ports: [6379], publishedPorts: [{ published: 6579, target: 6379 }] }),
      svc('emulator', '3', { ports: [8080] }),
    ];
    expect(validateServices(fixture)).toEqual({ verdict: 'clean' });
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
