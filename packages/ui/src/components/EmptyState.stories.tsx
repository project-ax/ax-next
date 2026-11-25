import type { Meta, StoryObj } from '@storybook/react-vite';
import { Inbox } from 'lucide-react';
import { EmptyState } from './EmptyState.js';

const meta = {
  title: 'Components/EmptyState',
  component: EmptyState,
  args: { title: 'No sites yet' },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Basic: Story = { args: { description: 'Sites you connect will show up here.' } };
export const WithAction: Story = {
  args: { description: 'Sites you connect will show up here.', action: { label: 'Connect a site', onClick: () => {} } },
};
export const WithIcon: Story = { args: { icon: Inbox, description: 'Sites you connect will show up here.' } };
export const LongTitle: Story = {
  args: {
    title: 'There is nothing to show here yet because nothing has been connected to this workspace',
    description: 'Connect something to get started.',
    icon: Inbox,
  },
};
