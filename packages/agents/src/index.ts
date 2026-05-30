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
// CLI composition root uses listAuthoredBundles + AuthoredProjectionBundle to
// register agents:resolve-authored-skills in the dev-agents stub (app wiring —
// not a plugin-to-plugin import — see dev-agents-stub.ts).
export {
  listAuthoredBundles,
  type AuthoredProjectionBundle,
  type AuthoredBundleFile,
} from './authored-skills.js';
// Shared pure helper: parse + intersect + caps-strip one authored bundle.
// Used by the real resolver (plugin.ts) and the CLI dev stub (dev-agents-stub.ts).
export {
  projectAuthoredBundle,
  intersectProposalWithApproved,
  EMPTY_CAPABILITIES,
} from './authored-caps.js';
export type { ApprovedCapEntry } from './authored-caps.js';
