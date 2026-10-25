// ---------------------------------------------------------------------------
// Render a connector's MCP `tools/call` result as the string `ai@7`'s execute
// returns (TASK-826).
//
// The result is UNTRUSTED third-party output. It only ever becomes the text of
// a tool result — never a path, a command, a URL or a system instruction — and
// it is size-capped so one chatty connector cannot flood the context window.
// Non-text parts (images, audio, binary resources) become short placeholders:
// this runner passes tool output to the model as text only, for now.
//
// Nothing upstream has checked the result's shape (TASK-944): the runner
// parses `tools/call` results with the SDK's loose `ResultSchema`, not its
// content schema, so every field here can hold any JSON value. Each field is
// type-checked before it is used, and a server value is never handed to
// `String()` or a template unless it is already a string: an object whose
// `toString` is not callable makes both throw.
// ---------------------------------------------------------------------------

export const MAX_MCP_OUTPUT_BYTES = 100 * 1024;
const TRUNCATED_MARKER = '\n\n[output truncated at 100 KB]';

/** `v` if the server sent a non-empty string there, else undefined. */
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function resourcePlaceholder(uri: unknown): string {
  const u = nonEmptyString(uri);
  return u !== undefined ? `[resource ${u} omitted]` : '[resource omitted]';
}

function renderPart(part: unknown): string | undefined {
  if (typeof part !== 'object' || part === null) return undefined;
  const p = part as Record<string, unknown>;
  // A part with no string type can't be named, so it renders as nothing.
  const type = nonEmptyString(p['type']);
  if (type === undefined) return undefined;
  if (type === 'text') return typeof p['text'] === 'string' ? p['text'] : undefined;
  if (type === 'resource') {
    const r = p['resource'];
    if (typeof r !== 'object' || r === null) return '[resource omitted]';
    const res = r as Record<string, unknown>;
    if (typeof res['text'] === 'string') return res['text'];
    return resourcePlaceholder(res['uri']);
  }
  if (type === 'resource_link') return resourcePlaceholder(p['uri']);
  const mime = nonEmptyString(p['mimeType']);
  return mime !== undefined ? `[${type}: ${mime} omitted]` : `[${type} omitted]`;
}

/** `structuredContent` as JSON, when it is a JSON object (MCP says it is). */
function renderStructured(sc: unknown): string | undefined {
  if (typeof sc !== 'object' || sc === null || Array.isArray(sc)) return undefined;
  try {
    return JSON.stringify(sc);
  } catch {
    // Nested deeper than JSON.stringify's stack allows (it throws a
    // RangeError from about 10,000 levels; JSON.parse accepts far more).
    return '[structured content omitted]';
  }
}

function cap(text: string): string {
  if (Buffer.byteLength(text) <= MAX_MCP_OUTPUT_BYTES) return text;
  return Buffer.from(text).subarray(0, MAX_MCP_OUTPUT_BYTES).toString('utf8') + TRUNCATED_MARKER;
}

export function renderMcpResult(res: { content?: unknown; structuredContent?: unknown }): string {
  const content = Array.isArray(res.content) ? res.content : [];
  // Joined part by part, stopping once past the cap, so an answer of a
  // million small parts costs what 100 KB of them do (MEASURED: building
  // every placeholder first added up to +54 MB for an 8 MiB answer). The
  // capped output is the same either way: a UTF-16 unit is never less than
  // one UTF-8 byte, so the first MAX_MCP_OUTPUT_BYTES bytes are settled.
  let text: string | undefined;
  for (const part of content) {
    const s = renderPart(part);
    if (s === undefined) continue;
    text = text === undefined ? s : `${text}\n${s}`;
    if (text.length > MAX_MCP_OUTPUT_BYTES) break;
  }
  if (text !== undefined) return cap(text);
  const structured = renderStructured(res.structuredContent);
  return structured !== undefined ? cap(structured) : '';
}
