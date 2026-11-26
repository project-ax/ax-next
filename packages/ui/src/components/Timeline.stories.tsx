import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { StatusBadge } from './StatusBadge.js';
import { StatusMark } from './StatusMark.js';
import { Timeline, TimelineEntry } from './Timeline.js';

// Fixed clock so screenshots never drift. Baselines run in a browser pinned to UTC / en-US (playwright.config.ts).
const NOW = new Date('2026-10-23T19:00:00Z');

const meta = {
  title: 'Components/Timeline',
  component: Timeline,
  args: { label: 'Updates', children: null },
} satisfies Meta<typeof Timeline>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Basic: Story = {
  render: () => (
    <Timeline label="Updates">
      <TimelineEntry
        mark={<StatusMark tone="success" label="On track" />}
        time="2026-10-23T18:55:00Z"
        now={NOW}
        action={{ label: 'See what it did, 5 min ago', href: '#one' }}
      >
        All three invoices matched the ledger.
      </TimelineEntry>
      <TimelineEntry
        mark={<StatusMark tone="warning" label="Needs you" />}
        time="2026-10-22T16:58:00Z"
        now={NOW}
        action={{ label: 'See what it did, Yesterday 4:58 PM', href: '#two' }}
      >
        One invoice has no purchase order.
      </TimelineEntry>
      <TimelineEntry mark={<StatusMark tone="neutral" label="No recent update" />} time="2026-10-10T19:00:00Z" now={NOW}>
        Nothing to report.
      </TimelineEntry>
    </Timeline>
  ),
};

export const WithReplies: Story = {
  render: () => (
    <Timeline label="Updates">
      <TimelineEntry mark={<StatusBadge tone="neutral" size="sm">You</StatusBadge>} time="2026-10-23T18:58:00Z" now={NOW}>
        Use the other bank account for those.
      </TimelineEntry>
      <TimelineEntry mark={<StatusBadge tone="neutral" size="sm">Someone else</StatusBadge>} time="2026-10-23T18:30:00Z" now={NOW}>
        {'Two lines, kept as typed.\nSecond line.'}
      </TimelineEntry>
      <TimelineEntry mark={<StatusMark tone="success" label="On track" />} time="2026-10-23T16:00:00Z" now={NOW}>
        Reconciled the morning batch.
      </TimelineEntry>
    </Timeline>
  ),
};

export const FailureWithDetail: Story = {
  render: () => (
    <Timeline label="Runs">
      <TimelineEntry
        mark={<StatusMark tone="danger" label="Failed" />}
        time="2026-10-23T18:55:00Z"
        now={NOW}
        detail={'It couldn’t sign in to the bank.\nThe saved password was rejected.'}
        action={{ label: 'See what it did, 5 min ago', href: '#fail' }}
      >
        The morning run didn’t finish.
      </TimelineEntry>
    </Timeline>
  ),
};

// stories.spec.ts runs at 800px wide, so a decorator pins this story to the 390px phone width.
const phoneWidth: Decorator = (Story) => (
  <div style={{ width: 390 }}>
    <Story />
  </div>
);

const LONG = 'Pulled the quarterly numbers and found a mismatch between the ledger and the bank export that needs a look';

export const LongText: Story = {
  decorators: [phoneWidth],
  render: () => (
    <Timeline label="Long entries">
      <TimelineEntry
        mark={<StatusMark tone="warning" label="Needs you" />}
        time="2026-10-23T18:55:00Z"
        now={NOW}
        action={{ label: 'See what it did, 5 min ago', href: '#long' }}
      >
        {`${LONG}. ${LONG}. ${LONG}.`}
      </TimelineEntry>
      <TimelineEntry mark={<StatusBadge tone="neutral" size="sm">You</StatusBadge>} time="2026-10-23T18:30:00Z" now={NOW}>
        {`${LONG}-${LONG}`.replace(/\s/g, '_')}
      </TimelineEntry>
    </Timeline>
  ),
};
