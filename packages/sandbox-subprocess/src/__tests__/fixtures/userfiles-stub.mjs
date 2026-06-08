#!/usr/bin/env node
// ---------------------------------------------------------------------------
// filestore-user-files canary runner stub.
//
// Acts like the real runner would for the durable-mount canary: on boot it
//   1. reads AX_USERFILES_ROOT (the durable per-agent mount the subprocess
//      provider realized + stamped),
//   2. reads back any pre-existing `canary.txt` there (proving cross-session
//      persistence — a file a PRIOR session of the same agent wrote),
//   3. appends this session's id to `canary.txt`,
//   4. emits one JSON line: { userFilesRoot, before, after }.
//
// `before` is null on the first session (the mount is empty) and the prior
// session's content on the second (the localDir subtree persisted on the host
// FS across the pod/process death). Then it stays alive until the test kills it.
// ---------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const root = process.env.AX_USERFILES_ROOT ?? null;

async function run() {
  let before = null;
  let after = null;
  if (root) {
    const marker = path.join(root, 'canary.txt');
    try {
      before = await fs.readFile(marker, 'utf-8');
    } catch {
      before = null; // first session — nothing there yet
    }
    const line = `${process.env.AX_SESSION_ID ?? '?'}\n`;
    await fs.appendFile(marker, line);
    after = await fs.readFile(marker, 'utf-8');
  }
  process.stdout.write(JSON.stringify({ userFilesRoot: root, before, after }) + '\n');
}

run().catch((err) => {
  process.stdout.write(JSON.stringify({ error: String(err) }) + '\n');
});

// Hold open until the test kills us (mirrors echo-stub).
setInterval(() => {}, 1_000);
