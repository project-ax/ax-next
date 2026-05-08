import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { writeFile, chmod } from 'node:fs/promises';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32;
// Fixed salt — the bootstrap token has 32 bytes of entropy, well past brute-
// force scope. A per-token salt would be safer for low-entropy passwords;
// for a 32-byte random token, a fixed salt is the simplest correct answer
// that still uses an off-the-shelf KDF.
const SCRYPT_SALT = Buffer.from('ax-bootstrap-token-v1', 'utf8');

export function generateToken(): string {
  return `ax_bs_${randomBytes(32).toString('base64url')}`;
}

export async function hashToken(token: string): Promise<string> {
  const dk = scryptSync(token, SCRYPT_SALT, SCRYPT_DKLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return dk.toString('base64url');
}

export async function verifyToken(input: string, expectedHash: string): Promise<boolean> {
  const inputHash = await hashToken(input);
  const a = Buffer.from(inputHash, 'base64url');
  const b = Buffer.from(expectedHash, 'base64url');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function writeTokenFile(path: string, token: string): Promise<void> {
  await writeFile(path, token, { encoding: 'utf8', mode: 0o600 });
  // Belt-and-braces: writeFile's `mode` is xor'd with umask on POSIX, so we
  // explicitly chmod to defend against `umask 0` etc. Idempotent.
  await chmod(path, 0o600);
}

export function printTokenToStdout(
  token: string,
  baseUrl: string,
  out: (line: string) => void = (s) => process.stdout.write(s + '\n'),
): void {
  out('[ax-onboarding] First-run bootstrap:');
  out(`  token: ${token}`);
  out(`  open:  ${baseUrl}/setup?token=${token}`);
}
