import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AsyncState, EmptyState } from '@project-ax/ui';
import { RoutineEditor } from '@/components/routines/RoutineEditor';
import { workspaceApi } from '@/lib/workspace-api';

type TaskAgent = { agentId: string; agentName: string };

/** One editor and one logical write operation, shared by New task and Edit. */
export function TaskDialog({ open, onOpenChange, agent, routineId, onWriteSucceeded, onSaved, onClosed }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent?: TaskAgent;
  routineId?: string;
  onWriteSucceeded: () => void;
  onSaved: (agentId: string, routineId: string) => void;
  onClosed: () => void;
}) {
  const [agents, setAgents] = useState<TaskAgent[] | null>(null);
  const [selected, setSelected] = useState('');
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!open || agent !== undefined) return;
    let current = true;
    setAgents(null); setFailed(false); setPending(false);
    void workspaceApi.taskAgents().then(result => {
      if (!current) return;
      setAgents(result.agents); setSelected(result.agents[0]?.agentId ?? '');
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [open, agent, retry]);
  const chosen = agent ?? agents?.find(candidate => candidate.agentId === selected);
  return <Dialog open={open} onOpenChange={next => { if (!pending) onOpenChange(next); }}>
    {/* Title only: the form explains itself, so there's no description to point at. */}
    <DialogContent className="max-h-[85dvh] overflow-y-auto" aria-describedby={undefined}
      onEscapeKeyDown={event => { if (pending) event.preventDefault(); }}
      onInteractOutside={event => { if (pending) event.preventDefault(); }}
      onCloseAutoFocus={event => { event.preventDefault(); onClosed(); }}>
      <DialogHeader><DialogTitle>{routineId === undefined ? 'New task' : 'Edit task'}</DialogTitle></DialogHeader>
      {failed ? <AsyncState status="error" skeleton="rows" loadingLabel="Loading agents"
        error={{ message: 'We couldn’t load available agents.', onRetry: () => setRetry(value => value + 1) }} />
        : chosen === undefined && agents === null ? <AsyncState status="loading" skeleton="rows" loadingLabel="Loading agents" />
        : chosen === undefined ? <EmptyState title="No agents are available for a new task" description="Join an agent or create one first." /> : <>
          <RoutineEditor taskMode mode={routineId === undefined ? 'create' : 'edit'}
            agentId={chosen.agentId} agentName={chosen.agentName}
            // The form's agent chip, shown only when there's a choice to make.
            agentChoices={agent === undefined && agents !== null && agents.length > 1
              ? { agents, selected, onSelect: setSelected } : undefined}
            {...(routineId === undefined ? {} : { routine: { routineId } })}
            onPendingChange={setPending} onCancel={() => onOpenChange(false)}
            onSaved={saved => {
              // A landed write invalidates the shell read even after this dialog unmounts.
              onWriteSucceeded();
              if (!alive.current) return;
              setPending(false); onOpenChange(false); onSaved(saved.agentId, saved.routineId);
            }} />
        </>}
      {chosen === undefined && <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>}
    </DialogContent>
  </Dialog>;
}
