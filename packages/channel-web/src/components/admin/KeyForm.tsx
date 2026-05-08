import { useState, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface KeyFormProps {
  /** Placeholder for the key input. */
  placeholder?: string;
  /** Aria label for the key input. */
  inputLabel?: string;
  /** Validation error returned by the backend. */
  error?: string;
  /** True while the parent is awaiting a save round-trip. */
  saving?: boolean;
  /** Optional helper line shown to the right of the actions (e.g., "Get a key at console.anthropic.com"). */
  helperRight?: ReactNode;
  onSave: (key: string) => void | Promise<void>;
  onCancel: () => void;
}

export function KeyForm({
  placeholder = 'Paste your API key',
  inputLabel = 'API key',
  error,
  saving,
  helperRight,
  onSave,
  onCancel,
}: KeyFormProps) {
  const [key, setKey] = useState('');
  const trimmed = key.trim();

  return (
    <div className="mt-3.5 p-3.5 bg-muted border border-rule-soft rounded-lg flex flex-col gap-2.5 animate-form-in">
      <Input
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={placeholder}
        aria-label={inputLabel}
        disabled={!!saving}
        className="font-mono text-[13px] tracking-[0.02em]"
      />
      {error && (
        <div
          role="alert"
          className={cn(
            'inline-flex items-center gap-2 px-2.5 py-2 self-start',
            'bg-destructive-soft border border-destructive/25 rounded-md',
            'text-[12.5px] text-destructive',
          )}
        >
          <AlertCircle className="w-3 h-3 shrink-0" strokeWidth={2.5} />
          <span>{error}</span>
        </div>
      )}
      <div className="flex gap-2 items-center">
        <Button
          type="button"
          onClick={() => void onSave(trimmed)}
          disabled={!!saving || trimmed.length === 0}
        >
          {saving ? 'Validating…' : error ? 'Retry' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={!!saving}>
          Cancel
        </Button>
        {helperRight && (
          <span className="ml-auto text-[11.5px] text-muted-foreground">
            {helperRight}
          </span>
        )}
      </div>
    </div>
  );
}
