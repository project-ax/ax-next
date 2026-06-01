/**
 * CredentialsTab — the Settings "Credentials" surface (connectors-first-class
 * UI/IA reorg). This collapses the audit's "Keys" + "Providers" into one
 * **Credentials** tab: a credential is a key/secret — the wallet your agents
 * spend without ever seeing it.
 *
 * The implementation IS the existing per-user vault (`KeysTab`): service-keyed
 * `account:<service>` rows + back-compat per-skill-slot rows, all metadata-only
 * (the secret never reaches the client). Renamed here so the IA reads as
 * Skills · Connectors · Credentials; behavior is unchanged.
 *
 * Credentials carry NO source badge — there is nothing to make visible (the
 * value is always hidden). Reach derives purely from where the key is attached
 * (design: "reach by attachment, never by visibility").
 */
import { KeysTab } from './KeysTab';

export function CredentialsTab() {
  return <KeysTab />;
}
