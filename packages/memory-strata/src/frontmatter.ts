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

/**
 * Strip the leading YAML frontmatter fence (`---\n...\n---\n`) from a markdown
 * file. Returns the body text that follows, trimmed of leading and trailing
 * blank lines. If no frontmatter fence is present, returns the full text as-is.
 *
 * The inverse of {@link buildMarkdownFile}, and it lives beside it so the two
 * readers that need it — the prompt builder (`inject.ts`) and the Memory tab
 * (`rules-store.ts`) — share ONE answer to "what does the agent actually read".
 * Two strippers would be two different agents.
 *
 * NOTE the one file this must never be pointed at: the human tier
 * (`system/rules.md`) carries no frontmatter by design, so a user whose first
 * line is a markdown horizontal rule would lose the top of their own text.
 * `readRules` reads it raw for exactly that reason.
 */
export function stripFrontmatter(text: string): string {
  const FENCE = '---';
  // Must start with '---' (possibly after a BOM or leading whitespace stripped)
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(FENCE)) return text.trim();

  // Find the closing fence. Start searching after the opening fence line.
  const afterOpen = trimmed.indexOf('\n') + 1;
  const closeIdx = trimmed.indexOf(`\n${FENCE}`, afterOpen);
  if (closeIdx === -1) return text.trim();

  // Body starts after the closing fence line (skip the '\n---' + newline).
  const bodyStart = closeIdx + `\n${FENCE}`.length;
  const body = trimmed.slice(bodyStart);
  return body.trim();
}
