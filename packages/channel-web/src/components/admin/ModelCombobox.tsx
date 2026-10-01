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
  labels?: ReadonlyMap<string, string>;
}

export interface ModelComboboxProps {
  ariaLabel: string;
  groups: ModelComboboxGroup[];
  value: string;
  valueLabel?: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ModelCombobox({
  ariaLabel,
  groups,
  value,
  valueLabel,
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
            'w-full justify-between',
            !value && 'text-muted-foreground',
          )}
        >
          <span className="truncate">{valueLabel || value || placeholder}</span>
          <ChevronDown data-icon="inline-end" />
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
                    keywords={[group.labels?.get(model) ?? model, group.providerName]}
                    title={model}
                    onSelect={() => {
                      onChange(model);
                      setOpen(false);
                    }}
                  >
                    <span className="flex-1 truncate">{group.labels?.get(model) ?? model}</span>
                    {value === model && (
                      <Check aria-hidden="true" strokeWidth={2.5} />
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
