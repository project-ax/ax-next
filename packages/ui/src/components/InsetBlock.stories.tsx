import type { Meta, StoryObj } from '@storybook/react-vite';
import { InsetBlock } from './InsetBlock.js';
import { Text } from './Text.js';

const meta = {
  title: 'Components/InsetBlock',
  component: InsetBlock,
  args: { children: 'placeholder' },
} satisfies Meta<typeof InsetBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Quote: Story = {
  render: () => (
    <InsetBlock label="Quoted message">
      <Text role="body">“Can you move the review to Thursday? Friday is the offsite and half the team will be out.”</Text>
    </InsetBlock>
  ),
};
