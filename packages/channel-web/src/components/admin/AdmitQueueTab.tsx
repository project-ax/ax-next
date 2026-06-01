import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { listCatalogRequests } from '@/lib/catalog';
import type { CatalogRequest } from '@ax/skills';
import { BundleReviewDialog } from './BundleReviewDialog';

/**
 * The admin Admit queue — the actionable inbox of pending admit-to-catalog
 * requests (cold-start "a user needed X" + share-to-catalog submissions).
 * Reviewing a request opens a bundle file/diff view; admitting means *code
 * review* of the submitted (untrusted) bundle bytes (design §9.2, decision #16).
 */
export function AdmitQueueTab() {
  const [requests, setRequests] = useState<CatalogRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<CatalogRequest | null>(null);

  async function refresh() {
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Skills awaiting review</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {requests === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pending requests. Cold-start and share-to-catalog submissions land here.
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
                  requested by {r.requestedByUserId} · {new Date(r.createdAt).toLocaleString()}
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

        {reviewing !== null && (
          <BundleReviewDialog
            request={reviewing}
            onClose={() => setReviewing(null)}
            onDecided={() => {
              setReviewing(null);
              void refresh();
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}
