import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  attachmentBlockFromArtifact,
  type AttachmentBlock,
  type ContentBlock,
  type ToolCall,
} from '@ax/ipc-protocol';
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
          // Only reference a file once its bytes and ownership row are durable,
          // and only by a chip that will pass the host's block check.
          const chip = attachmentBlockFromArtifact(file);
          if (chip === null) throw new Error('publish result cannot name the artifact');
          blocks.push(chip);
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
