/**
 * The header gear from the source design, now that there is something behind it.
 *
 * One preference so far. It lives here as well as on the confirmation bar
 * because a setting a user can only turn ON from a transient prompt is a trap —
 * they need somewhere to find it again and turn it back off, without having to
 * reproduce the moment that offered it.
 */
import { Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { WorkspacePrefs } from '@/lib/workspace-api';

export function SettingsMenu({
  prefs,
  onChange,
}: {
  prefs: WorkspacePrefs;
  onChange: (patch: Partial<WorkspacePrefs>) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground"
          aria-label="Preferences"
        >
          <Settings size={14} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px]">
        <div className="mb-3 text-[13px] font-medium">Preferences</div>

        <div className="flex items-start gap-2.5">
          <Checkbox
            id="pref-auto-dispatch"
            className="mt-0.5"
            checked={prefs.autoDispatchWhenConfident}
            onCheckedChange={(v) =>
              onChange({ autoDispatchWhenConfident: v === true })
            }
          />
          <div className="min-w-0">
            <Label
              htmlFor="pref-auto-dispatch"
              className="cursor-pointer text-[13px] font-normal"
            >
              Send without asking when Auto is sure
            </Label>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              When Auto can tell which agent a request belongs to, send it
              straight there. You are still asked whenever it cannot tell.
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
