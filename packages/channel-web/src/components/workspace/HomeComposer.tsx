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
  onSend: (agentId: string, text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [pick, setPick] = useState<string>('auto');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [routing, setRouting] = useState(false);

  const picked = agents.find((a) => a.id === pick) ?? null;

  const submit = async () => {
    const text = draft.trim();
    if (!text || routing) return;

    if (picked) {
      setDraft('');
      onSend(picked.id, text);
      return;
    }

    setRouting(true);
    try {
      const r = await workspaceApi.route(text);
      setProposal({ ...r, text });
    } finally {
      setRouting(false);
    }
  };

  const confirm = (agentId: string) => {
    if (!proposal) return;
    const { text } = proposal;
    setProposal(null);
    setDraft('');
    onSend(agentId, text);
  };

  return (
    <div className="mx-auto w-full max-w-[900px] px-6 pb-6">
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
          placeholder={'Ask for something — try "find me 30 minutes with Marcus"'}
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
          disabled={routing}
          onClick={() => void submit()}
        >
          <ArrowUp size={14} />
        </Button>
      </div>
    </div>
  );
}
