import type { Meta, StoryObj } from '@storybook/react-vite';
import { Text } from '../components/Text.js';
import { Stack } from './Stack.js';

const items = (
  <>
    <Text>First item</Text>
    <Text role="meta">Second item, a little longer</Text>
    <Text role="caption">Third</Text>
  </>
);

const meta = {
  title: 'Layout/Stack',
  component: Stack,
  args: { children: items },
} satisfies Meta<typeof Stack>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GapNone: Story = { args: { gap: 'none' } };
export const GapSection: Story = { args: { gap: 'section' } };
export const AlignStart: Story = { args: { align: 'start' } };
export const AlignCenter: Story = { args: { align: 'center' } };
export const AlignEnd: Story = { args: { align: 'end' } };
export const AlignStretch: Story = { args: { align: 'stretch' } };
