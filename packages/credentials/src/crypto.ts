import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PluginError } from '@ax/core';

const PLUGIN_NAME = '@ax/credentials';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export function encryptWithKey(key: Buffer, plaintext: string): Uint8Array {
  if (key.length !== KEY_LEN) {
    throw new PluginError({
      code: 'invalid-key',
      plugin: PLUGIN_NAME,
      message: `encryption key must be ${KEY_LEN} bytes`,
    });
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([iv, ct, tag]));
}

export function decryptWithKey(key: Buffer, blob: Uint8Array): string {
  if (key.length !== KEY_LEN) {
    throw new PluginError({
      code: 'invalid-key',
      plugin: PLUGIN_NAME,
      message: `decryption key must be ${KEY_LEN} bytes`,
    });
  }
  if (blob.length < IV_LEN + TAG_LEN) {
    throw new PluginError({
      code: 'invalid-ciphertext',
      plugin: PLUGIN_NAME,
      message: 'ciphertext too short',
    });
  }
  const buf = Buffer.from(blob);
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (_err) {
    throw new PluginError({
      code: 'decrypt-failed',
      plugin: PLUGIN_NAME,
      message: 'authentication tag mismatch',
    });
  }
}

export function parseKeyFromEnv(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === KEY_LEN) return b64;
  throw new PluginError({
    code: 'invalid-key',
    plugin: PLUGIN_NAME,
    message: `AX_CREDENTIALS_KEY must be a 32-byte key (64 hex chars or 44 base64 chars)`,
  });
}
