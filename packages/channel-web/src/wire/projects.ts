import { z } from 'zod';

// ---------------------------------------------------------------------------
// @ax/channel-web wire schemas — `/api/workspace/projects*` (W3a, W3 spec §4.8).
//
// The request schemas are STRICT: the actor is the authenticated session, so a
// body that tries to name a `userId` (or anything else) is a 400, not a field
// we quietly ignore. They check SHAPE only — `@ax/projects` owns the content
// rules (name 1–80 chars on one line, description ≤ 500 chars, no control
// characters) and normalizes before it stores, so there is one definition of
// "a valid name" and it lives with the data. Its `invalid-payload` comes back
// as a 400 too.
//
// The length caps here are generous transport bounds, not the content rule:
// they keep an absurd body from reaching the hook at all.
//
// Boundary review: field names (`projectId`, `name`, `description`,
// `ownerAgentId`, `role`) are domain vocabulary. Nothing names the folder
// backend — `folderId` is deliberately NOT on any response: the browser never
// needs it, and an id the browser never sees is an id it can never send back.
// ---------------------------------------------------------------------------

/** Mirrors `@ax/projects`' lenient id bound (an over-long id is just unknown). */
export const PROJECT_ID_MAX_CHARS = 128;
const TEXT_MAX_CHARS = 4096;

export const ProjectIdSchema = z.string().min(1).max(PROJECT_ID_MAX_CHARS);

export const CreateProjectRequest = z
  .object({
    name: z.string().max(TEXT_MAX_CHARS),
    description: z.string().max(TEXT_MAX_CHARS).optional(),
    ownerAgentId: z.string().min(1).max(256),
  })
  .strict();
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const UpdateProjectRequest = z
  .object({
    name: z.string().max(TEXT_MAX_CHARS).optional(),
    /** A string replaces it; `null` (or a blank string) clears it. */
    description: z.string().max(TEXT_MAX_CHARS).nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'nothing to update',
  });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

export type ProjectMemberRole = 'owner' | 'editor' | 'viewer';

/** `GET /api/workspace/projects` — one row per project the person can use. */
export interface ProjectSummary {
  projectId: string;
  name: string;
  description: string | null;
  /** ISO-8601. The project row's `updated_at` ("Updated 2h ago"). */
  updatedAt: string;
  /** Only the member agents this person can use, with their roles. */
  members: Array<{ agentId: string; role: ProjectMemberRole }>;
}
export interface ListProjectsResponse {
  projects: ProjectSummary[];
}

export interface CreateProjectResponse {
  projectId: string;
}

/** `GET /api/workspace/projects/:projectId`. */
export interface ProjectDetail {
  projectId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Owner first. `displayName` is present only for agents this person can
   * see in their own agent list — an agent they can't see is never named.
   */
  members: Array<{ agentId: string; role: ProjectMemberRole; displayName?: string }>;
  /** May this person rename or delete it (manage the owner agent)? */
  canManage: boolean;
}

/** `PATCH /api/workspace/projects/:projectId`. */
export interface UpdateProjectResponse {
  projectId: string;
  name: string;
  description: string | null;
  updatedAt: string;
}

/** `GET /api/workspace/projects/:projectId/conversations` — this person's chats in it. */
export interface ProjectConversation {
  conversationId: string;
  agentId: string;
  title: string | null;
  /** ISO-8601: last activity, else creation. */
  lastActivityAt: string;
}
export interface ProjectConversationsResponse {
  conversations: ProjectConversation[];
}

/**
 * `GET /api/workspace/projects/owner-candidates` — the agents this person
 * manages, most recently used first. The first is the default owner of a new
 * project (W3 §15 Q5).
 */
export interface OwnerCandidatesResponse {
  agents: Array<{ agentId: string; displayName: string }>;
}

/** A chat's project, as labelled in the agent detail (W3 §15 Q6). */
export interface ProjectLabel {
  projectId: string;
  name: string;
}
