import { Button } from '@/components/ui/button';
import { SetupShell } from './SetupShell';

export function StepDone() {
  return (
    <SetupShell
      title="You're all set"
      description="Setup complete — your workspace is ready."
    >
      <Button asChild className="w-full">
        {/*
          `/`, not `/chat`: chat was deleted in TASK-360 and `/chat` only
          redirects here now. A link should not point at a redirect.
        */}
        <a href="/">Open your workspace →</a>
      </Button>
    </SetupShell>
  );
}
