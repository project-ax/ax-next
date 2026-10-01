import { useRef, type ComponentProps, type ReactNode, type Ref } from 'react';
import { ArrowUp, MessageSquare, Paperclip, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { ATTACHMENT_ACCEPT } from '@/lib/attachment-upload';

/** Shared by the transcript, Today content, and both composer containers. */
export const CHAT_CONTENT_CLASS = 'mx-auto w-full max-w-[900px] px-6';

/** Controlled presentation; routing, approvals, and draft ownership stay with the view. */
export function ChatComposer({
  label,
  input,
  inputRef,
  agentSelector,
  onAttach,
  attachDisabled,
  onSend,
  sendDisabled,
  actionRef,
  onStop,
  stopping = false,
}: {
  label: string;
  input: Pick<ComponentProps<'input'>, 'value' | 'onChange' | 'placeholder' | 'disabled'>;
  inputRef?: Ref<HTMLInputElement>;
  agentSelector?: ReactNode;
  onAttach: (files: FileList) => void;
  attachDisabled: boolean;
  onSend: () => void;
  sendDisabled: boolean;
  actionRef?: Ref<HTMLButtonElement>;
  onStop?: (() => void) | undefined;
  stopping?: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <InputGroup aria-label={label} className="h-auto gap-2 rounded-xl border-border bg-card px-3 py-2 shadow-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background">
      <InputGroupInput
        {...input}
        ref={inputRef}
        onKeyDown={(event) => event.key === 'Enter' && onSend()}
        className="h-8 min-w-0 px-0 max-md:h-11"
      />
      <InputGroupAddon align="inline-start" className="p-0">
        <MessageSquare aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupAddon align="inline-end" className="gap-2 p-0 has-[>button]:mr-0">
        {agentSelector}
        {/* The labelled button owns the file picker; its plumbing is not a tab stop. */}
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            if (event.target.files) onAttach(event.target.files);
            // Allow picking the same file again after removing it.
            event.target.value = '';
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 max-md:size-11"
          aria-label="Attach a file"
          disabled={attachDisabled}
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip strokeWidth={1.5} aria-hidden="true" />
        </Button>
        <Button
          ref={actionRef}
          type="button"
          size="icon"
          className="size-8 shrink-0 max-md:size-11"
          aria-label={onStop ? (stopping ? 'Stopping' : 'Stop') : 'Send'}
          disabled={onStop ? stopping : sendDisabled}
          onClick={onStop ?? onSend}
        >
          {onStop ? <Square fill="currentColor" aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
        </Button>
      </InputGroupAddon>
    </InputGroup>
  );
}
