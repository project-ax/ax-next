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

const SAVED_BY_TAG = new Map<string, string>([
  ['person', 'HUMAN'],
  ['agent', 'AGENT'],
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

export function renderEvidenceTable(rows: readonly MemoryStatement[], asOf: string, includeIds = false): string {
  const ordered = [...rows].sort(
    (a, b) => a.when.localeCompare(b.when) || a.id.localeCompare(b.id),
  );
  return [
    includeIds ? '| ID | Network | When | Conv | Statement |' : '| Network | When | Conv | Statement |',
    includeIds ? '| :---- | :---- | :---- | :---- | :---- |' : '| :---- | :---- | :---- | :---- |',
    ...ordered.map((row) => {
      const words = (value: string) => value.replace(/_/g, ' ').trim();
      // The caller's own subject is stored as `user:<id>`; DEM canonicalized
      // the speaker as the literal `user`, so that is what the model reads.
      // Other subjects go through the recall surface's `aboutText`, which
      // never carries another person's raw id.
      const subject =
        row.aboutText === 'you' ? 'user' : row.aboutText !== undefined ? row.aboutText : words(row.about);
      const statement = `${escapeStatementText(subject)} ${escapeStatementText(words(row.relation))}: ${escapeStatementText(row.value)}`;
      // A kind-less row is not unknown when we know who saved it.
      const tag =
        row.kind !== undefined
          ? (NETWORK_TAG.get(row.kind) ?? 'UNKNOWN')
          : (SAVED_BY_TAG.get(row.savedBy ?? '') ?? 'UNKNOWN');
      // `conversation` is a per-answer ordinal, never the raw conversation
      // id (see MemoryStatement.conversation) — `-` means "recorded outside
      // a conversation", not "unknown".
      const conv = typeof row.conversation === 'number' ? `#${row.conversation}` : '-';
      return `| ${includeIds ? `${escapeStatementText(row.id)} | ` : ''}[${tag}] | ${escapeStatementText(formatEvidenceWhen(row, asOf))} | ${conv} | ${statement} |`;
    }),
  ].join('\n');
}

export function renderRecallResult(result: MemoryRecallOutput, asOf: string, recallId?: string): string {
  const date = new Date(asOf);
  const distinctConversations = new Set(
    result.statements
      .map((row) => row.conversation)
      .filter((conversation): conversation is number => typeof conversation === 'number'),
  ).size;
  return [
    `Today is ${asOf.slice(0, 10)} (${WEEKDAY_LONG[date.getUTCDay()]}).`,
    ...(result.degraded.length > 0
      ? [`Degraded: ${result.degraded.map((flag) => escapeStatementText(String(flag))).join(', ')}`]
      : []),
    ...(recallId !== undefined ? [
      `Recall ID: ${recallId}`,
      'These are search candidates. Before answering, call memory_use with this Recall ID and only the evidence IDs that support your answer. Unrelated candidates are not used memories. Do not display these IDs in your answer.',
    ] : []),
    'Ground all claims in the evidence table. Never invent entities, events, dates, or preferences.',
    `Distinct conversations in this evidence: ${distinctConversations}.`,
    '',
    'Evidence table:',
    renderEvidenceTable(result.statements, asOf, recallId !== undefined),
  ].join('\n');
}
