/**
 * The home composer — ask for something without first deciding who to ask.
 *
 * Restored from the source design, with one deliberate change: **Auto proposes,
 * it does not silently dispatch.**
 *
 * In the source prototype the picker was decorative — every send went to
 * Scheduler regardless. Once it is real, the failure mode is that a
 * free-text request reaches the wrong agent and that agent starts acting on it.
 * A confirmation step costs one click on the Auto path only (picking an agent
 * explicitly sends straight away) and turns a silent misroute into a visible
 * one. It also gives the routing a place to show its reasoning, which is the
 * only way a user ever learns to trust or distrust it.
 */
import { useState } from 'react';
import { ArrowUp, ChevronDown, MessageSquare, Zap } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { workspaceApi, type WorkspaceAgent } from '@/lib/workspace-api';
import { AgentTile } from './bits';

interface Proposal {
  agentId: string;
  agentName: string;
  why: string;
  confident: boolean;
  text: string;
}

export function HomeComposer({
  agents,
  onSend,
}: {
  agents: WorkspaceAgent[];
  /**
   * Awaited, and its rejection is the caller's news to hear. Returning `void`
   * here is what let a failed send reject unhandled while the draft was
   * already gone — see `dispatch`.
   */
  onSend: (agentId: string, text: string) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [pick, setPick] = useState<string>('auto');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [routing, setRouting] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const picked = agents.find((a) => a.id === pick) ?? null;
  const nameOf = (id: string) =>
    agents.find((a) => a.id === id)?.name ?? 'that agent';

  /*
    THE DRAFT IS ONLY CLEARED ONCE THE SEND HAS RESOLVED.

    Both of these used to be un-caught awaits, and the draft was cleared before
    the handoff. A 503, a 404 or a dropped connection rejected a promise nobody
    was listening to: nothing rendered, and the sentence the user had just
    typed was already wiped out of the box. Losing someone's words because a
    server hiccuped is not an acceptable failure mode at any severity.
  */
  const dispatch = async (agentId: string, text: string) => {
    setSending(true);
    setError(null);
    try {
      await onSend(agentId, text);
      // On the home surface `onSend` navigates to the agent, so this component
      // is on its way out by the time these run. React 18 makes a setState on
      // an unmounted component a no-op rather than a warning, and the clears
      // still matter on the paths that DON'T navigate — so they stay.
      setProposal(null);
      setDraft('');
    } catch {
      setProposal(null);
      setError(
        `We could not get that to ${nameOf(agentId)}. Nothing was sent, and your message is still here — try again in a moment.`,
      );
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || routing || sending) return;

    if (picked) {
      await dispatch(picked.id, text);
      return;
    }

    setRouting(true);
    setError(null);
    try {
      const r = await workspaceApi.route(text);
      setProposal({ ...r, text });
    } catch {
      setError(
        'We could not work out which agent should take this. Your message is still here — pick an agent from the menu, or try again in a moment.',
      );
    } finally {
      setRouting(false);
    }
  };

  const confirm = (agentId: string) => {
    if (!proposal) return;
    void dispatch(agentId, proposal.text);
  };

  return (
    <div className="mx-auto w-full max-w-[900px] px-6 pb-6">
      {error !== null && (
        <Alert variant="destructive" className="mb-2">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span className="min-w-0">{error}</span>
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              onClick={() => setError(null)}
            >
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {proposal && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2.5 shadow-sm">
          <Zap size={13} className="shrink-0 text-primary" />
          <span className="text-[13px]">
            {proposal.confident ? (
              <>
                Auto picked <strong className="font-medium">{proposal.agentName}</strong>{' '}
                <span className="text-muted-foreground">— {proposal.why}.</span>
              </>
            ) : (
              <>
                Auto is not sure — <span className="text-muted-foreground">{proposal.why}.</span>{' '}
                Best guess is{' '}
                <strong className="font-medium">{proposal.agentName}</strong>.
              </>
            )}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" onClick={() => confirm(proposal.agentId)}>
              Send to {proposal.agentName}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="secondary">
                  Someone else
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {agents.map((a) => (
                  <DropdownMenuItem key={a.id} onClick={() => confirm(a.id)}>
                    <AgentTile agent={a} size={18} />
                    {a.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setProposal(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 shadow-sm">
        <MessageSquare size={15} className="shrink-0 text-muted-foreground" />
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          /*
            Promises nothing. The old placeholder — "try 'find me 30 minutes
            with Marcus'" — presumed a scheduler agent, a calendar grant and a
            contact named Marcus, none of which a brand-new agent has. A
            suggestion the product cannot honour is a claim about reach.
          */
          placeholder={
            picked
              ? `Ask ${picked.name} to do something — or just say hi to get started`
              : 'Ask for something — or just say hi to get started'
          }
          className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-muted px-2.5 text-[12.5px] font-medium"
            >
              {picked ? (
                <AgentTile agent={picked} size={16} />
              ) : (
                <Zap size={11} className="text-primary" />
              )}
              {picked ? picked.name : 'Auto'}
              <ChevronDown size={11} className="text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setPick('auto')}>
              <Zap size={13} className="text-primary" />
              Anyone — pick for me
            </DropdownMenuItem>
            {agents.map((a) => (
              <DropdownMenuItem key={a.id} onClick={() => setPick(a.id)}>
                <AgentTile agent={a} size={18} />
                {a.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Send"
          disabled={routing || sending}
          onClick={() => void submit()}
        >
          <ArrowUp size={14} />
        </Button>
      </div>
    </div>
  );
}
