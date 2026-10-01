import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AttachmentBlockSchema, type AttachmentBlock, type ContentBlock, type ToolCall } from '@ax/ipc-protocol';
import type { ArtifactPublishOutput } from './artifact-publish-executor.js';

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
    // the configured root; the executor independently checks every byte read.
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

/** Only reference files after both bytes and ownership metadata are durable. */
export function artifactAttachment(file: ArtifactPublishOutput): AttachmentBlock {
  return {
    type: 'attachment',
    path: file.path,
    displayName: file.displayName,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
  };
}

/** The model's explicit publish call can supply the chip without a second upload. */
export function publishedAttachments(calls: ContentBlock[], results: ContentBlock[]): AttachmentBlock[] {
  const ids = new Set(calls.flatMap(block => block.type === 'tool_use' &&
    (block.name === 'artifact_publish' || block.name === 'mcp__ax-sandbox-tools__artifact_publish')
    ? [block.id] : []));
  const out: AttachmentBlock[] = [];
  for (const block of results) {
    if (block.type !== 'tool_result' || block.is_error || block.held || !ids.has(block.tool_use_id)) continue;
    const texts = typeof block.content === 'string' ? [block.content]
      : block.content.flatMap(c => c.type === 'text' ? [c.text] : []);
    for (const text of texts) {
      try {
        const value: unknown = JSON.parse(text);
        if (value === null || typeof value !== 'object') continue;
        const parsed = AttachmentBlockSchema.safeParse({ ...value, type: 'attachment' });
        if (parsed.success) out.push(parsed.data);
      } catch { /* A non-artifact tool result has no chip. */ }
    }
  }
  return out;
}

export interface GeneratedFiles {
  collect(alreadyPublished?: readonly string[]): Promise<ContentBlock[]>;
}

/** A session baseline avoids attaching existing files again after a resume. */
export async function trackGeneratedFiles(opts: {
  root: string;
  publish: (call: ToolCall) => Promise<ArtifactPublishOutput>;
  warn: () => void;
}): Promise<GeneratedFiles> {
  let baseline: Set<string> | null;
  try { baseline = await snapshot(opts.root); }
  catch { baseline = null; opts.warn(); }
  return {
    async collect(alreadyPublished = []) {
      const blocks: ContentBlock[] = [];
      let current: Set<string>;
      try { current = await snapshot(opts.root); }
      catch {
        opts.warn();
        return [{ type: 'text', text: 'We could not check for new files to attach. Ask the agent to attach the files again.' }];
      }
      // A failed baseline must never turn every existing file into an output.
      if (baseline === null) { baseline = current; return blocks; }
      let failed = false;
      for (const relative of [...current].sort()) {
        if (baseline.has(relative) || alreadyPublished.includes(relative)) continue;
        try {
          const file = await opts.publish({
            id: randomUUID(), name: 'artifact_publish',
            input: { path: path.join(opts.root, relative) },
          });
          blocks.push(artifactAttachment(file));
        } catch { failed = true; opts.warn(); }
      }
      baseline = current;
      if (failed) blocks.push({
        type: 'text',
        text: 'Some new files could not be attached. Ask the agent to attach them again.',
      });
      return blocks;
    },
  };
}
