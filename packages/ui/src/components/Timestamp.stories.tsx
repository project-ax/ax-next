import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '../layout/Stack.js';
import { Text } from './Text.js';
import { Timestamp } from './Timestamp.js';

// Fixed clock so screenshots never drift. Baselines run in a browser pinned to UTC / en-US (playwright.config.ts).
const NOW = new Date('2026-10-23T19:00:00Z');
const at = (iso: string) => iso;

const meta = {
  title: 'Components/Timestamp',
  component: Timestamp,
  args: { value: '2026-10-23T18:55:00Z', now: NOW },
} satisfies Meta<typeof Timestamp>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

const PAST = [
  ['just now', '2026-10-23T18:59:40Z'],
  ['5 min', '2026-10-23T18:55:00Z'],
  ['same day', '2026-10-23T16:00:00Z'],
  ['yesterday', '2026-10-22T16:58:00Z'],
  ['this week', '2026-10-19T10:02:00Z'],
  ['this year', '2026-10-10T19:00:00Z'],
  ['other year', '2025-10-23T19:00:00Z'],
] as const;

const FUTURE = [
  ['in 5 min', '2026-10-23T19:05:00Z'],
  ['today', '2026-10-23T22:00:00Z'],
  ['tomorrow', '2026-10-24T09:00:00Z'],
  ['this week', '2026-10-26T10:02:00Z'],
  ['this year', '2026-11-23T19:00:00Z'],
  ['other year', '2027-01-05T19:00:00Z'],
] as const;

function Rows({ rows, format }: { rows: ReadonlyArray<readonly [string, string]>; format?: 'relative' | 'clock' }) {
  return (
    <Stack gap="sm">
      {rows.map(([label, iso]) => (
        <Text key={label} role="body">
          {label}: <Timestamp value={at(iso)} now={NOW} {...(format ? { format } : {})} />
        </Text>
      ))}
    </Stack>
  );
}

export const AllBuckets = {
  render: () => <Rows rows={PAST} />,
} satisfies Story;

export const FutureBuckets = {
  render: () => <Rows rows={FUTURE} />,
} satisfies Story;

export const Clock = {
  render: () => <Rows rows={[...PAST.slice(1), ...FUTURE.slice(2)]} format="clock" />,
} satisfies Story;
