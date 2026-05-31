export { createConnectorsPlugin } from './plugin.js';
export type { ConnectorsConfig } from './plugin.js';
export {
  ActivateAuthoredOutputSchema,
  CapabilitiesSchema,
  ClearAuthoredOutputSchema,
  DeleteOutputSchema,
  GetOutputSchema,
  InstallAuthoredOutputSchema,
  ListAuthoredOutputSchema,
  ListDefaultsOutputSchema,
  ListOutputSchema,
  ResolveOutputSchema,
  UpsertOutputSchema,
} from './types.js';
export type {
  ActivateAuthoredInput,
  ActivateAuthoredOutput,
  AuthoredConnectorDraftDescriptor,
  AuthoredConnectorSlot,
  Capabilities,
  CapabilitySlot,
  ClearAuthoredInput,
  ClearAuthoredOutput,
  Connector,
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
  ListDefaultsInput,
  ListDefaultsOutput,
  ListInput,
  ListOutput,
  McpServerSpec,
  PackagesSpec,
  ResolveInput,
  ResolveOutput,
  UpsertInput,
  UpsertOutput,
  Visibility,
} from './types.js';
export { runConnectorsMigration } from './migrations.js';
export type {
  ConnectorDatabase,
  ConnectorsAuthoredRow,
  ConnectorsRow,
} from './migrations.js';
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
