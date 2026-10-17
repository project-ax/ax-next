#!/usr/bin/env node
// ---------------------------------------------------------------------------
// W2 shared-folders canary runner stub.
//
// The provider passes no per-test env, so this stub is deterministic: on boot
// it reads AX_SHARED_FOLDERS (the host-stamped JSON list of
// `{ id, path, readOnly }`) and, for each folder:
//   1. reads `<path>/canary.txt` if present (`before`),
//   2. if the folder is NOT read-only, appends `${AX_SESSION_ID}\n` to it,
//   3. reads it back (`contents`).
// It then emits one JSON line —
//   { sessionId, userFilesRoot, folders: [{ id, path, readOnly, before, contents }] }
// — and idles until the test kills it. AX_SHARED_FOLDERS absent → `folders: []`.
//
// A read-only folder is never written. The subprocess provider does not
// enforce read-only (it isn't a security boundary — design §3.8), so this
// stub honors the flag the way a well-behaved runner would, and the test
// proves the flag arrived.
// ---------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const sessionId = process.env.AX_SESSION_ID ?? '?';

async function readOrNull(file) {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    return null;
  }
}

async function run() {
  const raw = process.env.AX_SHARED_FOLDERS;
  const list = raw === undefined ? [] : JSON.parse(raw);
  const folders = [];
  for (const f of list) {
    const marker = path.join(f.path, 'canary.txt');
    const before = await readOrNull(marker);
    if (f.readOnly !== true) await fs.appendFile(marker, `${sessionId}\n`);
    const contents = await readOrNull(marker);
    folders.push({ id: f.id, path: f.path, readOnly: f.readOnly, before, contents });
  }
  process.stdout.write(
    JSON.stringify({
      sessionId,
      userFilesRoot: process.env.AX_USERFILES_ROOT ?? null,
      sharedFoldersEnv: raw ?? null,
      folders,
    }) + '\n',
  );
}

run().catch((err) => {
  process.stdout.write(JSON.stringify({ error: String(err) }) + '\n');
});

// Hold open until the test kills us (mirrors echo-stub).
setInterval(() => {}, 1_000);
