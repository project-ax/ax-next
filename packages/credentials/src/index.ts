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
  CREDENTIALS_AUTHORIZE_GLOBAL_ACCOUNT_HOOK,
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
  CredentialsAuthorizeGlobalInput,
  CredentialsAuthorizeGlobalOutput,
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
