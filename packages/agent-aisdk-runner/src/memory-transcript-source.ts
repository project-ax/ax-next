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
  /**
   * Replace the whole message list — compaction's rung 3 (design §7), and the
   * only writer that shortens this array.
   *
   * ENTRY IDENTITY SURVIVES WHERE THE MESSAGE DOES. A message that is the same
   * OBJECT as one already held keeps its existing uuid; only genuinely new
   * messages (the synthetic summary) mint one. That is not cosmetic: the uuid
   * is what `lastUuidOfRole` reports as the host's `turnId`, so re-minting
   * uuids for messages that did not change would orphan the turn ids the
   * display log and `conversations:drop-turn` already refer to. Rung 3 passes
   * preserved messages through by reference precisely so this holds.
   *
   * The caller is responsible for persisting the rewrite
   * (`LoopContext.replaceTranscript`). This function only changes what is in
   * memory — if it were left there, the host's stored transcript would still
   * carry the long version and the next resume would undo the compaction.
   */
  replace(messages: readonly ModelMessage[]): void;
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

  /** Shared by the public `append` and by `seedFromHistory`. */
  function append(messages: readonly ModelMessage[]): TranscriptEntry[] {
    const created = messages.map<TranscriptEntry>((message) => ({
      uuid: idGen(),
      role: roleOf(message),
      message,
    }));
    entries.push(...created);
    return created;
  }
  // The header the resumed transcript was stored with, re-emitted verbatim so
  // the shipped prefix stays byte-identical to the host's stored bytes. A
  // fresh session emits the current header.
  let headerRaw = headerLine();

  return {
    messages: () => entries.map((e) => e.message),

    append,

    replace(messages) {
      // Keyed by the message OBJECT, so identity is what carries a uuid across
      // the rewrite. A structural comparison would be both slower and wrong:
      // two turns that say the same thing are two turns.
      const existing = new Map<ModelMessage, TranscriptEntry>();
      for (const entry of entries) existing.set(entry.message, entry);

      const next = messages.map<TranscriptEntry>(
        (message) =>
          existing.get(message) ?? {
            uuid: idGen(),
            role: roleOf(message),
            message,
          },
      );
      entries.length = 0;
      entries.push(...next);
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

    // ---- cross-runner history reconstruction --------------------------
    //
    // Reached only after `write` answered `'unusable'` — the stored transcript
    // was written by the OTHER runner. Without this the agent starts blank
    // while the user still has the whole conversation on screen; measured on
    // kind (2026-08-21), it answered `NO-HISTORY` to a question about its own
    // first turn.
    //
    // The messages arrive text-only and bounded (the host filters and caps
    // them — see `session.get-display-history`), so there is no tool pairing to
    // repair and no signed reasoning to replay here.
    //
    // Two things this deliberately does NOT do:
    //
    //   - It does not fake the missing turns as if this runner had produced
    //     them. A leading `user` note states plainly that the tool-by-tool
    //     detail is gone, so the model's "I don't recall running that" is
    //     accurate rather than a contradiction the user has to puzzle over.
    //   - It does not mark these entries as shipped. They are context, not a
    //     transcript prefix the host already has; `restoreTranscriptForResume`
    //     returns `written: false` so the normal delta ship re-sends them as
    //     this runner's own (correctly formatted) transcript.
    async seedFromHistory({ messages, truncated }): Promise<void> {
      if (messages.length === 0) return;
      const note =
        `[Context note: this conversation continues from turns handled by a ` +
        `different agent runner. The conversation text below was recovered, ` +
        `but the tool calls and their results from those turns were not — if ` +
        `you need that detail, re-run the tool or ask. ` +
        `${truncated ? 'Older turns beyond this point were trimmed. ' : ''}` +
        `Everything after this note is the live session.]`;

      const seeded: ModelMessage[] = [
        { role: 'user', content: [{ type: 'text', text: note }] },
        ...messages.map<ModelMessage>((m) =>
          // Roles are preserved exactly as the host reported them. Relabelling
          // an assistant turn as `user` (or the reverse) would misattribute
          // authorship inside the model's own context.
          m.role === 'assistant'
            ? { role: 'assistant', content: [{ type: 'text', text: m.content }] }
            : { role: 'user', content: [{ type: 'text', text: m.content }] },
        ),
      ];
      append(seeded);
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
