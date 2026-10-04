// ---------------------------------------------------------------------------
// Render a connector's MCP `tools/call` result as the string `ai@7`'s execute
// returns (TASK-826).
//
// The result is UNTRUSTED third-party output. It only ever becomes the text of
// a tool result — never a path, a command, a URL or a system instruction — and
// it is size-capped so one chatty connector cannot flood the context window.
// Non-text parts (images, audio, binary resources) become short placeholders:
// this runner passes tool output to the model as text only, for now.
// ---------------------------------------------------------------------------

export const MAX_MCP_OUTPUT_BYTES = 100 * 1024;
const TRUNCATED_MARKER = '\n\n[output truncated at 100 KB]';

function renderPart(part: unknown): string | undefined {
  if (typeof part !== 'object' || part === null) return undefined;
  const p = part as Record<string, unknown>;
  const type = p['type'];
  if (type === 'text') return typeof p['text'] === 'string' ? p['text'] : undefined;
  if (type === 'resource') {
    const r = p['resource'];
    if (typeof r === 'object' && r !== null) {
      const res = r as Record<string, unknown>;
      if (typeof res['text'] === 'string') return res['text'];
      return `[resource ${String(res['uri'] ?? '')} omitted]`;
    }
    return '[resource omitted]';
  }
  if (type === 'resource_link') return `[resource ${String(p['uri'] ?? '')} omitted]`;
  const mime = typeof p['mimeType'] === 'string' ? `: ${p['mimeType']}` : '';
  return `[${String(type)}${mime} omitted]`;
}

function cap(text: string): string {
  if (Buffer.byteLength(text) <= MAX_MCP_OUTPUT_BYTES) return text;
  return Buffer.from(text).subarray(0, MAX_MCP_OUTPUT_BYTES).toString('utf8') + TRUNCATED_MARKER;
}

export function renderMcpResult(res: { content?: unknown; structuredContent?: unknown }): string {
  const content = Array.isArray(res.content) ? res.content : [];
  const parts = content.map(renderPart).filter((s): s is string => s !== undefined);
  if (parts.length > 0) return cap(parts.join('\n'));
  if (res.structuredContent !== undefined) return cap(JSON.stringify(res.structuredContent));
  return '';
}
