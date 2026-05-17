/**
 * RoutinesPanel — modal chrome for the per-user "Routines" view.
 *
 * Mirror of SettingsPanel/CredentialsList: a Dialog with a list inside.
 * Phase D is observability-only — no create/edit/delete on the spec
 * itself (those live in the routine file, edited via chat/git). What
 * this surface DOES expose:
 *
 *   - The routines the user can see across their agents
 *   - Last status + last-run-time on each
 *   - Expand a row → last 20 fire rows with the rendered prompt that
 *     was actually sent (kept on `routines_v1_fires.rendered_prompt`,
 *     added in Phase D)
 *   - Fire now button: interval/cron → immediate; webhook → expand an
 *     inline JSON payload form (no nested-modal awkwardness)
 *
 * Server-supplied strings (routine names, errors, rendered prompts) all
 * render as plain text via React's default escaping. Prompts are
 * monospace + truncated; nothing here injects HTML.
 */
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RoutinesList } from './RoutinesList';

export function RoutinesPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  // Bumped after a Fire now call so RoutinesList re-fetches. Same
  // refresh-key idiom as SettingsPanel.
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[720px] font-sans">
        <DialogHeader>
          <DialogTitle id="routines-panel-title">Routines</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col mt-2 max-h-[60vh] overflow-y-auto">
          <RoutinesList
            refreshKey={refreshKey}
            onFired={() => setRefreshKey((n) => n + 1)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
