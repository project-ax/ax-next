import { Loader2 } from 'lucide-react';

// Spinners live inside busy buttons only (rule 7). motion-reduce stops the rotation; the icon stays as a static cue.
export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden="true" className={`ax-animate-spin motion-reduce:ax-animate-none ${className ?? ''}`.trim()} />;
}
