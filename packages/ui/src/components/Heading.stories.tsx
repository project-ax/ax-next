import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '../layout/Stack.js';
import { Heading } from './Heading.js';

const meta = {
  title: 'Components/Heading',
  component: Heading,
  args: { children: 'Agents at work' },
} satisfies Meta<typeof Heading>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Display: Story = { args: { role: 'display' } };
export const Title: Story = { args: { role: 'title' } };
export const HeadingRole: Story = { name: 'Heading', args: { role: 'heading' } };
export const Subheading: Story = { args: { role: 'subheading' } };

export const AllRoles: Story = {
  render: () => (
    <Stack gap="sm">
      <Heading role="display">Display</Heading>
      <Heading role="title">Title</Heading>
      <Heading role="heading">Heading</Heading>
      <Heading role="subheading">Subheading</Heading>
    </Stack>
  ),
};
