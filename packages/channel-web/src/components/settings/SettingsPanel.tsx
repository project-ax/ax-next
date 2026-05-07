/**
 * SettingsPanel — modal chrome for the per-user "My credentials" view.
 *
 * Mirrors AdminPanel chrome (overlay click-outside closes; × button
 * closes; role="dialog" + aria-modal="true"), but the body is fixed
 * to user-scope credentials (no view router — for now there's only
 * one settings surface).
 *
 * Reuses the shared `components/credentials/*` widgets in `variant="user"`,
 * which routes them at `/settings/credentials*` — the actor's own
 * credentials only, regardless of role. Available to every signed-in
 * user (the user menu mounts the entry without an isAdmin gate).
 *
 * Escape-to-close and focus-trap polish are deferred (matches AdminPanel —
 * low-traffic panel, design-handoff doesn't lean on them).
 */
import { useState } from 'react';
import { CredentialsList } from '../credentials/CredentialsList';
import { CredentialAddMenu } from '../credentials/CredentialAddMenu';

export function SettingsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  // Bumped on each successful credential add → CredentialsList re-fetches.
  // Same idiom as AdminPanel — keeps the list and the add menu as
  // siblings without prop-drilling a parent state.
  const [credentialsRefreshKey, setCredentialsRefreshKey] = useState(0);
  if (!open) return null;
  return (
    <div
      className="settings-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-panel-title"
      >
        <div className="settings-panel-header">
          <h2 id="settings-panel-title" className="settings-panel-title">
            My credentials
          </h2>
          <button
            type="button"
            className="settings-panel-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="settings-panel-body">
          <div className="credentials-panel">
            <CredentialAddMenu
              variant="user"
              onAdded={() => setCredentialsRefreshKey((n) => n + 1)}
            />
            <CredentialsList
              variant="user"
              refreshKey={credentialsRefreshKey}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
