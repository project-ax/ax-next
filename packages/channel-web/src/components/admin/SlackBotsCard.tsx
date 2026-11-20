/**
 * "Team agents' own bots" in Admin › Slack (TASK-1172): every bot a team admin
 * gave a team agent, who set it up, whether it is live, and a Disconnect. An
 * admin who is offboarding someone reads this list to see which bots need
 * rebuilding: when the person who set one up has left, nobody can change its
 * Slack app any more.
 *
 * It is its own card, read from its own route (`lib/slack-bots-admin.ts`), and
 * SlackTab renders it OUTSIDE its status switch: the status is read again after
 * every shared-app action, and a card inside it would unmount and lose its own
 * note with it. Bots outlive the shared app, so the card does not wait for it.
 *
 *   no bots, or a server without the route   nothing at all
 *   a read that fails                        an alert with Try again, never
 *                                            "no bots" (an admin relies on this)
 *   after a Disconnect                       the list is read again and the tab
 *                                            is told its apps changed; when
 *                                            the Slack app couldn't be deleted,
 *                                            a note says so and outlives that
 *                                            re-read (and an emptied list)
 *
 * Each row carries only what an admin reads: a bot's name and @handle, its
 * approver's name (or "A former member"), when it was asked for and whether it
 * is live. The bot's install id is the key Disconnect takes and is never drawn.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { logRequestFailure } from '@/lib/http';
import {
  disconnectTeamBot,
  fetchSlackBots,
  teamBotGone,
  type AdminSlackBot,
} from '@/lib/slack-bots-admin';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; bots: AdminSlackBot[] };

const GENERIC_FAILURE = 'Something went wrong. Try again in a minute.';

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** A button's busy face: a spinner and what it's doing. */
function Busy({ children }: { children: ReactNode }) {
  return (
    <>
      <Spinner data-icon="inline-start" aria-hidden="true" />
      {children}
    </>
  );
}

export interface SlackBotsCardProps {
  /** Whether the shared Slack app is connected: only then does the shared bot answer again after a Disconnect. */
  sharedConnected: boolean;
  /** A bot's Slack app was deleted or listed as left over: the tab's own status may have changed too. */
  onAppsChanged: () => void;
}

export function SlackBotsCard({ sharedConnected, onAppsChanged }: SlackBotsCardProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [asking, setAsking] = useState<AdminSlackBot | null>(null);
  // The bot whose Slack app a disconnect couldn't delete. Held here, apart from the list, so it outlasts the re-read.
  const [leftOver, setLeftOver] = useState<string | null>(null);
  const seq = useRef(0);

  const read = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const out = await fetchSlackBots();
      if (mine === seq.current) setLoad({ kind: 'ready', bots: out.state === 'ready' ? out.bots : [] });
    } catch (err) {
      logRequestFailure(err, 'slack-bots-admin');
      if (mine === seq.current) setLoad({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    void read();
    return () => {
      // Whatever is still in flight belongs to a tab that is gone.
      seq.current += 1;
    };
  }, [read]);

  function gone(bot: AdminSlackBot, appDeleted: boolean) {
    setAsking(null);
    // The server has said it is gone: drop its row now, and read again to be sure.
    setLoad((was) =>
      was.kind === 'ready' ? { kind: 'ready', bots: was.bots.filter((b) => b.installId !== bot.installId) } : was,
    );
    if (!appDeleted) setLeftOver(bot.botName);
    void read();
    onAppsChanged();
  }

  function staleRow() {
    setAsking(null);
    void read();
  }

  const bots = load.kind === 'ready' ? load.bots : [];
  const anyFormerMember = bots.some((b) => b.approver === null);

  return (
    <>
      {leftOver !== null && (
        <Alert>
          <AlertDescription>
            {`${leftOver} is disconnected, but we couldn't confirm its Slack app was deleted. It's listed above, with the Slack apps we couldn't delete.`}
          </AlertDescription>
        </Alert>
      )}
      {load.kind === 'error' && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-3">
            <p>We couldn&apos;t load the team agents&apos; own bots.</p>
            <Button variant="outline" size="sm" onClick={() => void read()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {bots.length > 0 && (
        <Card variant="settings">
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="text-lg">
              Team agents&apos; own bots
            </CardTitle>
            <CardDescription>
              A team admin can give a team agent its own bot. Only the person who set one up can change its Slack app.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Table>
              <TableCaption className="sr-only">Team agents&apos; own bots</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Bot</TableHead>
                  <TableHead>Set up by</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bots.map((bot) => (
                  <TableRow key={bot.installId}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">{bot.botName}</span>
                        {bot.handle !== null && (
                          <span className="text-[12.5px] text-muted-foreground">@{bot.handle}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {bot.approver !== null ? bot.approver : <Badge variant="warning">A former member</Badge>}
                    </TableCell>
                    <TableCell>{shortDate(bot.addedAt)}</TableCell>
                    <TableCell>
                      {bot.state === 'live' ? (
                        <Badge variant="secondary">Live</Badge>
                      ) : (
                        <Badge variant="warning">Not finished</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Disconnect ${bot.botName}`}
                        onClick={() => setAsking(bot)}
                      >
                        Disconnect
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {anyFormerMember && (
              <p className="text-[12.5px] text-muted-foreground">
                When the person who set up a bot has left, nobody can change its Slack app any more. Disconnect it, and a
                team admin can set up a new one.
              </p>
            )}
          </CardContent>
        </Card>
      )}
      <DisconnectBotDialog
        bot={asking}
        sharedConnected={sharedConnected}
        onClose={() => setAsking(null)}
        onGone={gone}
        onStale={staleRow}
      />
    </>
  );
}

function DisconnectBotDialog({
  bot,
  sharedConnected,
  onClose,
  onGone,
  onStale,
}: {
  bot: AdminSlackBot | null;
  sharedConnected: boolean;
  onClose: () => void;
  onGone: (bot: AdminSlackBot, appDeleted: boolean) => void;
  /** Someone got there first: the row is out of date. */
  onStale: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The last bot asked about, so the words stay put while the dialog closes.
  const shown = useRef<AdminSlackBot | null>(null);
  if (bot !== null) shown.current = bot;
  const b = shown.current;
  const pending = b?.state === 'pending';
  const name = b?.botName ?? '';

  const close = (open: boolean) => {
    if (busy || open) return;
    setError(null);
    onClose();
  };

  async function confirm() {
    if (bot === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { appDeleted } = await disconnectTeamBot(bot.installId);
      onGone(bot, appDeleted);
    } catch (err) {
      logRequestFailure(err, 'slack-bots-admin');
      if (teamBotGone(err)) {
        onStale();
      } else {
        setError(GENERIC_FAILURE);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={bot !== null} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{pending ? `Stop setting up ${name}?` : `Disconnect ${name}?`}</DialogTitle>
          <DialogDescription>
            {pending
              ? "We'll delete the Slack app that was started for it. A team admin can ask for a bot again any time."
              : `${name} leaves every Slack channel it's in, and mentioning it stops working. We'll delete its Slack app.${
                  sharedConnected
                    ? ' The shared bot answers for its agent again in any channel it was connected to before.'
                    : ''
                }`}
          </DialogDescription>
        </DialogHeader>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>
            {pending ? 'Keep going' : 'Keep it'}
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            {busy ? <Busy>{pending ? 'Stopping…' : 'Disconnecting…'}</Busy> : pending ? 'Stop setting up' : 'Disconnect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
