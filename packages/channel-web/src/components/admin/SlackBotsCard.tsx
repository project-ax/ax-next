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
 *   the first read in flight                 a placeholder, so a slow read is
 *                                            not mistaken for "no bots"
 *   no bots, or a server without the route   nothing at all
 *   a read that fails or hangs               an alert with Try again, never
 *                                            "no bots" (an admin relies on this;
 *                                            the client gives up after
 *                                            REQUEST_TIMEOUT_MS)
 *   after a Disconnect, or finding someone   the list is read again and the tab
 *   else already did it                      is told its apps changed; when
 *                                            the Slack app couldn't be deleted,
 *                                            a note says so and outlives that
 *                                            re-read (and an emptied list)
 *
 * Each row carries only what an admin reads: a bot's name and @handle, its
 * approver's name (or "A former member"), when it was asked for and whether it
 * is live. The bot's install id is the key Disconnect and Replace take and is
 * never drawn.
 *
 * Replace token (TASK-1173): on a live row the viewer set up, it opens the shared
 * `BotTokenReplaceDialog`, where the pasted token is write-only. Only the
 * approver gets it (`viewerIsApprover`), and the server refuses anyone else. A
 * replace changes nothing the list shows, so it isn't read again: the card says
 * "Token replaced" and that note outlives a re-read like `leftOver` does. A
 * refusal that says the row is out of date (rebuilt, claimed or disconnected in
 * another tab) closes the dialog and reads the list again.
 *
 * A live bot whose approver is gone says "Needs rebuilding": nobody can replace
 * its token any more. Disconnecting it is how it gets rebuilt, and its
 * Disconnect dialog says so.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BotTokenReplaceDialog } from '@/components/slack/BotTokenReplaceDialog';
import { Button } from '@/components/ui/button';
import { AsyncState, Card, ConfirmAction, Heading, Notice, Stack, StatusBadge, Text, Timestamp } from '@project-ax/ui';
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
  replaceTeamBotToken,
  teamBotGone,
  teamBotReplaceErrorCopy,
  teamBotReplaceStale,
  type AdminSlackBot,
} from '@/lib/slack-bots-admin';
import { BOT_TOKEN_COPY } from '@/lib/slack-token-copy';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; bots: AdminSlackBot[] };

const GENERIC_FAILURE = 'Something went wrong. Try again in a minute.';

export interface SlackBotsCardProps {
  /** A bot's Slack app was deleted or listed as left over: the tab's own status may have changed too. */
  onAppsChanged: () => void;
}

