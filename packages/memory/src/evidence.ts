import { escapeStatementText } from './render.js';
import type {
  MemoryRecallOutput,
  MemoryStatement,
  MemoryStatementKind,
} from './types.js';

const MS_PER_DAY = 86_400_000;
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const NETWORK_TAG = new Map<MemoryStatementKind, string>([
  ['world', 'FACT'],
  ['experience', 'FACT'],
  ['observation', 'OBS'],
  ['opinion', 'OPIN'],
]);

function utcMidnight(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function monthsBetween(from: Date, to: Date): number {
  const whole =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth()) -
    (to.getUTCDate() < from.getUTCDate() ? 1 : 0);
  const advanced = Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + whole, from.getUTCDate());
  const next = Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + whole + 1, from.getUTCDate());
  const span = (next - advanced) / MS_PER_DAY;
  const remainder = (utcMidnight(to) - advanced) / MS_PER_DAY;
  return span > 0 ? whole + remainder / span : whole;
}

export function relativeTime(fromIso: string, toIso: string): string {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return '';

  const days = Math.round((utcMidnight(to) - utcMidnight(from)) / MS_PER_DAY);
  if (days === 0) return 'today';
  const past = days > 0;
  const magnitude = Math.abs(days);

  let span: string;
  if (magnitude < 14) {
    span = plural(magnitude, 'day');
  } else if (magnitude < 56) {
    span = plural(Math.round(magnitude / 7), 'week');
  } else {
    const months = Math.round(monthsBetween(past ? from : to, past ? to : from));
    if (months < 24) {
      span = plural(months, 'month');
    } else {
      const years = Math.floor(months / 12);
      const remainder = months % 12;
      span =
        remainder === 0
          ? plural(years, 'year')
          : `${plural(years, 'year')} ${plural(remainder, 'month')}`;
    }
  }
  return past ? `${span} ago` : `in ${span}`;
}

export function formatEvidenceWhen(
  row: Pick<MemoryStatement, 'when' | 'until'>,
  asOf: string,
): string {
  const date = row.when.slice(0, 10);
  const weekday = WEEKDAY_SHORT[new Date(row.when).getUTCDay()] ?? '';
  const when = `${date} (${weekday}, ${relativeTime(row.when, asOf)})`;
  return row.until === undefined ? when : `${when} → superseded ${row.until.slice(0, 10)}`;
}

export function renderEvidenceTable(rows: readonly MemoryStatement[], asOf: string): string {
  const ordered = [...rows].sort(
    (a, b) => a.when.localeCompare(b.when) || a.id.localeCompare(b.id),
  );
  return [
    '| Network | When | Statement |',
    '| :---- | :---- | :---- |',
    ...ordered.map((row) => {
      const words = (value: string) => value.replace(/_/g, ' ').trim();
      const statement = `${escapeStatementText(words(row.about))} ${escapeStatementText(words(row.relation))}: ${escapeStatementText(row.value)}`;
      const tag = row.kind === undefined ? 'UNKNOWN' : (NETWORK_TAG.get(row.kind) ?? 'UNKNOWN');
      return `| [${tag}] | ${escapeStatementText(formatEvidenceWhen(row, asOf))} | ${statement} |`;
    }),
  ].join('\n');
}

export function renderRecallResult(result: MemoryRecallOutput, asOf: string): string {
  const date = new Date(asOf);
  return [
    `Today is ${asOf.slice(0, 10)} (${WEEKDAY_LONG[date.getUTCDay()]}).`,
    ...(result.degraded.length > 0
      ? [`Degraded: ${result.degraded.map((flag) => escapeStatementText(String(flag))).join(', ')}`]
      : []),
    'Ground all claims in the evidence table. Never invent entities, events, dates, or preferences.',
    '',
    'Evidence table:',
    renderEvidenceTable(result.statements, asOf),
  ].join('\n');
}
