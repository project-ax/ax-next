import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  agentFileBlock,
  attachmentBlockFromArtifact,
  type AgentFileBlock,
  type AttachmentBlock,
  type ContentBlock,
  type ToolCall,
} from '@ax/ipc-protocol';
import { mediaTypeFromExtension } from './artifact-publish-executor.js';

// Auto-attach (TASK-1012). A file a turn leaves in the agent's home is attached
// to that turn BY REFERENCE: an `agent_file` chip that names the file by its key
// relative to the home, the same key the Files tab lists it by. No byte leaves
// the sandbox here and nothing is copied into the blob store, so the file is
// charged once, as an agent file. The chip downloads the file itself, live,
// through the host's confined reader. A file the model publishes explicitly
// (`artifact_publish`) keeps its blob-backed `attachment` chip.
//
// /files is also HOME. Configuration, SDK state and dependencies are not
// deliverables. Never follow symlinks, including intermediate directories.
const OMIT = new Set(['node_modules', 'venv', '__pycache__']);
const MAX_ENTRIES = 10_000;

/** The home holds more entries than one scan visits: not the same as a scan that broke. */
class ScanLimitError extends Error {}

async function snapshot(root: string, maxEntries: number): Promise<Set<string>> {
  const realRoot = await fs.realpath(root);
  const files = new Set<string>();
  const pending = [''];
  let count = 0;
  while (pending.length > 0) {
    const dir = pending.pop()!;
    const absolute = path.join(root, dir);
    // A directory may have been swapped since readdir. Do not scan outside
    // the configured root; `agentFileReference` checks each file again.
    const real = await fs.realpath(absolute);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue;
    for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
      if (++count > maxEntries) throw new ScanLimitError('generated-file scan limit');
      if (entry.name.startsWith('.') || OMIT.has(entry.name)) continue;
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile() && !/\.py[cod]$/.test(entry.name)) files.add(relative);
    }
  }
  return files;
}

/**
 * What the policy gate said about one automatic attach. `held` names the
 * decision a person is now asked to answer. `unavailable` is the gate failing
 * closed (nothing decided the call), which is not the same as a rule that said
 * no (`denied`).
 */
export type GateVerdict =
  | { kind: 'allow' }
  | { kind: 'held'; decisionId: string }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

/** Why a generated file could not become a chip. Never carries a path or a name. */
export type GeneratedFileFailure =
  | 'denied'
  | 'held'
  | 'unavailable'
  | 'scan-limit'
  | 'unaddressable-name'
  | 'not-a-regular-file'
  | 'outside-root'
  | 'undelivered'
  | 'error';

/** Thrown by `agentFileReference`; `reason` is typed so callers never match on messages. */
export class AgentFileReferenceError extends Error {
  constructor(readonly reason: 'unaddressable-name' | 'not-a-regular-file' | 'outside-root', message: string) {
    super(message);
    this.name = 'AgentFileReferenceError';
  }
}

/** The gate did not allow the call. */
class GateRefusedError extends Error {
  constructor(readonly reason: Exclude<GateVerdict['kind'], 'allow'>) {
    super(`not allowed (${reason})`);
  }
}

/** A fresh note block each time: nothing downstream shares one. */
function note(text: string): ContentBlock {
  return { type: 'text', text };
}
const NOT_ATTACHED = 'Some new files could not be attached. Ask the agent to attach them again.';
// A held file must never be told "attach them again": the only way to do that
// is the model's own publish, which copies the file into the blob store.
const HELD = 'Some new files are waiting for your approval before we attach them.';
const NOT_NAMEABLE = "Some new files have names we can't link to here (for example, ones with a colon). Ask the agent to rename them.";
const SCAN_FAILED = 'We could not check for new files to attach. Ask the agent to attach the files again.';

function scanFailure(err: unknown): GeneratedFileFailure {
  return err instanceof ScanLimitError ? 'scan-limit' : 'error';
}

/**
 * The `agent_file` chip for `relative`, a file under `root` (the agent's home).
 *
 * The file must still be a regular file: `lstat`, so a symlink is refused
 * rather than followed, and so is a folder. Its real path must stay under the
 * real root (the publish executor's containment check), which catches a
 * folder swapped since the scan for a link that leads out. Only metadata is
 * read, no bytes, so no size cap applies here: the download route answers for
 * size, and serves only what its no-follow reader can still open.
 *
 * Throws for anything that cannot be a chip, including a name the Files tab
 * cannot address (`notes: q3.md`), so the caller reports it rather than
 * attaching a chip that can only fail to download.
 */
