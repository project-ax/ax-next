import { useEffect, useId, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
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
  const id = useId();
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
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
      onEscapeKeyDown={event => { if (pending) event.preventDefault(); }}
      onInteractOutside={event => { if (pending) event.preventDefault(); }}
      onCloseAutoFocus={event => { event.preventDefault(); onClosed(); }}>
      <DialogHeader><DialogTitle>{routineId === undefined ? 'New task' : 'Edit task'}</DialogTitle>
        <DialogDescription>Choose the work and when your agent should do it. Your changes save directly.</DialogDescription></DialogHeader>
      {failed ? <Alert variant="destructive"><AlertDescription>We couldn’t load available agents.
        <Button variant="outline" onClick={() => setRetry(value => value + 1)}>Try again</Button></AlertDescription></Alert>
        : chosen === undefined && agents === null ? <Spinner aria-label="Loading agents" />
        : chosen === undefined ? <p>No agents are available for a new task. Join an agent or create one first.</p> : <>
          {agent === undefined && agents !== null && agents.length > 1 ? <Field>
            <FieldLabel htmlFor={id}>Agent</FieldLabel>
            <Select value={selected} onValueChange={setSelected} disabled={pending}>
              <SelectTrigger id={id} aria-label="Agent"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{agents.map(item => <SelectItem key={item.agentId} value={item.agentId}>{item.agentName}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field> : <p className="text-sm text-muted-foreground">With {chosen.agentName}</p>}
          <RoutineEditor taskMode mode={routineId === undefined ? 'create' : 'edit'}
            agentId={chosen.agentId} agentName={chosen.agentName}
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
