import { formatFullTimestamp, formatTimestamp, toDate, type TimestampStyle } from '../internal/time.js';

export type { TimestampStyle };

export interface TimestampProps {
  value: Date | string | number;
  style?: TimestampStyle;
  now?: Date;
}

// Renders nothing for an unparseable value. The component doesn't tick: `now` is read at render.
export function Timestamp({ value, style = 'relative', now }: TimestampProps) {
  const date = toDate(value);
  if (!date) return null;
  const text = formatTimestamp(date, { style, ...(now ? { now } : {}) });
  const full = formatFullTimestamp(date);
  return (
    <time dateTime={date.toISOString()} {...(full ? { title: full } : {})}>
      {text}
      {style === 'relative' && full ? <span className="ax-sr-only"> ({full})</span> : null}
    </time>
  );
}
