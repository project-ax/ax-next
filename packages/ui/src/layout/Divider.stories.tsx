import type { Meta, StoryObj } from '@storybook/react-vite';
import { Text } from '../components/Text.js';
import { Divider } from './Divider.js';
import { Inline } from './Inline.js';
import { Stack } from './Stack.js';

const meta = {
  title: 'Layout/Divider',
  component: Divider,
} satisfies Meta<typeof Divider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  render: () => (
    <Stack>
      <Text>Above the line</Text>
      <Divider />
      <Text>Below the line</Text>
    </Stack>
  ),
};

export const Vertical: Story = {
  render: () => (
    <Inline gap="md">
      <Text inline>Left</Text>
      <Divider orientation="vertical" />
      <Stack gap="xs">
        <Text>Right, first line</Text>
        <Text role="meta">Right, second line</Text>
      </Stack>
    </Inline>
  ),
};
