import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { getSkillOrNull } from '@/lib/skills';
import { decideCatalogRequest } from '@/lib/catalog';
import { compareBundles, reconstructSkillMd, type BundleFileEntry } from '@/lib/bundle-diff';
import { BundleDiffView } from './BundleDiffView';
import type { CatalogRequest } from '@ax/skills';

export interface BundleReviewDialogProps {
  request: CatalogRequest;
  onClose: () => void;
  onDecided: () => void;
}

/** Build a path→contents map from a request's snapshot (SKILL.md first). */
function submittedFiles(req: CatalogRequest): Record<string, string> {
  const map: Record<string, string> = {};
  if (req.manifestYaml !== null && req.bodyMd !== null) {
    map['SKILL.md'] = reconstructSkillMd(req.manifestYaml, req.bodyMd);
  }
  for (const f of req.files) map[f.path] = f.contents;
  return map;
}

export function BundleReviewDialog({ request, onClose, onDecided }: BundleReviewDialogProps) {
  const isShare = request.kind === 'share' && request.manifestYaml !== null;
  const [entries, setEntries] = useState<BundleFileEntry[] | null>(isShare ? null : []);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    if (!isShare) return;
    let cancelled = false;
    void (async () => {
      try {
        // Diff the submitted bundle against the current catalog version (if any).
        const current = await getSkillOrNull(request.skillId);
        if (cancelled) return;
        const before: Record<string, string> = {};
        if (current !== null) {
          before['SKILL.md'] = reconstructSkillMd(current.manifestYaml, current.bodyMd);
          for (const f of current.files) before[f.path] = f.contents;
        }
        setEntries(compareBundles(before, submittedFiles(request)));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request, isShare]);

  async function decide(decision: 'admit' | 'reject') {
    setDeciding(true);
    setError(null);
    try {
      await decideCatalogRequest(request.requestId, decision);
      onDecided();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeciding(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            Review {request.kind} request: {request.skillId}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{request.description}</p>

          {!isShare ? (
            <Alert>
              <AlertDescription>
                Cold-start request — there is no bundle to promote. Author the skill in the Catalog
                tab, then reject this request to clear it.
              </AlertDescription>
            </Alert>
          ) : entries === null ? (
            <p className="text-sm text-muted-foreground">Loading bundle…</p>
          ) : (
            <BundleDiffView entries={entries} />
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={deciding}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void decide('reject')} disabled={deciding}>
              Reject
            </Button>
            <Button onClick={() => void decide('admit')} disabled={deciding || !isShare}>
              Admit
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
