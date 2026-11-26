import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { Inline } from '../layout/Inline.js';
import { Stack } from '../layout/Stack.js';
import { Avatar } from './Avatar.js';

const meta = {
  title: 'Components/Avatar',
  component: Avatar,
  args: { name: 'Quill Bot' },
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Sizes: Story = {
  render: () => (
    <Inline gap="md" align="center">
      <Avatar name="Quill Bot" size="xs" />
      <Avatar name="Quill Bot" size="sm" />
      <Avatar name="Quill Bot" size="md" />
      <Avatar name="Quill Bot" size="lg" />
    </Inline>
  ),
};

export const ShapesAndTones: Story = {
  render: () => (
    <Stack gap="md" align="start">
      <Inline gap="md" align="center">
        <Avatar name="Quill Bot" shape="square" tone="brand" size="lg" />
        <Avatar name="Quill Bot" shape="round" tone="brand" size="lg" />
      </Inline>
      <Inline gap="md" align="center">
        <Avatar name="Vinay Pulim" shape="square" tone="neutral" size="lg" />
        <Avatar name="Vinay Pulim" shape="round" tone="neutral" size="lg" />
      </Inline>
    </Stack>
  ),
};

// stories.spec.ts runs at 800px wide, so a decorator pins this story to the 390px phone width.
const phoneWidth: Decorator = (Story) => (
  <div style={{ width: 390 }}>
    <Story />
  </div>
);

export const LongName: Story = {
  decorators: [phoneWidth],
  args: { name: 'Extraordinarily-Long-Agent-Name-That-Goes-On And-On-And-On-Forever-And-Ever', size: 'lg' },
};
