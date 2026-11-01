#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Two-tier canary runner stub.
//
// The sandbox hands the runner TWO filesystem roots, each with a different
// durability contract (design §4):
//
//   AX_USERFILES_ROOT  (k8s /files)  — the agent's home: durable NFS/localDir,
//                                      LIVE across sessions.
//   AX_EPHEMERAL_ROOT  (k8s /tmp)    — session scratch (uploads, transcripts,
//                                      caches); discarded with the session.
//
// On boot this stub, for each root, reads back any `marker.txt` a PRIOR session
// left and then appends its own session id. It emits one JSON line so the test
// can assert each tier's durability contract directly, rather than trusting the
// prose in the system prompt that promises it to the model.
// ---------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

async function probe(root) {
  if (!root) return { root: null, before: null };
  const marker = path.join(root, 'marker.txt');
  let before = null;
  try {
    before = await fs.readFile(marker, 'utf-8');
  } catch {
    before = null; // nothing survived into this session
  }
  await fs.mkdir(root, { recursive: true });
  await fs.appendFile(marker, `${process.env.AX_SESSION_ID ?? '?'}\n`);
  return { root, before };
}

async function run() {
  process.stdout.write(
    JSON.stringify({
      userFiles: await probe(process.env.AX_USERFILES_ROOT ?? null),
      scratch: await probe(process.env.AX_EPHEMERAL_ROOT ?? null),
    }) + '\n',
  );
}

run().catch((err) => {
  process.stdout.write(JSON.stringify({ error: String(err) }) + '\n');
});

// Hold open until the test kills us (mirrors userfiles-stub / echo-stub).
setInterval(() => {}, 1_000);
