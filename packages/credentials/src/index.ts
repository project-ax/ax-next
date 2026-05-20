export { refForDestination, type Destination } from './refs.js';
export {
  KNOWN_DESTINATION_FIXTURES,
  type DestinationFixture,
} from './refs-fixtures.js';
export {
  createCredentialsPlugin,
  validateScope,
  validateOwnerIdForScope,
  SCOPE_VALUES,
} from './plugin.js';
export type {
  CredentialScope,
  CredentialsGetInput,
  CredentialsGetOutput,
  CredentialsSetInput,
  CredentialsSetOutput,
  CredentialsDeleteInput,
  CredentialsDeleteOutput,
  CredentialsResolveInput,
  CredentialsResolveOutput,
  CredentialsListInput,
  CredentialsListOutput,
  CredentialsListKindsOutput,
  CredentialMeta,
  CredentialsPluginConfig,
  CredentialsEnvelopeEncryptInput,
  CredentialsEnvelopeEncryptOutput,
  CredentialsEnvelopeDecryptInput,
  CredentialsEnvelopeDecryptOutput,
} from './plugin.js';
