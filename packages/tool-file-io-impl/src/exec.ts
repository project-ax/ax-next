import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { safePath } from './safe-path.js';

// 1 MiB cap applies to both read and write. We keep it as a byte count,
// not a character count, because the LLM thinks in characters but the
// filesystem (and any network it sits behind) thinks in bytes. A Zod
// .max(N) on a string counts UTF-16 code units, NOT UTF-8 bytes — so
// '😀'.repeat(300_000) has length 600_000 but is 1_200_000 UTF-8 bytes.
// The byte cap is enforced via Buffer.byteLength(content, 'utf8').
export const MAX_FILE_BYTES = 1_048_576;
const MAX_PATH_CHARS = 4096;

export interface ReadFileInput {
  path: string;
}

export interface ReadFileResult {
  path: string; // caller-supplied (workspace-relative) path
  content: string;
  bytes: number;
}

export interface WriteFileInput {
  path: string;
  content: string;
}

export interface WriteFileResult {
  path: string;
  bytes: number;
}

export interface FileIoConfig {
  workspaceRoot: string;
}

export async function readFile(
  input: ReadFileInput,
  config: FileIoConfig,
): Promise<ReadFileResult> {
  if (
    typeof input.path !== 'string' ||
    input.path.length === 0 ||
    input.path.length > MAX_PATH_CHARS
  ) {
    throw new Error(`read_file: path must be a string (1..${MAX_PATH_CHARS} chars)`);
  }
  const resolved = await safePath(config.workspaceRoot, input.path);
  // Stat first so a 10 GB file doesn't OOM us via readFile before the cap fires.
  const stat = await fs.stat(resolved);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `read_file: file exceeds ${MAX_FILE_BYTES} bytes (size=${stat.size})`,
    );
  }
  const content = await fs.readFile(resolved, 'utf8');
  return { path: input.path, content, bytes: stat.size };
}

export async function writeFile(
  input: WriteFileInput,
  config: FileIoConfig,
): Promise<WriteFileResult> {
  if (
    typeof input.path !== 'string' ||
    input.path.length === 0 ||
    input.path.length > MAX_PATH_CHARS
  ) {
    throw new Error(`write_file: path must be a string (1..${MAX_PATH_CHARS} chars)`);
  }
  if (typeof input.content !== 'string') {
    throw new Error(`write_file: content must be a string`);
  }
  // UTF-8 byte cap (NOT UTF-16 code units — matches Week 4-6's rationale).
  const bytes = Buffer.byteLength(input.content, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(
      `write_file: content exceeds ${MAX_FILE_BYTES} bytes (got ${bytes})`,
    );
  }
  const resolved = await safePath(config.workspaceRoot, input.path);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, input.content, 'utf8');
  return { path: input.path, bytes };
}
