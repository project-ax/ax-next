/**
 * The in-thread approval — the attended half of the model.
 *
 * Same Decision row the Today queue renders; different disposition. Because the
 * conversation is attended, the agent is still parked on `session.next-message`
 * and will execute the call itself the moment this resolves. Nothing re-spawns,
 * nothing is replayed, and the world cannot have moved meaningfully in the
 * seconds involved — which is why this card carries no freshness guard while
 * the queue version does.
 *
 * If the human walks away instead, the reaper ends the turn and this exact
 * decision is waiting in Today. Same row, degraded path.
 */
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { Decision } from '@/lib/workspace-api';

interface Props {
  decision: Decision;
  onApprove: () => void;
  onDismiss: () => void;
  onUndo: () => void;
}

export function ApprovalCard({ decision: d, onApprove, onDismiss, onUndo }: Props) {
  if (d.status === 'executed' || d.status === 'dismissed') {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <span>
          {d.status === 'executed' ? d.approvedText : d.dismissedText}.
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onUndo}
          className="h-6 gap-1.5 px-2 text-[12px] text-primary"
        >
          <RotateCcw size={10} />
          Undo
        </Button>
      </div>
    );
  }

  return (
    <Card className="max-w-[560px] border-warning/40 bg-warning-soft/40">
      <CardContent className="p-4">
        <div className="text-[13.5px] font-medium">{d.summary}</div>
        {d.preview && (
          <div className="mt-3 rounded-md bg-background/70 px-3.5 py-3">
            <div className="mb-1.5 text-[11.5px] text-muted-foreground">
              {d.preview.meta}
            </div>
            <div className="text-[13px] leading-relaxed">{d.preview.body}</div>
          </div>
        )}
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onApprove}>
            {d.primaryLabel}
          </Button>
          <Button size="sm" variant="secondary" onClick={onDismiss}>
            {d.secondaryLabel}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {d.ghostLabel}
          </Button>
        </div>
        <p className="mt-2.5 text-[11.5px] text-muted-foreground">
          Nothing is sent until you choose. I am holding here, so we can carry
          straight on.
        </p>
      </CardContent>
    </Card>
  );
}
