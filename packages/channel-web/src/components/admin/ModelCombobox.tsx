import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ModelComboboxGroup {
  providerName: string;
  models: string[];
}

export interface ModelComboboxProps {
  ariaLabel: string;
  groups: ModelComboboxGroup[];
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ModelCombobox({
  ariaLabel,
  groups,
  value,
  onChange,
  disabled,
  placeholder = '— Select a model —',
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            'w-full justify-between font-mono text-[13px] tracking-[0.02em]',
            !value && 'text-muted-foreground',
          )}
        >
          {value || placeholder}
          <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]" align="start">
        <Command>
          <CommandInput placeholder="Search or pick a model…" />
          <CommandList>
            <CommandEmpty>No model matches.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.providerName} heading={group.providerName}>
                {group.models.map((model) => (
                  <CommandItem
                    key={model}
                    value={model}
                    onSelect={(selected) => {
                      onChange(selected);
                      setOpen(false);
                    }}
                    className="font-mono text-[12.5px]"
                  >
                    <span className="flex-1">{model}</span>
                    {value === model && (
                      <Check className="h-3.5 w-3.5 text-primary" strokeWidth={2.5} />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
