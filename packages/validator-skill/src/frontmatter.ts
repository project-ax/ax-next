// ---------------------------------------------------------------------------
// SKILL.md YAML frontmatter parser (Phase 3 Slice 8).
//
// Skills follow Anthropic's claude-skills convention: a YAML
// frontmatter block at the top of SKILL.md, fenced by `---` lines,
// followed by markdown body. Required fields:
//   name        - non-empty string
//   description - non-empty string
//
// Other fields (e.g. version, category) are permitted but not
// validated. The parser is intentionally narrow: we check the shape
// the host needs to know about a skill exists, no more.
//
// Untrusted-input discipline: SKILL.md content comes from the agent
// (model output -> tool call -> workspace write). Treat as adversarial:
//   - Decode bytes as UTF-8 STRICT (no replacement chars). Non-UTF-8
//     bytes are rejected loud rather than silently coerced.
//   - YAML parser is js-yaml's `load` (the safe schema by default,
//     no js-functions, no class instantiation, no tag escapes that
//     could trigger code execution).
//   - We do not interpolate fields into shell, paths, HTML, SQL, or
//     any other context that would care about the bytes - we just
//     ack the shape and move on.
// ---------------------------------------------------------------------------

import { load as yamlLoad, YAMLException } from 'js-yaml';

const FRONTMATTER_FENCE = /^---\n([\s\S]*?)\n---(\n|$)/;

export interface FrontmatterFields {
  name: string;
  description: string;
}

export type FrontmatterResult =
  | { ok: true; fields: FrontmatterFields }
  | { ok: false; reason: string };

/**
 * Parse SKILL.md frontmatter from a UTF-8 string.
 *
 * Pure function. No filesystem, no network, no process spawn - given
 * the same input, returns the same result. Easy to fuzz; easy to
 * reason about.
 */
export function parseFrontmatter(text: string): FrontmatterResult {
  const m = FRONTMATTER_FENCE.exec(text);
  if (m === null) {
    return { ok: false, reason: 'no frontmatter block' };
  }
  const body = m[1] ?? '';
  let parsed: unknown;
  try {
    // js-yaml's default `load` uses the safe schema (no js-functions,
    // no class instantiation). Anonymous values (e.g., `: bad`) throw
    // YAMLException, which we catch and surface as a clean reason.
    parsed = yamlLoad(body);
  } catch (err) {
    if (err instanceof YAMLException) {
      return { ok: false, reason: `invalid YAML in frontmatter: ${err.reason}` };
    }
    return { ok: false, reason: `invalid YAML in frontmatter` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'frontmatter must be a YAML mapping (object), not array/scalar',
    };
  }
  const obj = parsed as Record<string, unknown>;
  const name = obj['name'];
  const description = obj['description'];
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, reason: 'frontmatter missing required field: name' };
  }
  if (typeof description !== 'string' || description.length === 0) {
    return {
      ok: false,
      reason: 'frontmatter missing required field: description',
    };
  }
  return { ok: true, fields: { name, description } };
}

/**
 * Parse SKILL.md frontmatter from raw UTF-8 bytes.
 *
 * Decodes bytes STRICTLY (`fatal: true`) - non-UTF-8 input rejects
 * cleanly rather than silently producing replacement characters that
 * might bypass validation. Then delegates to `parseFrontmatter`.
 */
export function parseFrontmatterBytes(bytes: Uint8Array): FrontmatterResult {
  let text: string;
  try {
    // `fatal: true` makes the decoder throw on invalid UTF-8 instead
    // of producing U+FFFD replacement chars. We want the loud
    // rejection - silent replacement could let an attacker hide
    // payloads in invalid byte sequences that get sanitized by the
    // decoder but not by our checks.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'SKILL.md content is not valid UTF-8' };
  }
  return parseFrontmatter(text);
}
