import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '../layout/Stack.js';
import { Text } from './Text.js';

const meta = {
  title: 'Components/Text',
  component: Text,
  args: { children: 'The quick brown fox jumps over the lazy dog.' },
} satisfies Meta<typeof Text>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Body: Story = { args: { role: 'body' } };
export const BodyStrong: Story = { args: { role: 'body-strong' } };
export const Meta_: Story = { name: 'Meta', args: { role: 'meta' } };
export const Caption: Story = { args: { role: 'caption' } };
export const Code: Story = { args: { role: 'code', children: 'pnpm --filter @project-ax/ui stories:test' } };

export const AllRoles: Story = {
  render: () => (
    <Stack gap="sm">
      <Text role="body">Body: the quick brown fox jumps over the lazy dog.</Text>
      <Text role="body-strong">Body strong: the quick brown fox jumps over the lazy dog.</Text>
      <Text role="meta">Meta: updated 3 minutes ago</Text>
      <Text role="caption">Caption: a short note under something</Text>
      <Text role="code">const answer = 42;</Text>
    </Stack>
  ),
};

export const InlineRoles: Story = {
  render: () => (
    <Text>
      Body text with <Text inline role="body-strong">strong words</Text>, a{' '}
      <Text inline role="meta">meta aside</Text> and <Text inline role="code">inline code</Text>.
    </Text>
  ),
};

export const Truncate: Story = {
  args: {
    truncate: true,
    children:
      'This line is far too long to fit in the frame, so it stops with an ellipsis instead of wrapping onto a second line, which is what truncate is for in lists and table cells where every row must stay one line tall.',
  },
};
