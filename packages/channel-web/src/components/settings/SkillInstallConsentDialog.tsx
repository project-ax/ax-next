/**
 * SkillInstallConsentDialog — the capability-consent moment shown when a user
 * self-installs a skill from the workspace catalog (Skills app-store, TASK-126).
 *
 * Same posture as {@link ConnectorConnectDialog}: before the user-scoped attach
 * completes, show what the skill is and what reach it brings, then let the user
 * confirm. A skill declares NO capability block of its own (TASK-100) — its
 * reach is the connectors it references — so the consent surface lists those
 * connectors. The item is admin-vetted (it's on the workspace catalog), so this
 * is a consent card, NOT an approval wall: confirming writes the attachment
 * directly (design §#5 / card acceptance).
 *
 * SECURITY: no secret is entered here — a skill's keys live on its connectors,
 * connected separately under Connectors. The attach is server-forced to the
 * caller's identity and validated against the global catalog (routes-connections
 * `attach`); the browser cannot install an arbitrary id. Untrusted text
 * (description / connector ids) renders through React text nodes (auto-escaped).
 *
 * shadcn primitives + semantic tokens only (invariant #6).
 */
import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  attachConnectionSkill,
  type CatalogSkillListing,
} from '@/lib/connections';

export interface SkillInstallConsentDialogProps {
  skill: CatalogSkillListing;
  /** The agent the skill is being installed onto (the app-store's current agent). */
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the attach succeeds, so the caller can re-list. */
  onInstalled: () => void;
}

export function SkillInstallConsentDialog({
  skill,
  agentId,
  open,
  onOpenChange,
  onInstalled,
}: SkillInstallConsentDialogProps) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset transient state each time the dialog opens.
  useEffect(() => {
    if (open) {
      setInstalling(false);
      setError(null);
    }
  }, [open]);

  async function handleInstall(): Promise<void> {
    setInstalling(true);
    setError(null);
    try {
      await attachConnectionSkill(agentId, skill.skillId);
      onInstalled();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!installing) onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install {skill.skillId}</DialogTitle>
          <DialogDescription>{skill.description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            This skill is from your workspace's vetted catalog. Installing it adds
            it to this assistant — only you can see your copy.
          </p>
          {skill.connectors.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">Uses these services</p>
              <div className="flex flex-wrap gap-1.5">
                {skill.connectors.map((c) => (
                  <Badge key={c} variant="secondary">
                    {c}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                You'll connect any that need a key under Connectors.
              </p>
            </div>
          )}
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={installing}
            >
              Cancel
            </Button>
            <Button onClick={() => void handleInstall()} disabled={installing}>
              {installing ? 'Installing…' : 'Install'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
