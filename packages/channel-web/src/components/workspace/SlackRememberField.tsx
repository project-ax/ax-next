/**
 * The "remember this channel" switch of one Slack channel row (TASK-1180),
 * in the agent's own bot's list. A manager gets the switch; anyone else reads the note, and only
 * while memory is on.
 *
 * Never optimistic: `busy` disables the switch at its old position, and the
 * caller moves `remember` only once the server holds the write.
 */
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';

export interface SlackRememberFieldProps {
  /** The Switch's id; its note is `${id}-note`. */
  id: string;
  agentName: string;
  remember: boolean;
  /** A manager gets the Switch; anyone else the note, only while it is on. */
  canManage: boolean;
  /** Disables the Switch at its old position. */
  busy: boolean;
  onChange: (on: boolean) => void;
}

export function SlackRememberField({ id, agentName, remember, canManage, busy, onChange }: SlackRememberFieldProps) {
  // What people without access to the agent say is never remembered, whatever the switch says (channel-slack's capture veto).
  const note = `${agentName} remembers what people with access to it say here. It never remembers what anyone else says.`;
  if (!canManage) {
    return remember ? <p className="text-[12.5px] text-muted-foreground">{note}</p> : null;
  }
  return (
    <Field orientation="horizontal">
      <Switch
        id={id}
        checked={remember}
        disabled={busy}
        onCheckedChange={onChange}
        aria-describedby={`${id}-note`}
      />
      <FieldContent>
        <FieldLabel htmlFor={id} className="font-normal">
          Let {agentName} remember this channel
        </FieldLabel>
        <FieldDescription id={`${id}-note`}>When this is on, {note}</FieldDescription>
      </FieldContent>
    </Field>
  );
}
