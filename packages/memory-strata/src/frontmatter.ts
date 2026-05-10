import { dump as yamlDump } from 'js-yaml';
import type { MemoryFrontmatter } from './types.js';

// Serialize a frontmatter object + body into the canonical Strata file
// format: `---\n<yaml>\n---\n<body>\n`. We control both writer and
// reader; pulling in gray-matter (which wraps js-yaml plus a parser)
// would be deadweight for Phase 1, so we hand-write this side and
// rely on js-yaml — already in the workspace via @ax/validator-skill.

const FENCE = '---';

export function buildMarkdownFile(
  frontmatter: MemoryFrontmatter,
  body: string,
): string {
  // sortKeys: false keeps the field order we hand the dumper, which we
  // group semantically (identity → lifecycle → trust → optional). Easier
  // to read by humans + diff-friendly.
  // lineWidth: -1 disables auto-line-wrap so the body's `summary` field
  // (which can run long) survives intact.
  const yaml = yamlDump(frontmatter, { sortKeys: false, lineWidth: -1 }).trimEnd();
  const trimmedBody = body.endsWith('\n') ? body : `${body}\n`;
  return `${FENCE}\n${yaml}\n${FENCE}\n${trimmedBody}`;
}
