import { Button } from '@/components/ui/button';
import { SetupShell } from './SetupShell';

export function StepDone() {
  return (
    <SetupShell
      title="You're all set"
      description="Setup complete — you can start chatting now."
    >
      <Button asChild className="w-full">
        {/*
          `/chat`, not `/`: with the agent-workspace preview on, `/` renders the
          workspace, and this button says "Open chat". `/chat` is the chat
          shell's stable address on every deployment — App falls through to chat
          for any path it does not claim, and static-files serves the SPA there.
        */}
        <a href="/chat">Open chat →</a>
      </Button>
    </SetupShell>
  );
}
