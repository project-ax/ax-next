// ---------------------------------------------------------------------------
// Runner-side proxy CA delivery from env (TASK-149).
//
// Production gVisor (GKE Sandbox) bans `hostPath`, so the credential-proxy's
// MITM CA cert can't be mounted into the runner pod from a shared dir. In TCP
// mode the host instead delivers the CA as the `AX_PROXY_CA_PEM` env var, and
// the runner writes it to a tmpfs path at boot — BEFORE the SDK spawns — so
// the SDK's undici fetch (and git/Deno/python via the same path) trust the
// proxy's leaf certs.
//
// The CA cert is a PUBLIC key — safe inside the sandbox (I1). The CA PRIVATE
// key never leaves the host-side credential-proxy plugin.
//
// hostPath mode wins when present: if the target cert file already exists
// (the mounted `/var/run/ax/proxy-ca/ca.crt`), this is a no-op — we never
// overwrite a mounted cert. So the same boot path is correct for both
// transports; only the TCP path actually writes.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type WriteProxyCaOutcome =
  | 'written'
  | 'skipped-exists'
  | 'skipped-no-pem'
  | 'skipped-no-path';

/**
 * Write the proxy MITM CA PEM (from `AX_PROXY_CA_PEM`) to the cert path the
 * pod-spec stamped (`NODE_EXTRA_CA_CERTS`, falling back to `SSL_CERT_FILE`),
 * unless the file already exists (hostPath mode) or the env isn't set.
 *
 * Idempotent + fail-safe: returns an outcome string for the caller to log;
 * throws only on a genuine write failure (the caller treats that as
 * bootstrap-fatal, mirroring the subprocess CA-write).
 */
export async function writeProxyCaFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WriteProxyCaOutcome> {
  const pem = env.AX_PROXY_CA_PEM;
  if (typeof pem !== 'string' || pem.length === 0) {
    return 'skipped-no-pem';
  }
  // The same path pod-spec stamped on all four cert env vars. Prefer
  // NODE_EXTRA_CA_CERTS (the Node/SDK var); SSL_CERT_FILE is the identical
  // path in TCP mode, used only as a fallback if a future refactor drops the
  // Node var.
  const caPath = env.NODE_EXTRA_CA_CERTS ?? env.SSL_CERT_FILE;
  if (typeof caPath !== 'string' || caPath.length === 0) {
    return 'skipped-no-path';
  }

  // hostPath mode wins: a mounted cert already lives at this path. Never
  // overwrite it — the host owns the mounted copy.
  try {
    await fs.access(caPath);
    return 'skipped-exists';
  } catch {
    // ENOENT (or any access error) → fall through and write it.
  }

  await fs.mkdir(path.dirname(caPath), { recursive: true });
  // 0600: the cert is public, but it's still a per-session file in a tmpfs
  // HOME the runner owns; owner-only keeps the file shape consistent with the
  // subprocess backend's CA-write (open-session.ts).
  await fs.writeFile(caPath, pem, { mode: 0o600 });
  return 'written';
}
