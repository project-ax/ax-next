import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { Inline } from '../layout/Inline.js';
import { Stack } from '../layout/Stack.js';
import { StatusBadge } from './StatusBadge.js';

const meta = {
  title: 'Components/StatusBadge',
  component: StatusBadge,
  args: { tone: 'info', children: 'Working' },
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AllTones: Story = {
  render: () => (
    <Inline gap="md" align="center" wrap>
      <StatusBadge tone="neutral">Resting</StatusBadge>
      <StatusBadge tone="info">Working</StatusBadge>
      <StatusBadge tone="success">Done</StatusBadge>
      <StatusBadge tone="warning">Waiting on you</StatusBadge>
      <StatusBadge tone="danger">Failed</StatusBadge>
    </Inline>
  ),
};

export const WithDot: Story = {
  render: () => (
    <Inline gap="md" align="center" wrap>
      <StatusBadge tone="neutral" dot>Resting</StatusBadge>
      <StatusBadge tone="info" dot>Working</StatusBadge>
      <StatusBadge tone="success" dot>Done</StatusBadge>
      <StatusBadge tone="warning" dot>Waiting on you</StatusBadge>
      <StatusBadge tone="danger" dot>Failed</StatusBadge>
    </Inline>
  ),
};

export const Sizes: Story = {
  render: () => (
    <Stack gap="md" align="start">
      <StatusBadge tone="warning" size="sm" dot>Small</StatusBadge>
      <StatusBadge tone="warning" size="md" dot>Medium</StatusBadge>
    </Stack>
  ),
};

// stories.spec.ts runs at 800px wide, so a decorator pins this story to the 390px phone width.
const phoneWidth: Decorator = (Story) => (
  <div style={{ width: 390 }}>
    <Story />
  </div>
);

export const LongText: Story = {
  decorators: [phoneWidth],
  args: {
    tone: 'warning',
    dot: true,
    children: 'Waiting on you to approve the quarterly report export for the finance team before Friday',
  },
};
