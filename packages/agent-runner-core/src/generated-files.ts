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

async function snapshot(root: string): Promise<Set<string>> {
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
      if (++count > MAX_ENTRIES) throw new Error('generated-file scan limit');
      if (entry.name.startsWith('.') || OMIT.has(entry.name)) continue;
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile() && !/\.py[cod]$/.test(entry.name)) files.add(relative);
    }
  }
  return files;
}

/** Why a generated file could not become a chip. Never carries a path or a name. */
export type GeneratedFileFailure =
  | 'gate-refused'
  | 'unaddressable-name'
  | 'not-a-regular-file'
  | 'outside-root'
  | 'error';

/** Thrown by `agentFileReference`; `reason` is typed so callers never match on messages. */
export class AgentFileReferenceError extends Error {
  constructor(readonly reason: Exclude<GeneratedFileFailure, 'gate-refused' | 'error'>, message: string) {
    super(message);
    this.name = 'AgentFileReferenceError';
  }
}

class GateRefusedError extends Error {}

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

export interface GeneratedFiles {
  collect(alreadyPublished?: readonly string[]): Promise<ContentBlock[]>;
}

/**
 * Attaches, by reference, the files each turn creates under `root`.
 *
 * A session baseline avoids attaching existing files again after a resume.
 * Every new file passes the same policy gate a model's own `artifact_publish`
 * call does, then its chip is reported as that call's outcome.
 */
export async function trackGeneratedFiles(opts: {
  root: string;
  /** The policy gate a model's own artifact_publish call gets: resolves = may attach, rejects = may not. */
  admit: (call: ToolCall) => Promise<void>;
  /** Reports the attached chip as that call's outcome (tool.post-call). */
  attached: (call: ToolCall, chip: AgentFileBlock) => Promise<void>;
  /** Called once per failure with a reason code only: never a path or a filename. */
  warn: (reason: GeneratedFileFailure) => void;
}): Promise<GeneratedFiles> {
  let baseline: Set<string> | null;
  try { baseline = await snapshot(opts.root); }
  catch { baseline = null; opts.warn('error'); }
  return {
    async collect(alreadyPublished = []) {
      const blocks: ContentBlock[] = [];
      let current: Set<string>;
      try { current = await snapshot(opts.root); }
      catch {
        opts.warn('error');
        return [{ type: 'text', text: 'We could not check for new files to attach. Ask the agent to attach the files again.' }];
      }
      // A failed baseline must never turn every existing file into an output.
      if (baseline === null) { baseline = current; return blocks; }
      let failed = false;
      let unnameable = false;
      for (const relative of [...current].sort()) {
        if (baseline.has(relative) || alreadyPublished.includes(relative)) continue;
        try {
          const call: ToolCall = {
            id: randomUUID(), name: 'artifact_publish',
            input: { path: path.join(opts.root, relative) },
          };
          // Reference first: a file that can never be a chip must not reach the
          // gate, where it could park a held approval. Only a chip that will
          // pass the host's block check is attached.
          const chip = await agentFileReference(opts.root, relative);
          try { await opts.admit(call); }
          catch { throw new GateRefusedError(); }
          await opts.attached(call, chip);
          blocks.push(chip);
        } catch (err) {
          // A name the Files tab cannot address is not fixed by trying again.
          const reason: GeneratedFileFailure = err instanceof AgentFileReferenceError ? err.reason
            : err instanceof GateRefusedError ? 'gate-refused' : 'error';
          if (reason === 'unaddressable-name') unnameable = true;
          else failed = true;
          opts.warn(reason);
        }
      }
      baseline = current;
      if (failed) blocks.push({
        type: 'text',
        text: 'Some new files could not be attached. Ask the agent to attach them again.',
      });
      if (unnameable) blocks.push({
        type: 'text',
        text: "A new file has a name we can't link to here (for example, one with a colon). Ask the agent to rename it.",
      });
      return blocks;
    },
  };
}
