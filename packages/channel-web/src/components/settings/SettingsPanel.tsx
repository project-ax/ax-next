/**
 * SettingsPanel — modal chrome for the per-user "Credentials" view.
 *
 * The body is fixed to user-scope credentials (no view router — for now
 * there's only one settings surface). Reuses the shared
 * `components/credentials/*` widgets in `variant="user"`.
 */
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  // Same idiom as the settings shell — keeps the list and the add menu as
  // siblings without prop-drilling a parent state.
  const [credentialsRefreshKey, setCredentialsRefreshKey] = useState(0);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[640px] font-sans">
        <DialogHeader>
          <DialogTitle id="settings-panel-title">Credentials</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 mt-2">
          <CredentialAddMenu
            variant="user"
            onAdded={() => setCredentialsRefreshKey((n) => n + 1)}
          />
          <CredentialsList
            variant="user"
            refreshKey={credentialsRefreshKey}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
