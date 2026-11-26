/**
 * The channels the agent's own Slack bot has answered in (TASK-1180,
 * TASK-1187): a read-only list, one row per channel, the same for a manager
 * and a member. A private channel is remembered like any other (TASK-1203),
 * so its row looks like the rest. A row has no ⋯, because there is nothing to
 * change (TASK-1202 removed the per-channel memory switch). No Disconnect (the
 * bot answers where it was invited) and no "Connected by" (nobody connected
 * it).
 *
 * Rows are drawn straight from the status. A re-read remounts this component
 * (the loading face unmounts it), so a stale page never lingers.
 */
import { Hash } from 'lucide-react';
import { Card, List, ListRow } from '@project-ax/ui';
import { AGENT_SLACK_CARD_COPY, botWho, type BotChannelRow, type InviteTarget } from '@/lib/agent-slack';

export interface AgentSlackBotChannelsProps {
  /** The live bot, for the lead-in line and the list's name. */
  invite: InviteTarget;
  channels: BotChannelRow[];
}

export function AgentSlackBotChannels({ invite, channels }: AgentSlackBotChannelsProps) {
  if (channels.length === 0) return null;
  const who = botWho(invite);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">{AGENT_SLACK_CARD_COPY.channelsLead(invite)}</p>
      <Card flush>
        <List label={`Channels ${who} has answered in`}>
          {channels.map((row) => (
            <ListRow key={row.channelId} title={row.name} leading={<Hash size={14} aria-hidden="true" />} />
          ))}
        </List>
      </Card>
    </div>
  );
}
