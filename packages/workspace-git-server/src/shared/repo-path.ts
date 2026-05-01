import { join, resolve, sep } from 'node:path';

// Defense-in-depth: assumes id has been validated upstream, but rejects escape independently.
export function repoPathFor(repoRoot: string, workspaceId: string): string {
  const candidate = join(repoRoot, `${workspaceId}.git`);
  const resolved = resolve(candidate);
  const rootResolved = resolve(repoRoot);
  if (!resolved.startsWith(rootResolved + sep)) {
    throw new Error('repo path escapes repoRoot');
  }
  return resolved;
}
