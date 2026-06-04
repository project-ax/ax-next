import { describe, it, expect } from 'vitest';
import { computeReadinessBudgetMs, resolveConfig } from '../config.js';

describe('sandbox-k8s config defaults', () => {
  it('defaults activeDeadlineSeconds to 6 hours (21600s) — keepalive ceiling', () => {
    const cfg = resolveConfig({ image: 'ax-runner:test', hostIpcUrl: 'http://host:8080' });
    expect(cfg.activeDeadlineSeconds).toBe(21600);
  });

  it('still honors an explicit activeDeadlineSeconds override', () => {
    const cfg = resolveConfig({
      image: 'ax-runner:test',
      hostIpcUrl: 'http://host:8080',
      activeDeadlineSeconds: 120,
    });
    expect(cfg.activeDeadlineSeconds).toBe(120);
  });

  // TASK-151 — per-service resourcing defaults (a sidecar JVM broker needs a
  // higher memory floor than the runner's 256Mi request).
  it('defaults per-service resourcing (cpu/mem limit + request) and cold-start allowance', () => {
    const cfg = resolveConfig({ hostIpcUrl: 'http://host:8080' });
    expect(cfg.serviceCpuLimit).toBe('1');
    expect(cfg.serviceMemoryLimit).toBe('1Gi');
    expect(cfg.serviceCpuRequest).toBe('100m');
    expect(cfg.serviceMemoryRequest).toBe('512Mi');
    expect(cfg.perServiceColdStartMs).toBe(120_000);
  });

  it('honors per-service resourcing + cold-start overrides', () => {
    const cfg = resolveConfig({
      hostIpcUrl: 'http://host:8080',
      serviceCpuLimit: '2',
      serviceMemoryLimit: '2Gi',
      serviceCpuRequest: '250m',
      serviceMemoryRequest: '768Mi',
      perServiceColdStartMs: 90_000,
    });
    expect(cfg.serviceCpuLimit).toBe('2');
    expect(cfg.serviceMemoryLimit).toBe('2Gi');
    expect(cfg.serviceCpuRequest).toBe('250m');
    expect(cfg.serviceMemoryRequest).toBe('768Mi');
    expect(cfg.perServiceColdStartMs).toBe(90_000);
  });
});

describe('computeReadinessBudgetMs (TASK-151 readiness-budget policy)', () => {
  const base = 60_000;
  const perService = 120_000;

  it('returns the base budget unchanged for a service-less session', () => {
    expect(
      computeReadinessBudgetMs({
        baseTimeoutMs: base,
        serviceCount: 0,
        perServiceColdStartMs: perService,
      }),
    ).toBe(60_000);
  });

  it('scales the budget with service count (base + N * coldStart)', () => {
    expect(
      computeReadinessBudgetMs({
        baseTimeoutMs: base,
        serviceCount: 1,
        perServiceColdStartMs: perService,
      }),
    ).toBe(180_000);
    expect(
      computeReadinessBudgetMs({
        baseTimeoutMs: base,
        serviceCount: 2,
        perServiceColdStartMs: perService,
      }),
    ).toBe(300_000);
  });

  it('guards a negative service count down to the base budget', () => {
    expect(
      computeReadinessBudgetMs({
        baseTimeoutMs: base,
        serviceCount: -3,
        perServiceColdStartMs: perService,
      }),
    ).toBe(60_000);
  });
});

describe('sandbox-k8s proxy transport config (TASK-149)', () => {
  const base = { hostIpcUrl: 'http://host:8080' };

  it('defaults both proxy knobs to empty (no proxy mount/env wired)', () => {
    const cfg = resolveConfig({ ...base });
    expect(cfg.proxySocketHostPath).toBe('');
    expect(cfg.proxyEndpoint).toBe('');
  });

  it('accepts proxySocketHostPath alone (legacy hostPath posture)', () => {
    const cfg = resolveConfig({ ...base, proxySocketHostPath: '/var/lib/ax-next-proxy' });
    expect(cfg.proxySocketHostPath).toBe('/var/lib/ax-next-proxy');
    expect(cfg.proxyEndpoint).toBe('');
  });

  it('accepts proxyEndpoint alone (TCP Service posture)', () => {
    const cfg = resolveConfig({
      ...base,
      proxyEndpoint: 'http://ax-next-proxy.ax-next.svc.cluster.local:8888',
    });
    expect(cfg.proxyEndpoint).toBe('http://ax-next-proxy.ax-next.svc.cluster.local:8888');
    expect(cfg.proxySocketHostPath).toBe('');
  });

  it('rejects BOTH proxyEndpoint and proxySocketHostPath set (mutually exclusive)', () => {
    expect(() =>
      resolveConfig({
        ...base,
        proxySocketHostPath: '/var/lib/ax-next-proxy',
        proxyEndpoint: 'http://proxy:8888',
      }),
    ).toThrow(/exactly one|mutually exclusive/i);
  });
});
