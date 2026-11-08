import { ARTIFACT_KIND_LABELS, type ArtifactKind } from '@ax/ipc-protocol/content-blocks';
import { timeAgo } from '@/lib/workspace-time';

/** "Document", "Web page"… — the one word-set lives in @ax/ipc-protocol. */
export function artifactTypeLabel(kind: ArtifactKind): string {
  return ARTIFACT_KIND_LABELS[kind];
}

/** "Document · PDF", or just "Document" when there is no extension. */
export function artifactTypeLine(a: { kind: ArtifactKind; extension: string }): string {
  return a.extension === '' ? artifactTypeLabel(a.kind) : `${artifactTypeLabel(a.kind)} · ${a.extension}`;
}

/** "v3 · 2 hr ago" — the clock words come from the one time module. */
export function versionLabel(v: { version: number; createdAt: string }): string {
  const when = timeAgo(v.createdAt);
  return when === null ? `v${v.version}` : `v${v.version} · ${when}`;
}
