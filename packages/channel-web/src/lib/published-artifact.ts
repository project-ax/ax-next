/**
 * published-artifact — which live tool result CLAIMS it published an
 * artifact, so the card can be drawn while the reply is still streaming, the
 * way Claude shows a file the moment it is made.
 *
 * A claim, never a card. The result comes from the runner (agent-controlled
 * code), so all this yields is an id to ASK about; the card's title, kind and
 * version come from the artifact store, read back as the viewer, and the
 * caller drops it unless the store says it belongs to this agent. It is the
 * same rule the reload path applies (`verifiedArtifacts` in
 * server/routes-workspace.ts).
 *
 * Names RESTATED, not imported from the tool plugin (invariant 2).
 */
import { VISUAL_ARTIFACT_ID_RE } from './visual-result.js';

/** The two spellings in transcripts: aisdk, and claude-sdk's MCP-prefixed. */
export const ARTIFACT_PUBLISH_TOOL_NAMES: readonly string[] = [
  'artifact_publish',
  'mcp__ax-sandbox-tools__artifact_publish',
];

export function isArtifactPublishToolName(name: unknown): boolean {
  return typeof name === 'string' && ARTIFACT_PUBLISH_TOOL_NAMES.includes(name);
}

function candidateTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((c: unknown) =>
    c !== null && typeof c === 'object' && 'type' in c && c.type === 'text' &&
    'text' in c && typeof c.text === 'string' ? [c.text] : []);
}

/** The artifact id a publish result claims, or `null`. Untrusted: ask the store. */
export function claimedArtifactId(content: unknown): string | null {
  for (const text of candidateTexts(content)) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { continue; }
    if (parsed === null || typeof parsed !== 'object') continue;
    const id = (parsed as Record<string, unknown>).artifactId;
    if (typeof id === 'string' && VISUAL_ARTIFACT_ID_RE.test(id)) return id;
  }
  return null;
}
