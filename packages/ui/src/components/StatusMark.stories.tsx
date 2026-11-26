import type { Meta, StoryObj } from '@storybook/react-vite';
import { Inline } from '../layout/Inline.js';
import { StatusMark } from './StatusMark.js';

const meta = {
  title: 'Components/StatusMark',
  component: StatusMark,
  args: { tone: 'warning', label: 'Waiting on you' },
} satisfies Meta<typeof StatusMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WaitingOnYou: Story = {};

export const AllTones: Story = {
  render: () => (
    <Inline gap="lg" align="center">
      <StatusMark tone="neutral" label="Resting" />
      <StatusMark tone="info" label="Working" />
      <StatusMark tone="success" label="Done" />
      <StatusMark tone="warning" label="Waiting on you" />
      <StatusMark tone="danger" label="Failed" />
    </Inline>
  ),
};
