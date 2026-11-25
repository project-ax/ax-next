/**
 * Slice 2c — on an editor opened by "Set it up", the parts of the agent's
 * request this editor does NOT carry (see `lib/connector-request-prefill.ts`).
 * Nothing listed here is saved; the admin adds it afterwards if they mean to.
 *
 * Every item is agent-written: React text nodes only, never markup. A note,
 * not an alert — it is advice beside the form, not a failure.
 */
import { Notice, Stack, Text } from '@project-ax/ui';

export function RequestLeftOutNotice({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <Notice tone="info" title="This request also asked for:">
      <Stack gap="sm">
        <ul className="list-disc pl-4">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
        <Text role="meta">These aren’t added here — you can add them after it’s created.</Text>
      </Stack>
    </Notice>
  );
}
