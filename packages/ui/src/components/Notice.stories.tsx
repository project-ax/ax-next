import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '../layout/Stack.js';
import { Notice } from './Notice.js';

const meta = {
  title: 'Components/Notice',
  component: Notice,
  args: { tone: 'info', children: 'Your changes were saved.' },
} satisfies Meta<typeof Notice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Info: Story = { args: { tone: 'info' } };
export const Warning: Story = { args: { tone: 'warning', children: 'This site will stop working next week.' } };
export const Danger: Story = { args: { tone: 'danger', children: 'We could not save your changes.' } };
export const Success: Story = { args: { tone: 'success', children: 'Site connected.' } };

export const WithTitle: Story = { args: { tone: 'warning', title: 'Heads up', children: 'This site will stop working next week.' } };

export const WithAction: Story = {
  args: { tone: 'danger', children: 'We could not reach the server.', action: { label: 'Try again', onClick: () => {} } },
};

export const Dismissible: Story = { args: { tone: 'info', onDismiss: () => {} } };

// stories.spec.ts runs at 800px wide, so a decorator pins this story to the 390px phone width.
const phoneWidth: Decorator = (Story) => (
  <div style={{ width: 390 }}>
    <Story />
  </div>
);

export const LongUnbreakableMessage: Story = {
  decorators: [phoneWidth],
  args: {
    tone: 'danger',
    title: 'Could not open the link',
    children: `https://example.com/${'a-very-long-path-segment-'.repeat(8)}end`,
    action: { label: 'Try again', onClick: () => {} },
    onDismiss: () => {},
  },
};

export const AllTones: Story = {
  render: () => (
    <Stack gap="md">
      <Notice tone="info">Info notice</Notice>
      <Notice tone="warning">Warning notice</Notice>
      <Notice tone="danger">Danger notice</Notice>
      <Notice tone="success">Success notice</Notice>
    </Stack>
  ),
};
