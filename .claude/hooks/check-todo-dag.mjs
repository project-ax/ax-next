#!/usr/bin/env node
// PostToolUse hook — enforces the CLAUDE.md "TODO.md DAG Policy".
//
// When TODO.md is edited, the Parallelization DAG (the ```mermaid block) must
// stay in sync with the task list: every OPEN task's `[ID]` tag must have
// exactly one graph node, and every graph node must have a matching open task.
// Completed/struck tasks ("- [x]") are intentionally excluded — a finished task
// is removed from the graph per the policy.
//
// On drift: exit 2 with an explanation on stderr, which Claude Code feeds back
// to the model so it fixes the graph before moving on. Non-TODO.md edits and
// unreadable files are no-ops (exit 0) so the hook never blocks unrelated work.

import { readFileSync } from 'node:fs';
import path from 'node:path';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

let input;
try {
  input = JSON.parse(readStdin() || '{}');
} catch {
  process.exit(0); // malformed hook payload — don't block
}

const filePath = input?.tool_input?.file_path;
if (!filePath || path.basename(filePath) !== 'TODO.md') {
  process.exit(0); // not a TODO.md edit
}

let text;
try {
  text = readFileSync(filePath, 'utf8');
} catch {
  process.exit(0); // file gone/unreadable — don't block
}

// 1) Open-task IDs: `[ARCH-1]`-style tags on UNCHECKED ("- [ ]") task lines.
const openTaskIds = new Set();
for (const line of text.split('\n')) {
  if (!/^\s*-\s*\[\s\]/.test(line)) continue;
  for (const m of line.matchAll(/\[([A-Z]+-\d+)\]/g)) openTaskIds.add(m[1]);
}

// 2) Graph node IDs: the canonical ID lives at the start of each node label,
//    e.g. ARCH1["ARCH-1 · ..."]. Anchoring on `id["` skips edge identifiers
//    (ARCH4, FA1 — no hyphen), classDef lines, subgraph titles, and any
//    hyphenated tokens that appear later inside a label (e.g. "walk F-2").
const fence = text.match(/```mermaid\s*([\s\S]*?)```/);
if (!fence) {
  console.error(
    'TODO.md DAG Policy: no ```mermaid Parallelization DAG block found. ' +
      'TODO.md must keep the DAG in sync with the task list (see CLAUDE.md > TODO.md DAG Policy).',
  );
  process.exit(2);
}
const graphIds = new Set();
for (const m of fence[1].matchAll(/\w+\[\s*["']\s*([A-Z]+-\d+)/g)) graphIds.add(m[1]);

// 3) Compare the two sets.
const missingNode = [...openTaskIds].filter((id) => !graphIds.has(id)).sort();
const orphanNode = [...graphIds].filter((id) => !openTaskIds.has(id)).sort();

if (missingNode.length === 0 && orphanNode.length === 0) process.exit(0);

const out = [
  'TODO.md DAG Policy violation (CLAUDE.md): the Parallelization DAG drifted from the task list.',
];
if (missingNode.length) {
  out.push(
    `  Open tasks with NO graph node: ${missingNode.join(', ')} — add a node (+ edges/box + batch prose) for each.`,
  );
}
if (orphanNode.length) {
  out.push(
    `  Graph nodes with NO open task: ${orphanNode.join(', ')} — remove the node (+ its edges/classDef) or restore the task.`,
  );
}
out.push(
  'Update the ```mermaid DAG so every open [ID] task has exactly one node and vice versa, then re-save TODO.md.',
);
console.error(out.join('\n'));
process.exit(2);
