import { dump as yamlDump } from 'js-yaml';

/**
 * Serialize a skill manifest (the YAML that goes BETWEEN the --- fences).
 * Inverse of parseSkillManifest for the fields a promote/migration flow controls.
 *
 * A skill manifest carries NO capability block (TASK-100 closed the half-wired
 * window): reach lives only on the connectors a skill references. Only emits a
 * top-level `connectors:` list when the skill declares at least one connector
 * reference (absent ≡ `[]` on parse).
 */
export function buildSkillManifestYaml(input: {
  id: string;
  description: string;
  version: number;
  /** Soft-dependency connector-id reference list (defaults to none). */
  connectors?: string[];
}): string {
  const doc: Record<string, unknown> = {
    name: input.id,
    description: input.description,
    version: input.version,
  };
  const connectors = input.connectors ?? [];
  if (connectors.length > 0) {
    doc.connectors = connectors;
  }
  return yamlDump(doc, { noRefs: true });
}
