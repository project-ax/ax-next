/**
 * AwaitingReviewSection — the admin "Skills awaiting review" admit queue, folded
 * INLINE into the Skills app-store (TASK-126). This is the logic that formerly
 * lived in the standalone admin `AdmitQueueTab` (deleted in TASK-138): list
 * pending admit-to-catalog requests
 * (cold-start "a user needed X" + share-to-catalog submissions) and review each
 * one, where admitting means a CODE REVIEW of the submitted untrusted bundle
 * bytes (BundleReviewDialog).
 *
 * Rendered only when `isAdmin` (the parent gates it) — and every /admin/catalog/*
 * route is role-gated server-side regardless, so this is UX convenience. It
 * collapses to a single "Awaiting review (n)" affordance so it reads as a calm
 * inline control rather than a second nav surface (design card 3).
 *
 * Untrusted text (skill id / description / requester id) renders through React
 * text nodes (auto-escaped) — never raw HTML.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { listCatalogRequests } from '@/lib/catalog';
import type { CatalogRequest } from '@ax/skills';
import { BundleReviewDialog } from '@/components/admin/BundleReviewDialog';

export function AwaitingReviewSection({ onReviewed }: { onReviewed: () => void }) {
  const [requests, setRequests] = useState<CatalogRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [reviewing, setReviewing] = useState<CatalogRequest | null>(null);

  async function refresh(): Promise<void> {
    setError(null);
    try {
      setRequests(await listCatalogRequests());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRequests([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const count = requests?.length ?? 0;

  return (
    <div className="flex flex-col gap-2 pt-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="self-start text-sm text-muted-foreground hover:text-foreground"
      >
        {expanded ? '▾' : '▸'} Awaiting review ({count})
      </button>

      {expanded && (
        <div className="flex flex-col gap-2">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {requests === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No pending requests. Cold-start and submit-to-workspace requests land
              here.
            </p>
          ) : (
            requests.map((r) => (
              <div
                key={r.requestId}
                className="flex items-start justify-between gap-3 rounded-md border border-border p-3"
              >
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={r.kind === 'share' ? 'secondary' : 'outline'}
                      className="text-[10px]"
                    >
                      {r.kind}
                    </Badge>
                    <span className="font-mono text-xs">{r.skillId}</span>
                  </div>
                  <p className="text-sm">{r.description}</p>
                  <p className="text-xs text-muted-foreground">
                    requested by {r.requestedByUserId} ·{' '}
                    {new Date(r.createdAt).toLocaleString()}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Review ${r.skillId}`}
                  onClick={() => setReviewing(r)}
                >
                  Review
                </Button>
              </div>
            ))
          )}
        </div>
      )}

      {reviewing !== null && (
        <BundleReviewDialog
          request={reviewing}
          onClose={() => setReviewing(null)}
          onDecided={() => {
            setReviewing(null);
            void refresh();
            onReviewed();
          }}
        />
      )}
    </div>
  );
}
