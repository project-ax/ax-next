// ---------------------------------------------------------------------------
// Cross-runner resume must DEMOTE TO FRESH, not crash the runner.
//
// The documented non-parity (design §8, agent-aisdk-runner/README.md) is:
// "switch an agent's runner mid-conversation and the next turn starts a new
// session instead of inheriting the old transcript." That held in one direction
// only. Going aisdk → claude-sdk, the host store handed this runner the aisdk
// runner's transcript, `writeJsonl` adopted it unconditionally, and the SDK died
// on `query({ resume })` with "No conversation found with session ID" → exit 1.
// Every subsequent turn on that conversation crashed identically, so it was
// permanently stuck — the opposite of "demotes to fresh".
//
// The seam already had the answer: `TranscriptSource.write` may return
// 'unusable', which `restoreTranscriptForResume` turns into "no resumable
// transcript" and the F2a guard turns into a fresh start. The aisdk runner's
// source used it; this one never did.
//
// The byte samples below are REAL first lines pulled out of
// `conversations_v1_transcripts` on the kind cluster during the §8 walk — not
// invented shapes — because the whole check turns on telling the two apart.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createJsonlTranscriptSource,
  isForeignRunnerTranscript,
} from '../jsonl-transcript-source.js';

/** Real aisdk-written transcript head (kind cluster, 2026-08-20). */
const AISDK_TRANSCRIPT = Buffer.from(
  '{"v":1,"runner":"aisdk"}\n' +
    '{"role":"user","uuid":"d438c25c-3791-4ecc-b066-dcee4727e10d","message":' +
    '{"role":"user","content":"Run exactly this: npx --yes cowsay@latest \\"QA7788\\""}}\n',
  'utf8',
);

/** Real claude-sdk-written transcript head (same cluster, same afternoon). */
const SDK_TRANSCRIPT = Buffer.from(
  '{"type":"queue-operation","operation":"enqueue",' +
    '"timestamp":"2026-08-20T14:14:19.012Z",' +
    '"sessionId":"b2b059b8-e3a0-4c5c-ac40-f6b76e31f63d",' +
    '"content":"Run this bash command exactly and report the result"}\n' +
    '{"type":"queue-operation","operation":"dequeue",' +
    '"timestamp":"2026-08-20T14:14:19.020Z",' +
    '"sessionId":"b2b059b8-e3a0-4c5c-ac40-f6b76e31f63d"}\n',
  'utf8',
);

describe('isForeignRunnerTranscript', () => {
  it('recognises another runner’s transcript by its header line', () => {
    expect(isForeignRunnerTranscript(AISDK_TRANSCRIPT)).toBe(true);
  });

  it('accepts a genuine SDK jsonl', () => {
    expect(isForeignRunnerTranscript(SDK_TRANSCRIPT)).toBe(false);
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['blank first line', Buffer.from('\n{"type":"x"}\n', 'utf8')],
    ['not JSON at all', Buffer.from('not json\n', 'utf8')],
    ['a JSON array', Buffer.from('[1,2,3]\n', 'utf8')],
    ['a bare JSON string', Buffer.from('"hello"\n', 'utf8')],
    // The rule is "positively identifiable as foreign", so a non-string
    // `runner` is NOT the header we mean and must not trip the guard.
    ['a non-string runner field', Buffer.from('{"runner":7}\n', 'utf8')],
  ])('does not falsely reject %s', (_label, bytes) => {
    expect(isForeignRunnerTranscript(bytes as Buffer)).toBe(false);
  });

  it('reads only the header, not the whole transcript', () => {
    // A foreign header followed by megabytes of body still resolves off the
    // first line — and a LATE `runner` key must not be mistaken for a header.
    const lateRunnerKey = Buffer.concat([
      SDK_TRANSCRIPT,
      Buffer.from('{"runner":"aisdk"}\n'.repeat(1000), 'utf8'),
    ]);
    expect(isForeignRunnerTranscript(lateRunnerKey)).toBe(false);
  });
});

describe('createJsonlTranscriptSource().write', () => {
  it('refuses a foreign transcript and leaves NO jsonl behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ax-csdk-xrunner-'));
    try {
      const source = createJsonlTranscriptSource(root);
      const outcome = await source.write('sess-from-aisdk', AISDK_TRANSCRIPT);
      expect(outcome).toBe('unusable');
      // Nothing may be left at the path the SDK reads — otherwise a later boot
      // could still find the foreign file and crash on it.
      await expect(readdir(join(root, '.claude', 'projects'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still adopts a genuine SDK transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ax-csdk-xrunner-'));
    try {
      const source = createJsonlTranscriptSource(root);
      const outcome = await source.write('sess-native', SDK_TRANSCRIPT);
      expect(outcome).toBe('accepted');
      // And it lands where `read` finds it again — the resume path end to end.
      const back = await source.read('sess-native');
      expect(back).not.toBeNull();
      expect(back?.equals(SDK_TRANSCRIPT)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