export function SlackBotsCard({ onAppsChanged }: SlackBotsCardProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [asking, setAsking] = useState<AdminSlackBot | null>(null);
  // The bot whose Slack app a disconnect couldn't delete. Held here, apart from the list, so it outlasts the re-read.
  const [leftOver, setLeftOver] = useState<string | null>(null);
  // The bot whose token dialog is open, and the note a replace leaves. Held apart from the list too: a replace doesn't re-read it.
  const [replacing, setReplacing] = useState<AdminSlackBot | null>(null);
  const [replaced, setReplaced] = useState<string | null>(null);
  // The last bot a replace was asked for, so the dialog's words stay put while it closes.
  const lastReplacing = useRef<AdminSlackBot | null>(null);
  if (replacing !== null) lastReplacing.current = replacing;
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
    setReplacing(null);
    void read();
    // Whoever got there first may have left a Slack app behind: the tab's list of those is out of date too.
    onAppsChanged();
  }

  const bots = load.kind === 'ready' ? load.bots : [];
  const anyFormerMember = bots.some((b) => b.approver === null);

  return (
    <>
      {leftOver !== null && (
        <Notice tone="info">
          {`${leftOver} is disconnected, but we couldn't confirm its Slack app was deleted. It's listed above, with the Slack apps we couldn't delete.`}
        </Notice>
      )}
      {replaced !== null && (
        <Notice tone="info">{BOT_TOKEN_COPY.replaced(replaced)}</Notice>
      )}
      {load.kind === 'error' && (
        <Notice tone="danger" action={{ label: 'Try again', onClick: () => void read() }}>
          We couldn&apos;t load the team agents&apos; own bots.
        </Notice>
      )}
      {load.kind === 'loading' && (
        // No title yet: the card may turn out to have nothing to show, and a heading that vanished would read as a glitch.
        // (The AsyncState announces this wait itself, as a polite status; the tab's own loading above is an earlier, separate wait.)
        <Card>
          <Stack gap="lg">
          <Stack gap="md">
            <AsyncState status="loading" skeleton="rows" loadingLabel="Loading the team agents' own bots" />
          </Stack>
        </Stack>
        </Card>
      )}
      {bots.length > 0 && (
        <Card>
          <Stack gap="lg">
          <Stack gap="xs">
            <Heading>Team agents&apos; own bots</Heading>
            <Text role="meta">A team admin can give a team agent its own bot. Only the person who set one up can change its Slack app.</Text>
          </Stack>
          <Stack gap="sm">
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
                      {bot.approver !== null ? bot.approver : <StatusBadge tone="warning" dot>A former member</StatusBadge>}
                    </TableCell>
                    <TableCell><Timestamp value={bot.addedAt} /></TableCell>
                    <TableCell>
                      {bot.state === 'live' ? (
                        bot.approver === null ? (
                          <StatusBadge tone="warning" dot>Needs rebuilding</StatusBadge>
                        ) : (
                          <StatusBadge tone="success" dot>Live</StatusBadge>
                        )
                      ) : (
                        <StatusBadge tone="warning" dot>Not finished</StatusBadge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        {bot.state === 'live' && bot.viewerIsApprover && (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Replace token for ${bot.botName}`}
                            onClick={() => {
                              setReplaced(null);
                              setReplacing(bot);
                            }}
                          >
                            Replace token
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Disconnect ${bot.botName}`}
                          onClick={() => setAsking(bot)}
                        >
                          Disconnect
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {anyFormerMember && (
              <p className="text-[12.5px] text-muted-foreground">
                When the person who set up a bot has left, nobody can replace its Slack token any more, so it needs
                rebuilding: disconnect it here, and a team admin of its agent can set up a new one.
              </p>
            )}
          </Stack>
        </Stack>
        </Card>
      )}
      <BotTokenReplaceDialog
        open={replacing !== null}
        onOpenChange={(open) => {
          if (!open) setReplacing(null);
        }}
        botName={lastReplacing.current?.botName ?? ''}
        replace={(refreshToken) =>
          lastReplacing.current === null
            ? Promise.reject(new Error('no bot'))
            : replaceTeamBotToken(lastReplacing.current.installId, refreshToken)
        }
        errorCopy={teamBotReplaceErrorCopy}
        isStale={teamBotReplaceStale}
        onReplaced={() => setReplaced(lastReplacing.current?.botName ?? null)}
        onStale={staleRow}
      />
      <DisconnectBotDialog
        bot={asking}
        onClose={() => setAsking(null)}
        onGone={gone}
        onStale={staleRow}
      />
    </>
  );
}

function DisconnectBotDialog({
  bot,
  onClose,
  onGone,
  onStale,
}: {
  bot: AdminSlackBot | null;
  onClose: () => void;
  onGone: (bot: AdminSlackBot, appDeleted: boolean) => void;
  /** Someone got there first: the row is out of date. */
  onStale: () => void;
}) {
  // The last bot asked about, so the words stay put while the dialog closes.
  const shown = useRef<AdminSlackBot | null>(null);
  if (bot !== null) shown.current = bot;
  const b = shown.current;
  const pending = b?.state === 'pending';
  const name = b?.botName ?? '';
  const needsRebuilding = b?.state === 'live' && b.approver === null;

  async function confirm() {
    if (bot === null) return;
    try {
      const { appDeleted } = await disconnectTeamBot(bot.installId);
      onGone(bot, appDeleted);
    } catch (err) {
      logRequestFailure(err, 'slack-bots-admin');
      // Someone got there first: the row is out of date. Refresh it and let the dialog close.
      if (teamBotGone(err)) {
        onStale();
        return;
      }
      throw err;
    }
  }

  return (
    <ConfirmAction
      open={bot !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={pending ? `Stop setting up ${name}?` : `Disconnect ${name}?`}
      description={
        pending
          ? "We'll delete the Slack app that was started for it. A team admin can ask for a bot again any time."
          : `${name} leaves every Slack channel it's in, and mentioning it stops working. We'll delete its Slack app.${
              needsRebuilding
                ? " Its approver has left, so this is how it gets rebuilt: once it's disconnected, a team admin of its agent sets up a new one from the agent's settings, and every channel needs /invite again."
                : ''
            }`
      }
      confirmLabel={pending ? 'Stop setting up' : 'Disconnect'}
      errorMessage={() => GENERIC_FAILURE}
      onConfirm={confirm}
    />
  );
}
