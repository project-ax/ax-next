import { ACTIVE_HOURS_DAYS, type ActiveHoursDay } from '@ax/routines-contract';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ACTIVE_DAY_NAMES } from '@/lib/task-schedule';

/** Undefined means every day visually; only a person changing selection writes days. */
export function ActiveHoursDaySelector({ value, onChange, disabled, invalid, describedBy }: {
  value: ActiveHoursDay[] | undefined;
  onChange: (days: ActiveHoursDay[]) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  return <ToggleGroup type="multiple" variant="outline" size="sm" aria-label="Active days"
    aria-invalid={invalid || undefined} aria-describedby={describedBy}
    value={value ?? [...ACTIVE_HOURS_DAYS]} disabled={Boolean(disabled)}
    onValueChange={days => onChange(ACTIVE_HOURS_DAYS.filter(day => days.includes(day)))}
    className="flex-wrap justify-start">
    {ACTIVE_HOURS_DAYS.map(day => <ToggleGroupItem key={day} value={day} aria-label={ACTIVE_DAY_NAMES[day]}>
      {ACTIVE_DAY_NAMES[day].slice(0, 3)}
    </ToggleGroupItem>)}
  </ToggleGroup>;
}
