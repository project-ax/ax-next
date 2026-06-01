import { dump as yamlDump } from 'js-yaml';

/**
 * Serialize a skill manifest (the YAML that goes BETWEEN the --- fences).
 * Inverse of parseSkillManifest for the fields a promote/migration flow controls.
 *
 * A skill manifest carries NO capability block (TASK-100 closed the half-wired
 * window): reach lives only on the connectors a skill references. Only emits a
 * top-level `connectors:` list when the skill declares at least one connector
 * reference (absent ≡ `[]` on parse).
 *
 * `extra` (TASK-133) carries unknown frontmatter keys captured by
 * parseSkillManifest so the form-first editor's parse→build round-trip preserves
 * custom keys. It is merged UNDER the modeled fields — the typed name /
 * description / version / connectors always win, so a crafted `extra.name`
 * cannot shadow the real one. (Callers that pass no `extra` are unaffected.)
 */
export function buildSkillManifestYaml(input: {
  id: string;
  description: string;
  version: number;
  /** Soft-dependency connector-id reference list (defaults to none). */
  connectors?: string[];
  /** Unmodeled frontmatter keys to preserve on round-trip (modeled keys win). */
  extra?: Record<string, unknown>;
}): string {
  // Modeled keys come first (so `name:` leads the manifest, matching the
  // pre-TASK-133 output), then the preserved `extra` keys. A modeled key that
  // also appears in `extra` is dropped from extra — the typed field is the
  // source of truth and always wins, so a crafted `extra.name` can't shadow it.
  const doc: Record<string, unknown> = {
    name: input.id,
    description: input.description,
    version: input.version,
  };
  const connectors = input.connectors ?? [];
  if (connectors.length > 0) {
    doc.connectors = connectors;
  }
  // Only the keys we set canonically above are protected from `extra` shadowing.
  // `sourceUrl` has no typed build field, so a caller that wants to preserve it
  // round-trips it THROUGH `extra` (parseSkillManifest surfaces it as the typed
  // `sourceUrl`, the editor folds it back into `extra` before rebuilding).
  const canonical = new Set(['name', 'description', 'version', 'connectors']);
  for (const [k, v] of Object.entries(input.extra ?? {})) {
    if (!canonical.has(k)) doc[k] = v;
  }
  return yamlDump(doc, { noRefs: true });
}
