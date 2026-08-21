/**
 * New agent — a brief, then a conversation.
 *
 * The source design made this a form: a textarea plus three permission
 * checkboxes. A form cannot produce a working agent — it has nowhere to put
 * tools, connectors, a schedule, or the twenty questions that actually decide
 * how the thing behaves — and the checkboxes imply a permission model far
 * cruder than the one that exists.
 *
 * So: one honest field, and then the agent asks the rest itself. This is the
 * conversational-identity flow that already ships (`@ax/agent-identity-templates`,
 * the agents-author-their-own-identity epic), pointed at setup. The brief is the
 * first message of the conversation rather than a config value, which is also
 * why it needs no validation beyond "not empty".
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export function NewAgentView({
  onBack,
  onCreate,
}: {
  onBack: () => void;
  onCreate: (brief: string) => void;
}) {
  const [brief, setBrief] = useState('');
  const ready = brief.trim().length > 0;

  return (
    <div className="mx-auto w-full max-w-[640px] px-6 py-8">
      <h2 className="text-[19px] font-medium tracking-[-0.015em]">
        What should it do?
      </h2>
      <p className="mt-2 max-w-[520px] text-[13.5px] leading-relaxed text-muted-foreground text-pretty">
        Describe the job in a sentence, the way you would brief a person. It will
        ask you the rest itself — what to call it, what it may do on its own,
        when to bring things to you.
      </p>

      <Textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        placeholder="Watch #incidents and tell me only when something needs a decision from me."
        className="mt-5 min-h-[110px] resize-none text-[13.5px] leading-relaxed"
      />

      <div className="mt-4 flex items-center gap-2">
        <Button disabled={!ready} onClick={() => onCreate(brief.trim())}>
          Start the conversation
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Cancel
        </Button>
      </div>

      <p className="mt-6 rounded-lg bg-muted px-3.5 py-3 text-[12px] leading-relaxed text-muted-foreground">
        Nothing runs until you have agreed what it may do. A new agent starts
        with no permissions at all — it can talk to you and nothing else.
      </p>
    </div>
  );
}
