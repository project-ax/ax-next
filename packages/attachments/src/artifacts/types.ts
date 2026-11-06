/**
 * Hook I/O for the artifact owner hooks (`artifacts:*`), with their runtime
 * `returns` contracts.
 *
 * What never appears here: the share code and the source path. The code is a
 * capability (§6.3) and the path is the agent's own file layout (C2); the only
 * place either leaves this plugin is back to the agent, through the augment.
 * The `returns` schemas strip any key they do not declare, so a field added to
 * a row by mistake is dropped at the bus rather than shipped.
 */

import { z, type ZodType } from 'zod';
import { ArtifactKindSchema } from '@ax/ipc-protocol';
import type { ArtifactKind, ArtifactPreview } from './media.js';

const ArtifactPreviewSchema = z.enum(['html', 'markdown', 'image', 'text', 'pdf', 'none']);

export interface ArtifactSummary {
  artifactId: string;
  agentId: string;
  title: string;
  mediaType: string;
  kind: ArtifactKind;
  preview: ArtifactPreview;
  /** Upper-case extension label (`PDF`), or '' when the type has none. */
  extension: string;
  currentVersion: number;
  sizeBytes: number;
  /** Whether a share link is on. Never the code itself. */
  linkOn: boolean;
  createdAt: string;
  /** When the current version last changed (publish or restore). A rename leaves it. */
  updatedAt: string;
}

export interface ArtifactVersionInfo {
  version: number;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ArtifactDetail extends ArtifactSummary {
  /** Newest first. */
  versions: ArtifactVersionInfo[];
}

const ArtifactSummaryShape = {
  artifactId: z.string(),
  agentId: z.string(),
  title: z.string(),
  mediaType: z.string(),
  kind: ArtifactKindSchema,
  preview: ArtifactPreviewSchema,
  extension: z.string(),
  currentVersion: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative(),
  linkOn: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

const ArtifactSummarySchema = z.object(ArtifactSummaryShape);

const ArtifactVersionInfoSchema = z.object({
  version: z.number().int().positive(),
  mediaType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string(),
});

// --- artifacts:publish -----------------------------------------------------

export interface ArtifactsPublishInput {
  conversationId: string;
  sha256: string;
  /** Relative to the agent's files root; the re-publish key. */
  sourcePath: string;
  title: string;
  /** Re-publish this artifact rather than the one keyed by `sourcePath`. */
  artifactId?: string;
}
export interface ArtifactsPublishOutput {
  artifactId: string;
  version: number;
  /** The stored title, so a person's rename shows (C5). */
  title: string;
  kind: ArtifactKind;
  extension: string;
}
export const ArtifactsPublishOutputSchema = z.object({
  artifactId: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  kind: ArtifactKindSchema,
  extension: z.string(),
}) as ZodType<ArtifactsPublishOutput>;

// --- artifacts:list / get / read -------------------------------------------

export interface ArtifactsListInput {
  agentId: string;
}
export interface ArtifactsListOutput {
  artifacts: ArtifactSummary[];
}
export const ArtifactsListOutputSchema = z.object({
  artifacts: z.array(ArtifactSummarySchema),
}) as ZodType<ArtifactsListOutput>;

export interface ArtifactsGetInput {
  artifactId: string;
}
export interface ArtifactsGetOutput {
  artifact: ArtifactDetail;
}
export const ArtifactsGetOutputSchema = z.object({
  artifact: z.object({ ...ArtifactSummaryShape, versions: z.array(ArtifactVersionInfoSchema) }),
}) as ZodType<ArtifactsGetOutput>;

export interface ArtifactsReadInput {
  artifactId: string;
  /** Defaults to the current version. */
  version?: number;
}
export interface ArtifactsReadOutput {
  bytes: Uint8Array;
  mediaType: string;
  preview: ArtifactPreview;
  sizeBytes: number;
  /** The title plus the type's extension: a name to save the download under. */
  filename: string;
  version: number;
}
export const ArtifactsReadOutputSchema = z.object({
  bytes: z.instanceof(Uint8Array),
  mediaType: z.string(),
  preview: ArtifactPreviewSchema,
  sizeBytes: z.number().int().nonnegative(),
  filename: z.string(),
  version: z.number().int().positive(),
}) as ZodType<ArtifactsReadOutput>;

// --- artifacts:rename / restore / delete -----------------------------------

export interface ArtifactsRenameInput {
  artifactId: string;
  title: string;
}
export interface ArtifactsRestoreInput {
  artifactId: string;
  version: number;
}
export interface ArtifactsSummaryOutput {
  artifact: ArtifactSummary;
}
export const ArtifactsSummaryOutputSchema = z.object({
  artifact: ArtifactSummarySchema,
}) as ZodType<ArtifactsSummaryOutput>;

export interface ArtifactsDeleteInput {
  artifactId: string;
}
export interface ArtifactsDeleteOutput {
  deleted: true;
}
export const ArtifactsDeleteOutputSchema = z.object({
  deleted: z.literal(true),
}) as ZodType<ArtifactsDeleteOutput>;
