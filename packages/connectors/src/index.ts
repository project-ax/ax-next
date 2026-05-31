export { createConnectorsPlugin } from './plugin.js';
export type { ConnectorsConfig } from './plugin.js';
export {
  CapabilitiesSchema,
  DeleteOutputSchema,
  GetOutputSchema,
  ListOutputSchema,
  ResolveOutputSchema,
  UpsertOutputSchema,
} from './types.js';
export type {
  Capabilities,
  CapabilitySlot,
  Connector,
  ConnectorSummary,
  DeleteInput,
  DeleteOutput,
  GetInput,
  GetOutput,
  KeyMode,
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
export type { ConnectorDatabase, ConnectorsRow } from './migrations.js';
export { createConnectorStore } from './store.js';
export type { ConnectorStore, UpsertArgs } from './store.js';
export { scopedConnectors } from './scope.js';
export type { ConnectorScope } from './scope.js';
export {
  deriveCredentialPlan,
  requiresSharedKeyConsent,
  serviceTagForSlot,
  accountRef,
  sharedKeyConsentMessage,
  SHARED_KEY_CONSENT_COPY,
} from './credential-plan.js';
export type { CredentialPlanEntry, CredentialScope } from './credential-plan.js';
