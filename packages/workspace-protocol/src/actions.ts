import { z } from 'zod';

export type WorkspaceActionName =
  | 'workspace.apply'
  | 'workspace.read'
  | 'workspace.list'
  | 'workspace.diff';

// Wire-side change shape: bytes go as base64 strings.
// `.strict()` lives on each branch (discriminatedUnion has no top-level
// strict; the per-branch strictness still rejects extras at parse time).
const WireFileChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    path: z.string(),
    kind: z.literal('put'),
    contentBase64: z.string(),
  }).strict(),
  z.object({
    path: z.string(),
    kind: z.literal('delete'),
  }).strict(),
]);

export const WorkspaceApplyRequestSchema = z.object({
  changes: z.array(WireFileChangeSchema),
  parent: z.string().nullable(),
  reason: z.string().optional(),
}).strict();

const WireWorkspaceChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    path: z.string(),
    kind: z.literal('added'),
    contentAfterBase64: z.string(),
  }).strict(),
  z.object({
    path: z.string(),
    kind: z.literal('modified'),
    contentBeforeBase64: z.string(),
    contentAfterBase64: z.string(),
  }).strict(),
  z.object({
    path: z.string(),
    kind: z.literal('deleted'),
    contentBeforeBase64: z.string(),
  }).strict(),
]);

const WireDeltaSchema = z.object({
  before: z.string().nullable(),
  after: z.string(),
  changes: z.array(WireWorkspaceChangeSchema),
  reason: z.string().optional(),
  author: z.object({
    agentId: z.string(),
    userId: z.string(),
    sessionId: z.string(),
  }).optional(),
}).strict();

export const WorkspaceApplyResponseSchema = z.object({
  version: z.string(),
  delta: WireDeltaSchema,
}).strict();

export const WorkspaceReadRequestSchema = z.object({
  path: z.string(),
  version: z.string().optional(),
}).strict();

export const WorkspaceReadResponseSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(true), bytesBase64: z.string() }).strict(),
  z.object({ found: z.literal(false) }).strict(),
]);

export const WorkspaceListRequestSchema = z.object({
  pathGlob: z.string().optional(),
  version: z.string().optional(),
}).strict();

export const WorkspaceListResponseSchema = z.object({
  paths: z.array(z.string()),
}).strict();

export const WorkspaceDiffRequestSchema = z.object({
  from: z.string().nullable(),
  to: z.string(),
}).strict();

export const WorkspaceDiffResponseSchema = z.object({
  delta: WireDeltaSchema,
}).strict();

export const WORKSPACE_ACTION_PATHS: Record<WorkspaceActionName, string> = {
  'workspace.apply': '/workspace.apply',
  'workspace.read': '/workspace.read',
  'workspace.list': '/workspace.list',
  'workspace.diff': '/workspace.diff',
};
