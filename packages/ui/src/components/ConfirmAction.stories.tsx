import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { Trash2 } from 'lucide-react';
import { Stack } from '../layout/Stack.js';
import { ConfirmAction, ConfirmActionView } from './ConfirmAction.js';
import { Text } from './Text.js';

// The open dialog renders into a portal under <body>, so this puts a page behind it: something for the scrim to cover,
// and an element in #storybook-root for the screenshot runner to wait on.
const pageBehind: Decorator = (Story) => (
  <Stack gap="sm">
    <Text role="body-strong">Sites</Text>
    <Text>example.com</Text>
    <Story />
  </Stack>
);

const meta = {
  title: 'Components/ConfirmAction',
  decorators: [pageBehind],
} satisfies Meta;

export default meta;
type Story = StoryObj;

const remove = {
  title: 'Remove example.com?',
  description: 'Your agents will stop reaching this site. You can add it again later.',
  confirmLabel: 'Remove site',
} as const;

// Open through the controlled form so the screenshot captures the dialog.
export const Danger: Story = {
  render: () => <ConfirmAction {...remove} onConfirm={() => {}} open onOpenChange={() => {}} />,
};

export const Neutral: Story = {
  render: () => (
    <ConfirmAction
      title="Pause all agents?"
      description="Scheduled tasks wait until you resume them."
      confirmLabel="Pause agents"
      tone="neutral"
      onConfirm={() => {}}
      open
      onOpenChange={() => {}}
    />
  ),
};

// The screenshot runner does not wait for play functions, so the busy and error states are pinned through the
// internal view that ConfirmAction itself renders, rather than by clicking a pending or failing onConfirm.
export const Busy: Story = {
  render: () => (
    <ConfirmActionView {...remove} tone="danger" open onOpenChange={() => {}} busy error={null} onConfirm={() => {}} />
  ),
};

export const Error: Story = {
  render: () => (
    <ConfirmActionView
      {...remove}
      tone="danger"
      open
      onOpenChange={() => {}}
      busy={false}
      error="That didn't work. Try again."
      onConfirm={() => {}}
    />
  ),
};

export const IconTrigger: Story = {
  render: () => (
    <ConfirmAction {...remove} onConfirm={() => {}} trigger={{ label: 'Remove example.com', icon: Trash2, iconOnly: true }} />
  ),
};
