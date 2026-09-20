import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { logRequestFailure } from '@/lib/http';
import {
  listRememberedSites,
  forgetRememberedSite,
  type RememberedSite,
} from '@/lib/remembered-sites';

/**
 * What we know about the list right now — three states, and the reason this is
 * a union rather than `sites: RememberedSite[] | null` plus an error string
 * beside it (TASK-464).
 *
 * The old pair could hold `{ sites: [], error: '…' }`, and it did: the catch
 * set BOTH, so a failed read rendered the empty-state sentence with a banner
 * over it. Two claims about the same fact, one of them false. Here `sites`
 * exists only in `ok`, so "we could not read it" has no empty list to be
 * confused with and the renderer cannot draw one.
 *
 * `unknown` is the state, not the reason. The reason is a status code and a
 * request path; it goes to the console via `logRequestFailure`, because that is
 * where it helps and a screen is where it does not.
 */
type ListState =
  | { status: 'loading' }
  | { status: 'ok'; sites: RememberedSite[] }
  | { status: 'unknown' };

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
 * THREE STATES, NOT TWO (TASK-464): loading, the list, and "we could not read
 * it". The third is not a decoration on the second — see `ListState`, and see
 * the render branch, which draws no list at all when it does not have one.
 *
 * shadcn primitives + semantic tokens only (invariant #6). Hosts render
 * through React text nodes (auto-escaped); never raw inner HTML.
 */
export function RememberedSitesPanel() {
  const [list, setList] = useState<ListState>({ status: 'loading' });
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
      .then((sites) => {
        // A read that worked replaces whatever came before it, failure
        // included. A stale "couldn't load" banner sitting above a freshly-read
        // list is a claim about data that is no longer on screen — the same
        // reason the agent rail drops its rows when a read fails rather than
        // showing them beside an error.
        setList({ status: 'ok', sites });
      })
      .catch((e: unknown) => {
        // UNKNOWN, NEVER EMPTY (TASK-464). The old line here was
        // `setSites([])`, which handed the renderer the exact value a person
        // with nothing remembered produces — so a failed read of a security
        // allowlist drew "Nothing here yet". There is no `sites` to set on this
        // arm, which is the point of the union above.
        logRequestFailure(e, 'remembered-sites');
        setList({ status: 'unknown' });
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

      {/*
        THE UNKNOWN STATE STANDS IN FOR THE LIST — it is not drawn above one
        (TASK-464). A banner over an empty card would still be showing somebody
        an empty list, and the empty list is the false claim. So on `unknown`
        there is no Card at all: nothing on screen asserts what is or is not
        allowed, because we do not know.

        `destructive` follows `lib/read-register.ts`: a failed read that no
        automatic retry is coming back for stays red until the reader acts, and
        the button below is that action. It gets an `AlertTitle` because the
        surface holds positive evidence for exactly the claim the title makes —
        its own read failed — and the title asserts nothing about the list.
      */}
      {list.status === 'unknown' ? (
        <Alert variant="destructive">
          <AlertTitle>We couldn’t load your list</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            {/*
              "Not the same as empty" is the whole message and it is said first,
              because the reader's default reading of a blank settings panel is
              "there is nothing here" and that is the reading we have to undo.
              No status code, no request path, no exception text — none of it is
              something a person can act on (TASK-358's standing bar). What they
              can act on is the button.
            */}
            <span>
              That’s not the same as your list being empty — we just can’t see it right
              now. Nothing has changed. Try again in a moment.
            </span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
      <Card className="divide-y divide-border">
        {list.status === 'loading' && (
          <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>
        )}
        {list.status === 'ok' && list.sites.length === 0 && (
          <div className="px-4 py-3 text-sm text-muted-foreground">
            {/*
              THE ONLY PLACE THIS SENTENCE IS ALLOWED, and it is reachable from
              exactly one state: a read that came back. "Nothing here yet" is a
              claim about what this person has agreed to, and we may only make
              it when we have actually seen the list.
            */}
            Nothing here yet — we’ll ask the first time your assistant wants to read a new site.
          </div>
        )}
        {(list.status === 'ok' ? list.sites : []).map((site) => {
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
      </Card>
      )}

      {/*
        OUTSIDE THE CARD, and outside the unknown/ok branch with it. The notice
        reports what the DELETE did, which is a fact about the revoke and not
        about the list — so it must not unmount when the list changes shape.
        Inside the Card it did: a revoke that succeeded and was followed by a
        re-read that failed swapped the whole Card for the alert and took the
        confirmation with it, leaving somebody who had just clicked "Ask again"
        with no word on whether it worked. That is the #611 lesson one level up
        — the notice belongs to the PANEL, not to the row and not to the Card.
      */}
      {notice && <p className="px-1 text-xs text-muted-foreground">{notice}</p>}
    </section>
  );
}
