import { Button } from '@/components/ui/button';
import { SetupShell } from './SetupShell';

export function StepDone() {
  return (
    <SetupShell
      title="You're all set"
      description="Setup complete — you can start chatting now."
    >
      <Button asChild className="w-full">
        <a href="/">Open chat →</a>
      </Button>
    </SetupShell>
  );
}
