import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { KeyValueList } from './KeyValueList.js';

const items = [
  { label: 'Owner', value: 'Vinay Pulim' },
  { label: 'Created', value: 'Nov 26, 2026' },
  { label: 'Model', value: 'claude-sonnet-5-5' },
];

const meta = {
  title: 'Components/KeyValueList',
  component: KeyValueList,
  args: { items },
} satisfies Meta<typeof KeyValueList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Rows: Story = { args: { layout: 'rows' } };
export const Stacked: Story = { args: { layout: 'stacked' } };

// stories.spec.ts runs at 800px wide, so a decorator pins this story to the 390px phone width.
const phoneWidth: Decorator = (Story) => (
  <div style={{ width: 390 }}>
    <Story />
  </div>
);

export const LongValue: Story = {
  decorators: [phoneWidth],
  args: {
    layout: 'rows',
    items: [
      { label: 'Owner', value: 'Vinay Pulim' },
      { label: 'Notification delivery preferences for weekly summaries', value: 'Email' },
      { label: 'Endpoint', value: 'https://example.com/a/very/long/path/with/no/natural/breaks/abcdefghijklmnopqrstuvwxyz0123456789' },
      { label: 'Description', value: 'An agent that reads the quarterly finance exports, reconciles them against the ledger, and posts a summary every Friday morning.' },
    ],
  },
};
