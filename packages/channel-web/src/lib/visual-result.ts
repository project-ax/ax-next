/**
 * visual-result — the `show_visual` tool RESULT, read the same way on both
 * sides of the workspace (server `buildThread` on reload, browser on the live
 * frames). Shared for the TASK-352 reason: a parser only one side applies is a
 * difference between what you see live and after a reload.
 *
 * Imported by the server, so: `.js` relative imports, no React, no assets.
 *
 * Names and limits are RESTATED, not imported from the tool plugin
 * (invariant 2). Only the tool's RESULT is read; its `html` input is never
 * forwarded to the browser here.
 */
import { fenceLine } from './fence-line.js';
import type { ThreadVisual } from './workspace-types.js';

/** The two spellings in transcripts: aisdk, and claude-sdk's MCP-prefixed. */
export const SHOW_VISUAL_TOOL_NAMES: readonly string[] = [
  'show_visual',
  'mcp__ax-sandbox-tools__show_visual',
];

export function isShowVisualToolName(name: unknown): boolean {
  return typeof name === 'string' && SHOW_VISUAL_TOOL_NAMES.includes(name);
}

/** Mirrors `AttachmentIdSchema` (a test keeps the two in step). */
export const VISUAL_ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Mirrors MAX_VISUAL_TITLE_CHARS in the tool plugin. */
export const VISUAL_TITLE_MAX_CHARS = 120;
export const VISUAL_SUMMARY_MAX_CHARS = 1000;

function candidateTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((c: unknown) =>
    c !== null && typeof c === 'object' && 'type' in c && c.type === 'text' &&
    'text' in c && typeof c.text === 'string' ? [c.text] : []);
}

function fromJson(text: string): ThreadVisual | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.artifactId !== 'string' || !VISUAL_ARTIFACT_ID_RE.test(o.artifactId)) return null;
  const title = fenceLine(typeof o.title === 'string' ? o.title : null, VISUAL_TITLE_MAX_CHARS);
  const summary = fenceLine(typeof o.summary === 'string' ? o.summary : null, VISUAL_SUMMARY_MAX_CHARS);
  if (title === null || summary === null) return null;
  return { artifactId: o.artifactId, title, summary };
}

/**
 * Whole text first, then its first line (a runner may append a plain-text
 * note after the JSON). Anything else is not a visual.
 */
export function visualFromToolResult(content: unknown): ThreadVisual | null {
  for (const text of candidateTexts(content)) {
    const whole = fromJson(text);
    if (whole !== null) return whole;
    const nl = text.indexOf('\n');
    if (nl > 0) {
      const first = fromJson(text.slice(0, nl));
      if (first !== null) return first;
    }
  }
  return null;
}
