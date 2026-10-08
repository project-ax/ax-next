/**
 * Slice 2c — on an editor opened by "Set it up", the parts of the agent's
 * request this editor does NOT carry (see `lib/connector-request-prefill.ts`).
 * Nothing listed here is saved; the admin adds it afterwards if they mean to.
 *
 * Every item is agent-written: React text nodes only, never markup. A note,
 * not an alert — it is advice beside the form, not a failure.
 */
import { Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export function RequestLeftOutNotice({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <Alert role="note" data-testid="request-left-out">
      <Info />
      <AlertTitle>This request also asked for:</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <ul className="list-disc pl-4">
          {items.map((item, i) => (
            <li key={i} className="break-words">
              {item}
            </li>
          ))}
        </ul>
        <p>These aren’t added here — you can add them after it’s created.</p>
      </AlertDescription>
    </Alert>
  );
}
