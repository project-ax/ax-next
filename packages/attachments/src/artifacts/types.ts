/**
 * Hook I/O for the artifact owner hooks (`artifacts:*`), with their runtime
 * `returns` contracts.
 *
 * What never appears here: the source path, and the share code outside
 * `artifacts:set-link`. The code is a capability (§6.3): only its owner gets it
 * back, from set-link, to copy the link. The path is the agent's own file
 * layout (C2); it leaves this plugin only back to the agent, through the augment.
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

/**
 * Two forms. By id (members only): any retained version, the current one by
 * default. By share code (anyone signed in who holds the link): the current
 * version and nothing else.
 */
export type ArtifactsReadInput =
  | {
      artifactId: string;
      /** Defaults to the current version. */
      version?: number;
    }
  | { shareCode: string };
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


// --- artifacts:set-link / resolve-share-code -------------------------------

/** `ensure` is Copy link (mint once, then the same code); `rotate` is Get new link; `off` turns it off. */
export type ArtifactLinkAction = 'ensure' | 'off' | 'rotate';

export interface ArtifactsSetLinkInput {
  artifactId: string;
  action: ArtifactLinkAction;
}
/**
 * The code now in force, null when the link is off. Owner-only, and the only
 * hook whose answer carries a code: the owner needs it to copy the link.
 */
export interface ArtifactsSetLinkOutput {
  shareCode: string | null;
}
export const ArtifactsSetLinkOutputSchema = z.object({
  shareCode: z.string().nullable(),
}) as ZodType<ArtifactsSetLinkOutput>;

/**
 * What a link holder sees: the current version's metadata. No artifact id, no
 * versions, no code, no path.
 */
export interface SharedArtifactView {
  title: string;
  mediaType: string;
  kind: ArtifactKind;
  preview: ArtifactPreview;
  extension: string;
  sizeBytes: number;
  updatedAt: string;
  /** The agent's display name; null when it cannot be looked up (the page says "an agent"). */
  agentName: string | null;
}

export interface ArtifactsResolveShareCodeInput {
  shareCode: string;
}
export interface ArtifactsResolveShareCodeOutput {
  artifact: SharedArtifactView;
}
export const ArtifactsResolveShareCodeOutputSchema = z.object({
  artifact: z.object({
    title: z.string(),
    mediaType: z.string(),
    kind: ArtifactKindSchema,
    preview: ArtifactPreviewSchema,
    extension: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    updatedAt: z.string(),
    agentName: z.string().nullable(),
  }),
}) as ZodType<ArtifactsResolveShareCodeOutput>;

// --- artifacts:mint-view-token ---------------------------------------------

/**
 * Two forms, as `artifacts:read`. By id (members): any retained version. By
 * share code (a signed-in link holder): the current version, and the token is
 * bound to that code. `view` is for an inline preview (HTML or an image);
 * `download` for any type.
 */
export type ArtifactsMintViewTokenInput =
  | { artifactId: string; version: number; purpose: 'view' | 'download' }
  | { shareCode: string; purpose: 'view' | 'download' };
/** A content-origin URL that serves one version for a few minutes. Never carries the share code. */
export interface ArtifactsMintViewTokenOutput {
  url: string;
  /** ISO 8601. */
  expiresAt: string;
}
export const ArtifactsMintViewTokenOutputSchema = z.object({
  url: z.string(),
  expiresAt: z.string(),
}) as ZodType<ArtifactsMintViewTokenOutput>;
