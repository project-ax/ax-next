/**
 * An agent's Slack section in its settings (TASK-1094): the channels it
 * answers in, and — for the team admins who manage it — connecting,
 * disconnecting and "remember this channel".
 *
 * Claude-simple on purpose. No ids, scopes or install words: a channel is
 * `#name`, a person is a name, and a problem shows up only when there is one.
 * Slack itself is set up once, in Admin settings; this page never asks for it.
 *
 * The "remember" switch is never optimistic (the `lib/agent-abilities.ts`
 * rule): while a write is in flight it is disabled at its old position, and a
 * failed write leaves it there with a sentence saying nothing changed.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Hash } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { logRequestFailure } from '@/lib/http';
import {
  AGENT_SLACK_COPY,
  agentSlackErrorCopy,
  agentSlackStateChanged,
  agentSlackWriteStale,
  connectSlackChannel,
  disconnectSlackChannel,
  fetchAgentSlack,
  fetchAvailableChannels,
  setSlackChannelRemember,
  type AgentSlackRead,
  type AvailableSlackChannels,
  type SlackChannelRow,
} from '@/lib/agent-slack';

type Ready = Extract<AgentSlackRead, { state: 'ready' }>;
type Load = { status: 'loading' } | { status: 'failed' } | { status: 'ok'; read: AgentSlackRead };

export interface AgentSlackProps {
  agentId: string;
  agentName: string;
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

export function AgentSlack({ agentId, agentName }: AgentSlackProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  // Only the newest scope's answers land (switching agents quickly).
  const scope = useRef(0);

  const read = useCallback(() => {
    const id = ++scope.current;
    setLoad({ status: 'loading' });
    void (async () => {
      try {
        const out = await fetchAgentSlack(agentId);
        if (scope.current === id) setLoad({ status: 'ok', read: out });
      } catch (e) {
        logRequestFailure(e, 'agent-slack');
        if (scope.current === id) setLoad({ status: 'failed' });
      }
    })();
  }, [agentId]);

  useEffect(() => {
    read();
    return () => {
      scope.current += 1;
    };
  }, [read]);

  if (load.status === 'loading') {
    return (
      <div role="status" className="flex flex-col gap-3">
        <span className="sr-only">Loading Slack settings…</span>
        <Skeleton className="h-14 w-full" aria-hidden="true" />
        <Skeleton className="h-14 w-full" aria-hidden="true" />
      </div>
    );
  }
  if (load.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-col items-start gap-3">
          <p>We couldn&apos;t load the Slack settings.</p>
          <Button variant="outline" size="sm" onClick={read}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const state = load.read;
  switch (state.state) {
    case 'unavailable':
      return <p className="text-[13px] text-muted-foreground">Slack isn&apos;t available here.</p>;
    case 'no-workspace':
      return (
        <p className="text-[13px] text-muted-foreground">
          Slack isn&apos;t connected to this workspace yet. An admin can connect it in Admin settings.
        </p>
      );
    case 'personal-agent':
      return (
        <p className="text-[13px] text-muted-foreground">
          {state.answersDms
            ? `${agentName} is a personal agent, so it answers in a direct message with ${state.botName} in Slack. Channels are for team agents.`
            : `${agentName} is a personal agent, so it can't join channels. A direct message to ${state.botName} in Slack goes to your first personal agent, not ${agentName}.`}
        </p>
      );
    case 'ready':
      return (
        <ReadySection
          key={agentId}
          agentId={agentId}
          agentName={agentName}
          ready={state}
          onChange={(next) => setLoad({ status: 'ok', read: next })}
          onStale={read}
        />
      );
  }
}

function ReadySection({
  agentId,
  agentName,
  ready,
  onChange,
  onStale,
}: {
  agentId: string;
  agentName: string;
  ready: Ready;
  onChange: (next: Ready) => void;
  /** A refusal that says the picture is out of date: read it again. */
  onStale: () => void;
}) {
  const { channels, canManage } = ready;
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<SlackChannelRow | null>(null);
  // The rows move under in-flight writes; read the newest list when one lands.
  const latest = useRef(ready);
  latest.current = ready;

  const withRows = (rows: SlackChannelRow[]) => onChange({ ...latest.current, channels: rows });
  const upsert = (row: SlackChannelRow) => {
    const rows = latest.current.channels;
    const has = rows.some((c) => c.channelId === row.channelId);
    withRows(has ? rows.map((c) => (c.channelId === row.channelId ? row : c)) : [...rows, row]);
  };

  /** One sentence for a failed connect, reconnect or channel list. */
  const refuse = (err: unknown) => {
    logRequestFailure(err, 'agent-slack');
    if (agentSlackStateChanged(err)) {
      onStale();
      return;
    }
    setNotice(agentSlackErrorCopy(err));
  };

  const mark = (channelId: string, on: boolean) =>
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(channelId);
      else next.delete(channelId);
      return next;
    });

  async function remember(row: SlackChannelRow, on: boolean) {
    mark(row.channelId, true);
    setRowErrors(({ [row.channelId]: _gone, ...rest }) => rest);
    try {
      await setSlackChannelRemember(agentId, row.channelId, on);
      withRows(
        latest.current.channels.map((c) => (c.channelId === row.channelId ? { ...c, remember: on } : c)),
      );
    } catch (err) {
      logRequestFailure(err, 'agent-slack');
      if (agentSlackWriteStale(err)) onStale();
      else setRowErrors((prev) => ({ ...prev, [row.channelId]: AGENT_SLACK_COPY.rememberFailed }));
    } finally {
      mark(row.channelId, false);
    }
  }

  async function reconnect(row: SlackChannelRow) {
    mark(row.channelId, true);
    setNotice(null);
    try {
      upsert((await connectSlackChannel(agentId, row.channelId)).channel);
    } catch (err) {
      refuse(err);
    } finally {
      mark(row.channelId, false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {notice !== null && (
        <Alert variant="destructive">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {channels.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {canManage
            ? `${agentName} isn't answering in any channels yet.`
            : `${agentName} isn't connected to any Slack channels yet.`}
        </p>
      ) : (
        <Card className="overflow-hidden p-0 shadow-none">
          <CardContent className="p-0">
            <ul aria-label="Connected channels" className="m-0 list-none divide-y divide-border p-0">
              {channels.map((row) => (
                <ChannelRow
                  key={row.channelId}
                  row={row}
                  agentName={agentName}
                  canManage={canManage}
                  busy={pending.has(row.channelId)}
                  error={rowErrors[row.channelId] ?? null}
                  onRemember={(on) => void remember(row, on)}
                  onReconnect={() => void reconnect(row)}
                  onDisconnect={() => setDisconnecting(row)}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {canManage && (
        <ChannelPicker
          agentId={agentId}
          agentName={agentName}
          onConnected={(row) => {
            setNotice(null);
            upsert(row);
          }}
          onRefused={refuse}
          onClear={() => setNotice(null)}
        />
      )}
      <DisconnectDialog
        agentId={agentId}
        row={disconnecting}
        onClose={() => setDisconnecting(null)}
        onStale={onStale}
        onDisconnected={(channelId) => {
          setDisconnecting(null);
          withRows(latest.current.channels.filter((c) => c.channelId !== channelId));
        }}
      />
    </div>
  );
}

function ChannelRow({
  row,
  agentName,
  canManage,
  busy,
  error,
  onRemember,
  onReconnect,
  onDisconnect,
}: {
  row: SlackChannelRow;
  agentName: string;
  canManage: boolean;
  busy: boolean;
  error: string | null;
  onRemember: (on: boolean) => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const switchId = `slack-remember-${row.channelId}`;
  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 text-[14px] font-medium">
            <Hash aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{row.name}</span>
            {row.needsReconnect && <Badge variant="outline">Needs reconnecting</Badge>}
          </span>
          <span className="text-[12.5px] text-muted-foreground">Connected by {row.connectedBy}</span>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            {row.needsReconnect && (
              <Button variant="outline" size="sm" disabled={busy} onClick={onReconnect}>
                {busy ? <Busy>Reconnecting…</Busy> : 'Reconnect'}
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={busy} onClick={onDisconnect}>
              Disconnect
            </Button>
          </div>
        )}
      </div>
      {row.needsReconnect && (
        <p className="text-[12.5px] text-muted-foreground">
          {canManage
            ? `Whoever connected this channel no longer has access to ${agentName}, so it can't answer here until you reconnect it.`
            : `Whoever connected this channel no longer has access to ${agentName}, so it can't answer here until a team admin reconnects it.`}
        </p>
      )}
      {canManage ? (
        <Field orientation="horizontal">
          <Switch
            id={switchId}
            checked={row.remember}
            disabled={busy}
            onCheckedChange={onRemember}
          />
          <FieldLabel htmlFor={switchId} className="font-normal">
            Let {agentName} remember this channel
          </FieldLabel>
        </Field>
      ) : (
        row.remember && <p className="text-[12.5px] text-muted-foreground">{agentName} remembers this channel.</p>
      )}
      {error !== null && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

function ChannelPicker({
  agentId,
  agentName,
  onConnected,
  onRefused,
  onClear,
}: {
  agentId: string;
  agentName: string;
  onConnected: (row: SlackChannelRow) => void;
  onRefused: (err: unknown) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState<AvailableSlackChannels | null>(null);
  const [connecting, setConnecting] = useState(false);

  async function show(next: boolean) {
    setOpen(next);
    if (!next) return;
    onClear();
    setLoading(true);
    setAvailable(null);
    try {
      setAvailable(await fetchAvailableChannels(agentId));
    } catch (err) {
      setOpen(false);
      onRefused(err);
    } finally {
      setLoading(false);
    }
  }

  async function pick(channelId: string) {
    setOpen(false);
    setConnecting(true);
    try {
      onConnected((await connectSlackChannel(agentId, channelId)).channel);
    } catch (err) {
      onRefused(err);
    } finally {
      setConnecting(false);
    }
  }

  const options = (available?.channels ?? []).filter((c) => c.connected !== 'this-agent');

  return (
    <Field>
      <FieldLabel htmlFor="slack-connect-channel">Connect a channel</FieldLabel>
      <Popover open={open} onOpenChange={(next) => void show(next)}>
        <PopoverTrigger asChild>
          <Button
            id="slack-connect-channel"
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={connecting}
            className="w-full justify-between text-muted-foreground"
          >
            {connecting ? <Busy>Connecting…</Busy> : <span className="truncate">Choose a channel</span>}
            <ChevronDown data-icon="inline-end" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search channels…" />
            <CommandList>
              {loading ? (
                <div role="status" className="flex items-center gap-2 px-3 py-4 text-[13px] text-muted-foreground">
                  <Spinner aria-hidden="true" />
                  Loading channels…
                </div>
              ) : (
                <>
                  <CommandEmpty>No channels to connect.</CommandEmpty>
                  <CommandGroup>
                    {options.map((c) => {
                      const taken = c.connected === 'other-agent';
                      return (
                        <CommandItem
                          key={c.channelId}
                          value={c.channelId}
                          keywords={[c.name]}
                          disabled={taken}
                          onSelect={() => void pick(c.channelId)}
                        >
                          <span className="flex-1 truncate">#{c.name}</span>
                          {taken && (
                            <span className="text-[12px] text-muted-foreground">Connected to another agent</span>
                          )}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                  {available?.truncated === true && (
                    <p className="border-t border-border px-3 py-2 text-[12px] text-muted-foreground">
                      Can&apos;t see the channel you want? In Slack, type /ax connect in that channel.
                    </p>
                  )}
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <FieldDescription>
        Everyone in the channel can talk to {agentName}. Its instructions and files can show up in its answers to
        anyone in the channel. If someone without access to {agentName} talks to it, it works with the access of
        whoever connected the channel, and any approvals wait in that person&apos;s Today.
      </FieldDescription>
    </Field>
  );
}

function DisconnectDialog({
  agentId,
  row,
  onClose,
  onStale,
  onDisconnected,
}: {
  agentId: string;
  row: SlackChannelRow | null;
  onClose: () => void;
  /** The server says that row isn't ours to change any more: read it again. */
  onStale: () => void;
  onDisconnected: (channelId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (open: boolean) => {
    if (busy || open) return;
    setError(null);
    onClose();
  };

  async function confirm() {
    if (row === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await disconnectSlackChannel(agentId, row.channelId);
      onDisconnected(row.channelId);
    } catch (err) {
      logRequestFailure(err, 'agent-slack');
      if (agentSlackWriteStale(err)) {
        setError(null);
        onClose();
        onStale();
      } else {
        setError(AGENT_SLACK_COPY.generic);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={row !== null} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect #{row?.name ?? ''}?</DialogTitle>
          <DialogDescription>
            The agent stops answering in #{row?.name ?? ''}. You can connect it again any time.
          </DialogDescription>
        </DialogHeader>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>
            Keep connected
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            {busy ? <Busy>Disconnecting…</Busy> : 'Disconnect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
