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

/** Build a path→contents map from a request's snapshot (SKILL.md first).
 *
 * Uses a NULL-PROTOTYPE map: a submitted bundle path is untrusted and the magic
 * keys (proto/constructor/prototype) are all VALID bundle paths (lowercase + the
 * server PATH_RE accepts them) that catalog:admit promotes verbatim. On a plain
 * object map, assigning the proto magic key hits the prototype setter instead of
 * creating an own key, so `Object.keys` (used by compareBundles) would silently
 * drop that file from the review diff — admitted but never shown to the
 * reviewer. `Object.create(null)` makes every path a plain own key. */
function submittedFiles(req: CatalogRequest): Record<string, string> {
  const map = Object.create(null) as Record<string, string>;
  if (req.manifestYaml !== null && req.bodyMd !== null) {
    map['SKILL.md'] = reconstructSkillMd(req.manifestYaml, req.bodyMd);
  }
  for (const f of req.files) map[f.path] = f.contents;
  return map;
}

export function BundleReviewDialog({ request, onClose, onDecided }: BundleReviewDialogProps) {
  const isShare = request.kind === 'share' && request.manifestYaml !== null;
  const [entries, setEntries] = useState<BundleFileEntry[] | null>(isShare ? null : []);
  // loadError = the bundle couldn't be assembled for review (blocks Admit — you
  // can't admit bytes you couldn't see). decideError = the admit/reject call
  // itself failed (post-review; doesn't block re-trying).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    if (!isShare) return;
    let cancelled = false;
    void (async () => {
      try {
        // Diff the submitted bundle against the current catalog version (if any).
        const current = await getSkillOrNull(request.skillId);
        if (cancelled) return;
        // Null-prototype for the same magic-key reason as submittedFiles().
        const before = Object.create(null) as Record<string, string>;
        if (current !== null) {
          before['SKILL.md'] = reconstructSkillMd(current.manifestYaml, current.bodyMd);
          for (const f of current.files) before[f.path] = f.contents;
        }
        setEntries(compareBundles(before, submittedFiles(request)));
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request, isShare]);

  async function decide(decision: 'admit' | 'reject') {
    setDeciding(true);
    setDecideError(null);
    try {
      await decideCatalogRequest(request.requestId, decision);
      onDecided();
    } catch (err) {
      setDecideError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeciding(false);
    }
  }

  const error = loadError ?? decideError;

  // Admit promotes the submitted (untrusted) bytes org-wide, so it must be
  // gated on the reviewer having actually SEEN them: only enable once this is
  // a share AND the diff loaded successfully (entries !== null) AND there was
  // no load error. Otherwise an admin could admit from the loading/error state
  // and bypass the review surface this dialog exists to enforce. A *decide*
  // error (the admit/reject call failed) does not block — the bytes were seen.
  const canAdmit = isShare && entries !== null && loadError === null && !deciding;

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
            <Button onClick={() => void decide('admit')} disabled={!canAdmit}>
              Admit
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
