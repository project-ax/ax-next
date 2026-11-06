import { ARTIFACT_KIND_LABELS, type ArtifactKind } from '@ax/ipc-protocol/content-blocks';

/** "Document", "Web page"… — the one word-set lives in @ax/ipc-protocol. */
export function artifactTypeLabel(kind: ArtifactKind): string {
  return ARTIFACT_KIND_LABELS[kind];
}
