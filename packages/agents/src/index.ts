export { createAgentsPlugin } from './plugin.js';
export {
  runAgentsMigration,
  type AgentsDatabase,
  type AgentsIdentityRow,
  type AgentsRow,
} from './migrations.js';
// TASK-989 — the identity hooks' contract (names, caps, outcome schemas).
// TASK-990 — plus the agents' own changes to themselves, for Today.
export {
  AGENTS_IDENTITY_COMPLETE_BOOTSTRAP_HOOK,
  AGENTS_IDENTITY_GET_HOOK,
  AGENTS_IDENTITY_SELF_CHANGES_FOR_USER_HOOK,
  AGENTS_IDENTITY_SET_HOOK,
  AgentIdentityRecordSchema,
  IDENTITY_SCAN_HOOK,
  IDENTITY_SECTIONS,
  INSTRUCTIONS_MAX_CHARS,
  IdentityCompleteBootstrapOutputSchema,
  IdentityGetOutputSchema,
  IdentitySelfChangesForUserOutputSchema,
  IdentitySetOutputSchema,
  SELF_CHANGE_WINDOW_DAYS,
  SELF_SECTIONS,
  type AgentIdentityRecord,
  type BootstrapState,
  type CreateBootstrap,
  type IdentityCompleteBootstrapInput,
  type IdentityCompleteBootstrapOutput,
  type IdentityGetInput,
  type IdentityGetOutput,
  type IdentityRefusalCode,
  type IdentitySection,
  type IdentitySelfChange,
  type IdentitySelfChangesForUserInput,
  type IdentitySelfChangesForUserOutput,
  type IdentitySetInput,
  type IdentitySetOutput,
  type SelfSection,
} from './types.js';
// TASK-989 — the agent's own identity tools.
export {
  COMPLETE_BOOTSTRAP_DESCRIPTOR,
  COMPLETE_BOOTSTRAP_TOOL,
  UPDATE_IDENTITY_DESCRIPTOR,
  UPDATE_IDENTITY_TOOL,
  type CompleteBootstrapError,
  type CompleteBootstrapResult,
  type UpdateIdentityError,
  type UpdateIdentityResult,
} from './identity/tools.js';
export {
  createAgentStore,
  mintAgentId,
  resolveAllowedModels,
  validateCreateInput,
  validateUpdatePatch,
  SUPPORTED_RUNNERS,
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
  AgentsDeletedEvent,
  AgentsResolvedEvent,
  AttachConnectorInput,
  AttachConnectorOutput,
  CanManageRoutinesInput,
  CanManageRoutinesOutput,
  CanManageConnectorsInput,
  CanManageConnectorsOutput,
  CanSetSharedCredentialInput,
  CanSetSharedCredentialOutput,
  DetachConnectorInput,
  DetachConnectorOutput,
  CreateInput,
  CreateOutput,
  DeleteInput,
  DeleteOutput,
  ListForUserInput,
  ListForUserOutput,
  ResolveInput,
  ResolveOutput,
  RunnerId,
  UpdateInput,
  UpdateOutput,
} from './types.js';
// Shared pure helper: parse one authored bundle into its promote/projection
// shape (description + connectors). Used by the real resolver (plugin.ts) and
// the CLI dev stub (dev-agents-stub.ts). TASK-100 — the proposal∩approved
// intersect + EMPTY_CAPABILITIES are gone (a skill declares no capabilities).
export { projectAuthoredBundle } from './authored-caps.js';
