// ---------------------------------------------------------------------------
// The in-memory transcript source (design §5: "No file on disk").
//
// The claude-sdk runner's transcript machinery exists to chase a file the SDK
// owns: `locateJsonl`'s readdir-walk of the SDK's private cwd-slug encoding,
// `scaffoldSdkProjectsSymlink`, and `waitForTranscriptUuid`. This runner owns
// its messages, so there is nothing to chase.
//
// THAT DELETES A RACE, NOT JUST CODE. `waitForTranscriptUuid` exists because
// the SDK flushes its jsonl asynchronously, so the turn-end commit had to poll
// for bytes to land before it could stage — the lineage behind TASK-11 / PR
// #163 and the F-1/F-2 re-sync work. Here durability is a function return:
// when `endTurn` runs, the messages are already in this array. Anyone tempted
// to add a `beforeCommit` wait to this runner should read that sentence twice.
//
// This object is BOTH the loop's message store and the shell's
// `TranscriptSource`. One array, one owner — no second copy to drift.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import type {
  TranscriptSource,
  TranscriptWriteOutcome,
} from '@ax/agent-runner-core';
import type { ModelMessage } from 'ai';
import {
  decodeTranscript,
  encodeTranscript,
  headerLine,
  roleOf,
  type TranscriptEntry,
  type TranscriptRole,
} from './transcript-codec.js';

export interface MemoryTranscriptSource extends TranscriptSource {
  /** The messages to hand the model, in order. */
  messages(): ModelMessage[];
  /** Append messages produced this turn. Returns the entries created. */
  append(messages: readonly ModelMessage[]): TranscriptEntry[];
  /** The uuid of the LAST entry with `role`, or undefined. Backs `turnId`. */
  lastUuidOfRole(role: TranscriptRole): string | undefined;
  /** How many entries are held. Test/diagnostic seam. */
  size(): number;
}

export interface CreateMemoryTranscriptSourceOptions {
  /** Test seam for deterministic uuids. */
  idGen?: () => string;
  /** Where a rejected resume is reported. Defaults to process.stderr. */
  warn?: (line: string) => void;
}

export function createMemoryTranscriptSource(
  opts: CreateMemoryTranscriptSourceOptions = {},
): MemoryTranscriptSource {
  const idGen = opts.idGen ?? ((): string => randomUUID());
  const warn =
    opts.warn ?? ((line: string): void => void process.stderr.write(line));

  const entries: TranscriptEntry[] = [];
  // The header the resumed transcript was stored with, re-emitted verbatim so
  // the shipped prefix stays byte-identical to the host's stored bytes. A
  // fresh session emits the current header.
  let headerRaw = headerLine();

  return {
    messages: () => entries.map((e) => e.message),

    append(messages) {
      const created = messages.map<TranscriptEntry>((message) => ({
        uuid: idGen(),
        role: roleOf(message),
        message,
      }));
      entries.push(...created);
      return created;
    },

    lastUuidOfRole(role) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]!.role === role) return entries[i]!.uuid;
      }
      return undefined;
    },

    size: () => entries.length,

    // --- TranscriptSource -------------------------------------------------

    async read() {
      // Nothing to ship before the first message. Returning an empty-but-
      // present buffer here would ship a bare header line as a transcript row
      // and make an empty session look resumable.
      if (entries.length === 0) return null;
      return encodeTranscript(entries, headerRaw);
    },

    async write(sessionId, bytes): Promise<TranscriptWriteOutcome> {
      const decoded = decodeTranscript(bytes);
      if (!decoded.ok) {
        // The most important case here is a transcript the OTHER runner wrote:
        // 'unusable' routes into the shell's existing F2a demote-to-fresh
        // branch, which is the whole cross-runner demotion mechanism. Log
        // loudly — a user whose history silently vanished deserves a line in
        // the runner log explaining why.
        warn(
          `runner: cannot resume transcript for session ${sessionId}: ${decoded.reason}; starting fresh\n`,
        );
        return 'unusable';
      }
      entries.length = 0;
      entries.push(...decoded.entries);
      headerRaw = decoded.headerRaw;
      return 'accepted';
    },
  };
}