export async function agentFileReference(root: string, relative: string): Promise<AgentFileBlock> {
  const absolute = path.join(root, relative);
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new AgentFileReferenceError('not-a-regular-file', 'not a regular file');
  const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(absolute)]);
  if (!realFile.startsWith(realRoot + path.sep)) throw new AgentFileReferenceError('outside-root', 'resolved outside the agent files');
  const chip = agentFileBlock({
    path: relative.split(path.sep).join('/'),
    mediaType: mediaTypeFromExtension(path.basename(relative)),
    sizeBytes: stat.size,
  });
  if (chip === null) throw new AgentFileReferenceError('unaddressable-name', 'not a key the Files tab can address');
  return chip;
}

/**
 * Download chips for the model's explicit `artifact_publish` calls this turn,
 * and the root-relative paths they came from (so auto-attach skips them).
 *
 * A chip names the artifact by id (`artifactId`); where the file sat in the
 * sandbox never leaves it (Invariant 1). The result rides a tool_result, so
 * every field is re-checked: one that cannot make a valid chip yields nothing.
 */
export function publishedAttachments(
  calls: ContentBlock[],
  results: ContentBlock[],
): { blocks: AttachmentBlock[]; paths: string[] } {
  const ids = new Set(calls.flatMap(block => block.type === 'tool_use' &&
    (block.name === 'artifact_publish' || block.name === 'mcp__ax-sandbox-tools__artifact_publish')
    ? [block.id] : []));
  const blocks: AttachmentBlock[] = [];
  const paths: string[] = [];
  for (const block of results) {
    if (block.type !== 'tool_result' || block.is_error || block.held || !ids.has(block.tool_use_id)) continue;
    const texts = typeof block.content === 'string' ? [block.content]
      : block.content.flatMap(c => c.type === 'text' ? [c.text] : []);
    for (const text of texts) {
      let value: unknown;
      try { value = JSON.parse(text); } catch { continue; /* A non-artifact tool result has no chip. */ }
      const chip = attachmentBlockFromArtifact(value);
      if (chip === null) continue;
      blocks.push(chip);
      const published = (value as { path?: unknown }).path;
      if (typeof published === 'string') paths.push(published);
    }
  }
  return { blocks, paths };
}

/** How many of its own held attaches one tracker remembers. The oldest is forgotten first. */
export const MAX_HELD_AUTO_ATTACH = 256;

export interface GeneratedFiles {
  collect(alreadyPublished?: readonly string[]): Promise<ContentBlock[]>;
  /**
   * A person answered decision `decisionId`. True iff it is a hold this
   * tracker raised and still remembers, which it then forgets. An approved
   * hold goes back to the gate, and whatever that attaches rides the next
   * `collect`. Never rejects.
   */
  resolveHeld(decisionId: string, outcome: 'approved' | 'dismissed' | undefined): Promise<boolean>;
  /**
   * How many chips approved holds produced that no turn-end has carried yet.
   * The approval was spent when the answer was pulled, so a run that ends
   * before its next turn-end loses these: the caller says so.
   */
  undelivered(): number;
}

const APPROVED_NOTE =
  'A person approved attaching new files from earlier in this conversation. ' +
  'That is handled for you: do not publish them yourself unless the user asks you to. You do not need to reply.';
const DECLINED_NOTE =
  'A person chose not to attach new files from earlier in this conversation, so they were not attached. ' +
  'Do not publish them unless the user asks you to. You do not need to reply.';

/**
 * What the model reads when a person answers one of the runner's own held
 * attaches, in place of the host's "make that call again": the model never
 * made that call, so it could only guess at it. Model-facing, and labelled by
 * `decisionResolvedTurn`. A missing outcome reads as declined.
 */
export function autoAttachResolvedNote(outcome: 'approved' | 'dismissed' | undefined): string {
  return outcome === 'approved' ? APPROVED_NOTE : DECLINED_NOTE;
}

/** The notes a turn-end owes; each goes out at most once. */
interface Notes { failed: boolean; held: boolean; unnameable: boolean }
function noNotes(): Notes {
  return { failed: false, held: false, unnameable: false };
}

/**
 * Attaches, by reference, the files each turn creates under `root`.
 *
 * A session baseline avoids attaching existing files again after a resume.
 * Every new file passes the same policy gate a model's own `artifact_publish`
 * call does, then its chip is reported as that call's outcome.
 *
 * A held file is attached only once a person approves it and the gate then
 * allows the identical call (TASK-1017): `resolveHeld` sends that call back.
 */
