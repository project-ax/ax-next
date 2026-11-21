/**
 * The channels the agent's own Slack bot has answered in, each with the same
 * "remember this channel" switch (TASK-1180). Only the switch is here: no
 * Disconnect (the bot answers where it was invited) and no "Connected by"
 * (nobody connected it).
 *
 * Rows live in local state seeded from the status. A re-read remounts this
 * component (the loading face unmounts it), so a stale page never lingers.
 * Never optimistic: a row's switch is disabled at its old position while the
 * write is out, and a failed write leaves it there with a sentence.
 */
import { useState } from 'react';
import { Hash } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { logRequestFailure } from '@/lib/http';
import {
  AGENT_SLACK_COPY,
  agentSlackWriteStale,
  setSlackBotChannelRemember,
  type BotChannelRow,
  type InviteTarget,
} from '@/lib/agent-slack';
import { SlackRememberField } from './SlackRememberField';

export interface AgentSlackBotChannelsProps {
  agentId: string;
  agentName: string;
  canManage: boolean;
  /** The live bot, for the lead-in line. */
  invite: InviteTarget;
  channels: BotChannelRow[];
  /** A 403, 404 or 409: what we drew is out of date; read the status again. */
  onStale: () => void;
}

export function AgentSlackBotChannels({
  agentId,
  agentName,
  canManage,
  invite,
  channels,
  onStale,
}: AgentSlackBotChannelsProps) {
  const [rows, setRows] = useState<BotChannelRow[]>(channels);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const mark = (channelId: string, on: boolean) =>
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(channelId);
      else next.delete(channelId);
      return next;
    });

  async function remember(row: BotChannelRow, on: boolean) {
    mark(row.channelId, true);
    setErrors(({ [row.channelId]: _gone, ...rest }) => rest);
    try {
      await setSlackBotChannelRemember(agentId, row.channelId, on);
      setRows((prev) => prev.map((c) => (c.channelId === row.channelId ? { ...c, remember: on } : c)));
    } catch (err) {
      logRequestFailure(err, 'agent-slack');
      if (agentSlackWriteStale(err)) onStale();
      else setErrors((prev) => ({ ...prev, [row.channelId]: AGENT_SLACK_COPY.rememberFailed }));
    } finally {
      mark(row.channelId, false);
    }
  }

  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">{AGENT_SLACK_COPY.botChannelsNotice(invite)}</p>
      <Card className="overflow-hidden p-0 shadow-none">
        <CardContent className="p-0">
          <ul
            aria-label="Channels its own bot has answered in"
            className="m-0 list-none divide-y divide-border p-0"
          >
            {rows.map((row) => (
              <li key={row.channelId} className="flex flex-col gap-3 px-4 py-3">
                <span className="flex items-center gap-1.5 text-[14px] font-medium">
                  <Hash aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{row.name}</span>
                </span>
                <SlackRememberField
                  id={`slack-bot-remember-${row.channelId}`}
                  agentName={agentName}
                  remember={row.remember}
                  canManage={canManage}
                  busy={pending.has(row.channelId)}
                  onChange={(on) => void remember(row, on)}
                />
                {errors[row.channelId] !== undefined && (
                  <p role="alert" className="text-[12.5px] text-destructive">
                    {errors[row.channelId]}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
