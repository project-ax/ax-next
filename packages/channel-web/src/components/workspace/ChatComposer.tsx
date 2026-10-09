import { useRef, type ComponentProps, type ReactNode, type Ref } from 'react';
import { ArrowUp, Paperclip, Square } from 'lucide-react';
import { AxDesignMark } from '@/components/AxDesignMark';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
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
  spacious = false,
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
  spacious?: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div className="ax-composer-well">
    <InputGroup aria-label={label} data-spacious={spacious || undefined} className={cn('ax-composer h-auto flex-col items-stretch gap-3 px-5 py-4 focus-within:ring-2 focus-within:ring-ring', spacious && 'ax-composer-welcome')}>
      <InputGroupAddon align="block-start" className="gap-2.5 p-0">
        <AxDesignMark small />
      <InputGroupInput
        {...input}
        ref={inputRef}
        onKeyDown={(event) => event.key === 'Enter' && onSend()}
        className="ax-composer-input h-8 min-w-0 px-0 max-md:h-11"
      />
      </InputGroupAddon>
      <InputGroupAddon align="block-end" className="mt-auto gap-2 p-0">
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
          variant="secondary"
          size="icon"
          className="size-9 shrink-0 max-md:size-11"
          aria-label="Attach a file"
          disabled={attachDisabled}
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip strokeWidth={1.5} aria-hidden="true" />
        </Button>
        {agentSelector}
        <Button
          ref={actionRef}
          type="button"
          size="icon"
          variant={onStop ? 'default' : 'send'}
          className="ml-auto size-9 shrink-0 max-md:size-11"
          aria-label={onStop ? (stopping ? 'Stopping' : 'Stop') : 'Send'}
          disabled={onStop ? stopping : sendDisabled}
          onClick={onStop ?? onSend}
        >
          {onStop ? <Square fill="currentColor" aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
        </Button>
      </InputGroupAddon>
    </InputGroup>
    </div>
  );
}
