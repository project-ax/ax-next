import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getOrCreateCA, generateDomainCert } from '../ca.js';

describe('getOrCreateCA', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ax-ca-'));
  });
  afterEach(() => {
    // Clean up CA key material so failures don't leak secrets between runs.
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates ca.key + ca.crt on first call', async () => {
    const ca = await getOrCreateCA(dir);
    expect(ca.key).toMatch(/-----BEGIN (RSA )?PRIVATE KEY-----/);
    expect(ca.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(existsSync(join(dir, 'ca.key'))).toBe(true);
    expect(existsSync(join(dir, 'ca.crt'))).toBe(true);
  });

  it('persists ca.key with mode 0600', async () => {
    await getOrCreateCA(dir);
    const mode = statSync(join(dir, 'ca.key')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('subsequent calls return the same persisted CA', async () => {
    const a = await getOrCreateCA(dir);
    const b = await getOrCreateCA(dir);
    expect(a.cert).toBe(b.cert);
    expect(a.key).toBe(b.key);
  });
});

describe('generateDomainCert', () => {
  it('mints a domain cert signed by the CA', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ax-ca-'));
    try {
      const ca = await getOrCreateCA(dir);
      const dc = generateDomainCert('api.anthropic.com', ca);
      expect(dc.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
      expect(dc.key).toMatch(/-----BEGIN (RSA )?PRIVATE KEY-----/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caches certs per domain — second call returns same instance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ax-ca-'));
    try {
      const ca = await getOrCreateCA(dir);
      const a = generateDomainCert('example.com', ca);
      const b = generateDomainCert('example.com', ca);
      expect(a).toBe(b); // identity — cache hit
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles literal IP addresses (subjectAltName type 7)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ax-ca-'));
    try {
      const ca = await getOrCreateCA(dir);
      expect(() => generateDomainCert('127.0.0.1', ca)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
