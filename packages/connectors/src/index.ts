export { createConnectorsPlugin } from './plugin.js';
export type { ConnectorsConfig } from './plugin.js';
export {
  ActivateAuthoredOutputSchema,
  AuthorizeAgentOutputSchema,
  AuthorizeGlobalOutputSchema,
  CapabilitiesSchema,
  ClearAuthoredOutputSchema,
  ClearLegacyDefaultOutputSchema,
  DeleteOutputSchema,
  GetOutputSchema,
  InstallAuthoredOutputSchema,
  ListAuthoredOutputSchema,
  ListEffectiveOutputSchema,
  ListLegacyDefaultsOutputSchema,
  ListOutputSchema,
  ResolveOutputSchema,
  ToolLabelsOutputSchema,
  UpsertOutputSchema,
} from './types.js';
export type {
  ActivateAuthoredInput,
  ActivateAuthoredOutput,
  AuthorizeAgentInput,
  AuthorizeAgentOutput,
  AuthorizeGlobalInput,
  AuthorizeGlobalOutput,
  AuthoredConnectorDraftDescriptor,
  AuthoredConnectorSlot,
  Capabilities,
  CapabilitySlot,
  ClearAuthoredInput,
  ClearAuthoredOutput,
  ClearLegacyDefaultInput,
  ClearLegacyDefaultOutput,
  Connector,
  ConnectorDeletedEvent,
  ConnectorToolNamespacesChangedEvent,
  ConnectorSummary,
  DeleteInput,
  DeleteOutput,
  GetInput,
  GetOutput,
  InstallAuthoredInput,
  InstallAuthoredOutput,
  KeyMode,
  ListAuthoredInput,
  ListAuthoredOutput,
  ListEffectiveInput,
  ListEffectiveOutput,
  EffectiveConnectorEntry,
  EffectiveConnectorSource,
  ListInput,
  ListLegacyDefaultsInput,
  ListLegacyDefaultsOutput,
  ListOutput,
  McpServerSpec,
  OAuthCapabilitySlot,
  PackagesSpec,
  ResolveInput,
  ResolveOutput,
  ToolLabelsInput,
  ToolLabelsOutput,
  UpsertInput,
  UpsertOutput,
  Visibility,
} from './types.js';
export { authorizeAgentAccountRead, authorizeGlobalAccountRead } from './credential-authz.js';
export { runConnectorsMigration } from './migrations.js';
export type {
  ConnectorDatabase,
  ConnectorsAuthoredRow,
  ConnectorsRow,
} from './migrations.js';
export {
  TOOL_NAMESPACE_RE,
  deriveToolNamespace,
  deriveToolNamespaces,
  diffToolNamespaces,
} from './tool-namespace.js';
export type { ToolNamespaceChange, ToolNamespaceEntry } from './tool-namespace.js';
export { createConnectorStore } from './store.js';
export type { ConnectorStore, UpsertArgs } from './store.js';
export { createAuthoredConnectorsStore } from './authored-store.js';
export type {
  AuthoredConnectorDraft,
  AuthoredConnectorsStore,
  AuthoredConnectorStatus,
  UpsertAuthoredConnectorInput,
} from './authored-store.js';
export { scopedConnectors, scopedAuthoredConnectors } from './scope.js';
export type { ConnectorScope, AuthoredConnectorScope } from './scope.js';
export {
  deriveCredentialPlan,
  requiresSharedKeyConsent,
  serviceTagForSlot,
  accountRef,
  sharedKeyConsentMessage,
  SHARED_KEY_CONSENT_COPY,
} from './credential-plan.js';
export type { CredentialPlanEntry, CredentialScope } from './credential-plan.js';
