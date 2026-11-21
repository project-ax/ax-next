/**
 * The channels the agent's own Slack bot has answered in (TASK-1180,
 * TASK-1187). Each channel's memory setting lives in that row's ⋯ menu: a
 * manager picks "Don't remember this channel" or "Remember this channel"; a
 * member reads only "Not remembered" and has no ⋯. No Disconnect (the bot
 * answers where it was invited) and no "Connected by" (nobody connected it).
 *
 * Rows live in local state seeded from the status. A re-read remounts this
 * component (the loading face unmounts it), so a stale page never lingers.
 * Never optimistic: a row's ⋯ is disabled and the row keeps its old state while
 * the write is out, and a failed write leaves it there with a sentence.
 */
import { useState } from 'react';
import { Hash } from 'lucide-react';
import { logRequestFailure } from '@/lib/http';
import {
  AGENT_SLACK_CARD_COPY,
  AGENT_SLACK_COPY,
  agentSlackWriteStale,
  botWho,
  setSlackBotChannelRemember,
  type BotChannelRow,
  type InviteTarget,
} from '@/lib/agent-slack';
import { AgentSlackMenu } from './AgentSlackMenu';

export interface AgentSlackBotChannelsProps {
  agentId: string;
  canManage: boolean;
  /** The live bot, for the lead-in line and the list's name. */
  invite: InviteTarget;
  channels: BotChannelRow[];
  /** A 403, 404 or 409: what we drew is out of date; read the status again. */
  onStale: () => void;
}

export function AgentSlackBotChannels({ agentId, canManage, invite, channels, onStale }: AgentSlackBotChannelsProps) {
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
  const who = botWho(invite);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">{AGENT_SLACK_CARD_COPY.channelsLead(invite)}</p>
      <ul
        aria-label={`Channels ${who} has answered in`}
        className="m-0 list-none divide-y divide-border rounded-md border border-border p-0"
      >
        {rows.map((row) => (
          <li key={row.channelId} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-1.5 text-[14px] font-medium">
                <Hash aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{row.name}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {!row.remember && (
                  <span className="text-[12.5px] text-muted-foreground">{AGENT_SLACK_CARD_COPY.notRemembered}</span>
                )}
                {canManage && (
                  <AgentSlackMenu
                    label={`Actions for #${row.name}`}
                    disabled={pending.has(row.channelId)}
                    items={[
                      {
                        label: row.remember
                          ? AGENT_SLACK_CARD_COPY.dontRemember
                          : AGENT_SLACK_CARD_COPY.rememberAgain,
                        onSelect: () => void remember(row, !row.remember),
                      },
                    ]}
                  />
                )}
              </span>
            </div>
            {errors[row.channelId] !== undefined && (
              <p role="alert" className="text-[12.5px] text-destructive">
                {errors[row.channelId]}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
