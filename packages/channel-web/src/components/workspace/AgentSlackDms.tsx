/**
 * A personal agent's line in its Slack section (TASK-1238): which agent a
 * direct message to the shared bot reaches, and, when it isn't this one, a
 * button that makes it this one. Only the owner of a personal agent ever sees
 * this (the status route answers `personal-agent` to nobody else).
 *
 * Three states, all plain words (`AGENT_SLACK_DM_COPY`):
 *   1. This agent answers: today's sentence, no button. Right after a switch
 *      a confirmation sits above it.
 *   2. Another agent answers and the server named it: who, and the button.
 *   3. No name came back (an older host): a neutral line, no button.
 *
 * The write is never optimistic: the button shows "Switching…" and stays
 * disabled while the request is in flight (a second click sends nothing), a
 * failure leaves the old state with a sentence saying nothing changed, and a
 * success hands the labels to the parent, which reads the status again. An
 * out-of-date page (the agent was deleted in another tab) reads again instead
 * of showing an error it can't fix.
 */
import { useEffect, useRef, useState } from 'react';
import { Notice } from '@project-ax/ui';
import { Button } from '@/components/ui/button';
import { AGENT_SLACK_DM_COPY as COPY, agentSlackBotStale, chooseSlackDmAgent } from '@/lib/agent-slack';
import { logRequestFailure } from '@/lib/http';

export interface AgentSlackDmsProps {
  agentId: string;
  agentName: string;
  botName: string;
  answersDms: boolean;
  dmAgentName: string | null;
  /** Labels from a switch this page just made, for the confirmation; null otherwise. */
  switched: { self: string; from: string } | null;
  /** The switch was stored: the parent keeps the labels and reads the status again. */
  onSwitched: (labels: { self: string; from: string }) => void;
  /** The page is out of date (agentSlackBotStale): the parent reads the status again. */
  onStale: () => void;
}

const sameName = (a: string, b: string): boolean => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/**
 * The confirmation of a switch that was stored. It takes focus when it mounts:
 * the button that was pressed went with the old state (the TASK-427 landing rule).
 * Also shown by `AgentSlack` above its load error, when the re-read after a
 * successful switch fails: the switch still happened.
 */
export function AgentSlackDmsSwitched({ botName, switched }: { botName: string; switched: { self: string; from: string } }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <section ref={ref} tabIndex={-1}>
      <Notice tone="success">{COPY.switched(botName, switched.self, switched.from)}</Notice>
    </section>
  );
}

export function AgentSlackDms({
  agentId,
  agentName,
  botName,
  answersDms,
  dmAgentName,
  switched,
  onSwitched,
  onStale,
}: AgentSlackDmsProps) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // A second click lands before the disabled button has re-rendered: the ref closes that gap.
  const inFlight = useRef(false);

  if (answersDms) {
    return (
      <div className="flex flex-col gap-3">
        {switched !== null && <AgentSlackDmsSwitched botName={botName} switched={switched} />}
        <p className="text-[13px] text-muted-foreground">{COPY.answersHere(agentName, botName)}</p>
      </div>
    );
  }

  // Anything but a non-empty string is "no name" here too: a test mock can bypass the parser.
  if (typeof dmAgentName !== 'string' || dmAgentName.trim() === '') {
    return <p className="text-[13px] text-muted-foreground">{COPY.goesElsewhere(agentName, botName)}</p>;
  }

  const same = sameName(agentName, dmAgentName);
  const other = same ? COPY.yourOther(dmAgentName.trim()) : dmAgentName;
  const self = same ? COPY.thisOne(agentName) : agentName;

  const choose = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await chooseSlackDmAgent(agentId);
      onSwitched({ self, from: other });
    } catch (e) {
      if (agentSlackBotStale(e)) {
        onStale();
      } else {
        logRequestFailure(e, 'agent-slack-dm-agent');
        setFailed(true);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-[13px] text-muted-foreground">{COPY.goesTo(botName, other)}</p>
      {failed && <Notice tone="danger">{COPY.notSwitched}</Notice>}
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void choose()}>
        {busy ? COPY.switching : COPY.useInstead(self)}
      </Button>
    </div>
  );
}
