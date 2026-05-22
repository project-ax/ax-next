import { describe, it, expect } from 'vitest';
import { resolveConfig } from '../config.js';

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
});
