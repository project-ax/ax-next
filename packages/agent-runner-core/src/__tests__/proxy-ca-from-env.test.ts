import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeProxyCaFromEnv } from '../proxy-ca-from-env.js';

const PEM = '-----BEGIN CERTIFICATE-----\ntcp-ca\n-----END CERTIFICATE-----\n';

describe('writeProxyCaFromEnv (TASK-149 — TCP-mode CA delivery)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-proxy-ca-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('writes the PEM to the cert path (creating parent dirs) when AX_PROXY_CA_PEM is set and the file is absent', async () => {
    const caPath = path.join(tmp, 'proxy-ca', 'ca.crt');
    const result = await writeProxyCaFromEnv({
      AX_PROXY_CA_PEM: PEM,
      NODE_EXTRA_CA_CERTS: caPath,
    });
    expect(result).toBe('written');
    expect(await fs.readFile(caPath, 'utf8')).toBe(PEM);
  });

  it('writes the cert file with owner-only (0600) permissions', async () => {
    const caPath = path.join(tmp, 'proxy-ca', 'ca.crt');
    await writeProxyCaFromEnv({ AX_PROXY_CA_PEM: PEM, NODE_EXTRA_CA_CERTS: caPath });
    const mode = (await fs.stat(caPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('no-ops when the CA file already exists (hostPath mode wins)', async () => {
    const caPath = path.join(tmp, 'ca.crt');
    const existing = '-----BEGIN CERTIFICATE-----\nMOUNTED\n-----END CERTIFICATE-----\n';
    await fs.writeFile(caPath, existing);
    const result = await writeProxyCaFromEnv({
      AX_PROXY_CA_PEM: PEM,
      NODE_EXTRA_CA_CERTS: caPath,
    });
    expect(result).toBe('skipped-exists');
    // The mounted cert must be left untouched.
    expect(await fs.readFile(caPath, 'utf8')).toBe(existing);
  });

  it('no-ops when AX_PROXY_CA_PEM is unset (hostPath / subprocess mode)', async () => {
    const caPath = path.join(tmp, 'ca.crt');
    const result = await writeProxyCaFromEnv({ NODE_EXTRA_CA_CERTS: caPath });
    expect(result).toBe('skipped-no-pem');
    await expect(fs.access(caPath)).rejects.toThrow();
  });

  it('no-ops when NODE_EXTRA_CA_CERTS is unset (no target path)', async () => {
    const result = await writeProxyCaFromEnv({ AX_PROXY_CA_PEM: PEM });
    expect(result).toBe('skipped-no-path');
  });

  it('falls back to SSL_CERT_FILE for the target path when NODE_EXTRA_CA_CERTS is unset', async () => {
    const caPath = path.join(tmp, 'ssl', 'ca.crt');
    const result = await writeProxyCaFromEnv({
      AX_PROXY_CA_PEM: PEM,
      SSL_CERT_FILE: caPath,
    });
    expect(result).toBe('written');
    expect(await fs.readFile(caPath, 'utf8')).toBe(PEM);
  });
});
