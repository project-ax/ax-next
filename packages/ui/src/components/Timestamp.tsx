import { formatFullTimestamp, formatTimestamp, toDate, type TimestampFormat } from '../internal/time.js';

export type { TimestampFormat };

export interface TimestampProps {
  value: Date | string | number;
  format?: TimestampFormat;
  now?: Date;
}

// Renders nothing for an unparseable value. The component doesn't tick: `now` is read at render.
export function Timestamp({ value, format = 'relative', now }: TimestampProps) {
  const date = toDate(value);
  if (!date) return null;
  const text = formatTimestamp(date, { format, ...(now ? { now } : {}) });
  const full = formatFullTimestamp(date);
  return (
    <time dateTime={date.toISOString()} {...(full ? { title: full } : {})}>
      {text}
      {format === 'relative' && full ? <span className="ax-sr-only"> ({full})</span> : null}
    </time>
  );
}
