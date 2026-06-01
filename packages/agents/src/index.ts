export { createAgentsPlugin } from './plugin.js';
export {
  runAgentsMigration,
  type AgentsDatabase,
  type AgentsRow,
} from './migrations.js';
export {
  createAgentStore,
  mintAgentId,
  resolveAllowedModels,
  validateCreateInput,
  validateUpdatePatch,
  type AgentStore,
} from './store.js';
export { scopedAgents, type AgentScope } from './scope.js';
export { checkAccess, type AclResult } from './acl.js';
export type {
  Actor,
  Agent,
  AgentInput,
  AgentsConfig,
  AgentsCreatedEvent,
  AgentsResolvedEvent,
  CreateInput,
  CreateOutput,
  DeleteInput,
  DeleteOutput,
  ListForUserInput,
  ListForUserOutput,
  ResolveInput,
  ResolveOutput,
  UpdateInput,
  UpdateOutput,
} from './types.js';
// Shared pure helper: parse one authored bundle into its promote/projection
// shape (description + connectors). Used by the real resolver (plugin.ts) and
// the CLI dev stub (dev-agents-stub.ts). TASK-100 — the proposal∩approved
// intersect + EMPTY_CAPABILITIES are gone (a skill declares no capabilities).
export { projectAuthoredBundle } from './authored-caps.js';
export type { ApprovedCapEntry } from './authored-caps.js';
