import { describe, it, expect } from 'vitest';
import {
  ServiceDescriptorSchema,
  CapabilitiesSchema,
  SERVICES_MAX,
} from '../index.js';

// A digest-pinned image we reuse — postgres pinned to an (illustrative) sha256.
const PINNED = 'docker.io/library/postgres@sha256:' + 'a'.repeat(64);

function wellFormed() {
  return {
    name: 'postgres',
    image: PINNED,
    ports: [5432],
    env: { POSTGRES_PASSWORD: 'x' },
    healthcheck: { kind: 'tcp', port: 5432 },
    writablePaths: ['/var/lib/postgresql/data'],
  };
}

describe('ServiceDescriptorSchema', () => {
  it('accepts a well-formed descriptor', () => {
    const r = ServiceDescriptorSchema.safeParse(wellFormed());
    expect(r.success).toBe(true);
  });

  it('defaults writablePaths to [] when omitted', () => {
    const { writablePaths: _drop, ...rest } = wellFormed();
    const r = ServiceDescriptorSchema.safeParse(rest);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.writablePaths).toEqual([]);
  });

  it('accepts an exec healthcheck', () => {
    const r = ServiceDescriptorSchema.safeParse({
      ...wellFormed(),
      healthcheck: { kind: 'exec', command: ['pg_isready'] },
    });
    expect(r.success).toBe(true);
  });

  it('rejects a non-digest (floating-tag) image (I8)', () => {
    const r = ServiceDescriptorSchema.safeParse({ ...wellFormed(), image: 'postgres:16' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toMatch(/digest-pinned/);
  });

  it('rejects a short/invalid sha256 digest', () => {
    const r = ServiceDescriptorSchema.safeParse({
      ...wellFormed(),
      image: 'postgres@sha256:' + 'a'.repeat(63),
    });
    expect(r.success).toBe(false);
  });

  it('rejects a non-absolute writablePath', () => {
    const r = ServiceDescriptorSchema.safeParse({
      ...wellFormed(),
      writablePaths: ['var/lib/data'],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toMatch(/absolute/);
  });

  it('rejects an over-cap env (>32 entries)', () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 33; i++) env[`K${i}`] = 'v';
    const r = ServiceDescriptorSchema.safeParse({ ...wellFormed(), env });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toMatch(/at most 32/);
  });

  it('rejects a forbidden extra key (strict — smuggled backend vocab) (I2)', () => {
    const r = ServiceDescriptorSchema.safeParse({
      ...wellFormed(),
      securityContext: { privileged: true },
    });
    expect(r.success).toBe(false);
  });

  it('rejects an out-of-range port', () => {
    const r = ServiceDescriptorSchema.safeParse({ ...wellFormed(), ports: [70000] });
    expect(r.success).toBe(false);
  });

  it('rejects an invalid service name shape', () => {
    const r = ServiceDescriptorSchema.safeParse({ ...wellFormed(), name: 'Postgres_DB' });
    expect(r.success).toBe(false);
  });
});

describe('CapabilitiesSchema — services round-trip', () => {
  it('round-trips a Capabilities object carrying services', () => {
    const input = {
      allowedHosts: ['api.example.com'],
      credentials: [],
      mcpServers: [],
      packages: { npm: [], pypi: [] },
      services: [wellFormed()],
    };
    const r = CapabilitiesSchema.safeParse(input);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.services).toHaveLength(1);
      expect(r.data.services[0]?.name).toBe('postgres');
      expect(r.data.services[0]?.image).toBe(PINNED);
    }
  });

  it('defaults services to [] when omitted', () => {
    const r = CapabilitiesSchema.safeParse({
      allowedHosts: [],
      credentials: [],
      mcpServers: [],
      packages: { npm: [], pypi: [] },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.services).toEqual([]);
  });

  it(`rejects more than ${SERVICES_MAX} services (carrier cap)`, () => {
    const services = Array.from({ length: SERVICES_MAX + 1 }, (_, i) => ({
      ...wellFormed(),
      name: `svc-${i}`,
    }));
    const r = CapabilitiesSchema.safeParse({
      allowedHosts: [],
      credentials: [],
      mcpServers: [],
      packages: { npm: [], pypi: [] },
      services,
    });
    expect(r.success).toBe(false);
  });

  it('rejects a services entry with a non-digest image through the carrier', () => {
    const r = CapabilitiesSchema.safeParse({
      allowedHosts: [],
      credentials: [],
      mcpServers: [],
      packages: { npm: [], pypi: [] },
      services: [{ ...wellFormed(), image: 'redis:7' }],
    });
    expect(r.success).toBe(false);
  });
});
