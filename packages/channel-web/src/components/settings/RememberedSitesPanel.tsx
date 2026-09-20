import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  listRememberedSites,
  forgetRememberedSite,
  type RememberedSite,
} from '@/lib/remembered-sites';

/**
 * "Sites we read without asking" — the durable per-user set of hosts
 * `web_extract` approved on a first read (TASK-406). NOT the allowed-sites
 * egress allowlist above (that is per-agent, raw socket reach); this is
 * per-person, one page-read tool. See `ConnectorsTab.tsx` for the split.
 *
 * `scope: 'global'` rows are admin-set for the whole deployment: shown so a
 * person can see why a site never prompts, but not revocable by them — no
 * button renders for one, and the server would decline (`revoked: false`)
 * if asked anyway.
 *
 * shadcn primitives + semantic tokens only (invariant #6). Hosts render
 * through React text nodes (auto-escaped); never raw inner HTML.
 */
export function RememberedSitesPanel() {
  const [sites, setSites] = useState<RememberedSite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Lives HERE, not in a per-row component. A successful revoke removes the
  // ROW that triggered it (the panel re-reads and that host is gone), but the
  // PANEL itself survives its own revoke — so the notice has to be state this
  // component owns, rendered as the list's last child, or it would unmount
  // along with the row that set it. This is the #611 lesson (AgentRailContent
  // owned its revoke notice locally and the notice vanished when the row
  // unmounted): don't repeat it here by hoisting this into a row subcomponent.
  const [notice, setNotice] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(() => {
    return listRememberedSites()
      .then((s) => {
        setSites(s);
        // Clear a previous failure on a read that worked. A stale "couldn't
        // load" banner sitting above a freshly-read list is a claim about data
        // that is no longer on screen — the same reason the agent rail drops
        // its rows when a read fails rather than showing them beside an error.
        setError(null);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setSites([]);
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const askAgain = async (host: string): Promise<void> => {
    // Clear any stale verdict from a previous click up front, so a second
    // revoke never shows the first one's outcome while it's in flight.
    setNotice(null);
    setRevoking((prev) => new Set(prev).add(host));
    try {
      const { revoked } = await forgetRememberedSite(host);
      setNotice(
        revoked ? 'We’ll ask about that one next time.' : 'That one was already gone.',
      );
      // Re-read rather than splice the row out optimistically — the server's
      // view (including whether it actually revoked anything) is the truth
      // we want reflected, not our guess about what the DELETE did.
      await load();
    } catch {
      setNotice('We couldn’t take that back just now. Nothing changed.');
    } finally {
      setRevoking((prev) => {
        const next = new Set(prev);
        next.delete(host);
        return next;
      });
    }
  };

  const rememberedDate = (iso: string): string | null => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
  };

  return (
    <section className="flex flex-col gap-3.5 border-t border-border pt-5 mt-2">
      <div>
        <h2 className="text-sm font-medium text-foreground">Sites we read without asking</h2>
        <p className="text-xs text-muted-foreground">
          When your assistant wants to read a web page from a site it hasn’t read before, we
          stop and ask. Say yes once and we stop asking about that site. This list is yours
          alone — nobody else’s assistant is affected.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="divide-y divide-border">
        {sites === null && !error && (
          <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>
        )}
        {sites !== null && sites.length === 0 && (
          <div className="px-4 py-3 text-sm text-muted-foreground">
            Nothing here yet — we’ll ask the first time your assistant wants to read a new site.
          </div>
        )}
        {(sites ?? []).map((site) => {
          const date = rememberedDate(site.rememberedAt);
          return (
            <div
              // scope+host, not host alone. @ax/tool-policy dedupes this list
              // to one row per host (global wins) and that rule lives there,
              // not here — but a key that CANNOT collide costs one word, and
              // the failure it rules out is undefined React reconciliation
              // rather than a visibly wrong row.
              key={`${site.scope}:${site.host}`}
              data-testid={`remembered-site-${site.host}`}
              className="flex items-center gap-3 px-4 py-2.5"
            >
              <span className="flex-1 min-w-0 truncate text-sm text-foreground">
                {site.host}
              </span>
              {date && <span className="text-xs text-muted-foreground">{date}</span>}
              {site.scope === 'global' ? (
                <Badge variant="secondary">Set by your admin</Badge>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={revoking.has(site.host)}
                  onClick={() => void askAgain(site.host)}
                >
                  {/* "Ask again" is deliberate, not "Remove": revoking this
                      entry doesn't block the site, it just restores the
                      ask-first prompt — "Remove" would suggest the site is
                      now off-limits, which is the wrong mental model. */}
                  Ask again
                </Button>
              )}
            </div>
          );
        })}
        {notice && (
          <div className="px-4 py-2.5 text-xs text-muted-foreground">{notice}</div>
        )}
      </Card>
    </section>
  );
}