export async function trackGeneratedFiles(opts: {
  root: string;
  /** The policy gate a model's own artifact_publish call gets. Only `allow` attaches. */
  admit: (call: ToolCall) => Promise<GateVerdict>;
  /** Reports the attached chip as that call's outcome (tool.post-call). */
  attached: (call: ToolCall, chip: AgentFileBlock) => Promise<void>;
  /** Called once per failure with a reason code only: never a path or a filename. */
  warn: (reason: GeneratedFileFailure) => void;
  /** Test seam: the most directory entries one scan visits. */
  maxEntries?: number;
}): Promise<GeneratedFiles> {
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  let baseline: Set<string> | null;
  try { baseline = await snapshot(opts.root, maxEntries); }
  catch (err) { baseline = null; opts.warn(scanFailure(err)); }

  // The holds this tracker raised, by decision id: the call exactly as the
  // gate saw it, and the file it names. Only the gate's own `held` verdicts
  // add one, and the path comes from this tracker's own scan, so nothing the
  // model writes can put a file here.
  const holds = new Map<string, { call: ToolCall; relative: string }>();
  // What answered holds produced since the last turn-end. Drained in place
  // (never reassigned), so an answer that finishes during a turn-end is kept.
  const answered: AgentFileBlock[] = [];
  const answeredNotes = noNotes();

  function remember(decisionId: string, hold: { call: ToolCall; relative: string }): void {
    holds.set(decisionId, hold);
    // A Map iterates in insertion order: the first key is the oldest hold.
    if (holds.size > MAX_HELD_AUTO_ATTACH) {
      const oldest = holds.keys().next().value;
      if (oldest !== undefined) holds.delete(oldest);
    }
  }

  /**
   * The chip for `relative`, once the gate allows `call`. Throws otherwise.
   *
   * Reference first: a file that can never be a chip must not reach the gate,
   * where it could park a held approval or spend one. Only a chip that will
   * pass the host's block check is attached.
   */
  async function attach(call: ToolCall, relative: string): Promise<AgentFileBlock> {
    const chip = await agentFileReference(opts.root, relative);
    const verdict = await opts.admit(call);
    if (verdict.kind === 'held') remember(verdict.decisionId, { call, relative });
    if (verdict.kind !== 'allow') throw new GateRefusedError(verdict.kind);
    await opts.attached(call, chip);
    return chip;
  }

  function report(err: unknown, notes: Notes): void {
    const reason: GeneratedFileFailure =
      err instanceof AgentFileReferenceError || err instanceof GateRefusedError ? err.reason : 'error';
    // A name the Files tab cannot address is not fixed by trying again, and a
    // held file is waiting on a person, not on another try.
    if (reason === 'unaddressable-name') notes.unnameable = true;
    else if (reason === 'held') notes.held = true;
    else notes.failed = true;
    opts.warn(reason);
  }

  /**
   * One turn-end's blocks: the chips (answered holds first), then each note
   * once, then `tail`. Synchronous, so what an answer queued goes out exactly
   * once, with whichever turn ends next.
   */
  function release(chips: AgentFileBlock[], notes: Notes, tail: ContentBlock[] = []): ContentBlock[] {
    const blocks: ContentBlock[] = [...answered.splice(0), ...chips];
    if (notes.failed || answeredNotes.failed) blocks.push(note(NOT_ATTACHED));
    if (notes.held || answeredNotes.held) blocks.push(note(HELD));
    if (notes.unnameable || answeredNotes.unnameable) blocks.push(note(NOT_NAMEABLE));
    Object.assign(answeredNotes, noNotes());
    return [...blocks, ...tail];
  }

  return {
    async collect(alreadyPublished = []) {
      let current: Set<string>;
      try { current = await snapshot(opts.root, maxEntries); }
      catch (err) {
        opts.warn(scanFailure(err));
        return release([], noNotes(), [note(SCAN_FAILED)]);
      }
      // A failed baseline must never turn every existing file into an output.
      if (baseline === null) { baseline = current; return release([], noNotes()); }
      const chips: AgentFileBlock[] = [];
      const notes = noNotes();
      for (const relative of [...current].sort()) {
        if (baseline.has(relative) || alreadyPublished.includes(relative)) continue;
        const call: ToolCall = {
          id: randomUUID(), name: 'artifact_publish',
          input: { path: path.join(opts.root, relative) },
        };
        try { chips.push(await attach(call, relative)); }
        catch (err) { report(err, notes); }
      }
      baseline = current;
      return release(chips, notes);
    },

    async resolveHeld(decisionId, outcome) {
      const hold = holds.get(decisionId);
      if (hold === undefined) return false;
      // Forgotten before the first await: a repeated delivery finds nothing,
      // so one answer can never attach twice.
      holds.delete(decisionId);
      if (outcome !== 'approved') return true;
      // The very call the person approved, byte for byte: the gate's standing
      // approval is keyed on it, and only the gate's `allow` attaches. A file
      // that has gone, or become a link, since the hold is refused before the
      // gate is asked, so the approval stays unspent.
      try {
        const chip = await attach(hold.call, hold.relative);
        answered.push(chip);
      } catch (err) { report(err, answeredNotes); }
      return true;
    },

    undelivered: () => answered.length,
  };
}
