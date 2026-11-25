import type { Meta, StoryObj } from '@storybook/react-vite';
import { Heading } from '../components/Heading.js';
import { Text } from '../components/Text.js';
import { Inline } from './Inline.js';

const items = (
  <>
    <Text inline>Alpha</Text>
    <Text inline role="meta">
      Beta
    </Text>
    <Text inline role="caption">
      Gamma
    </Text>
  </>
);

// Mixed sizes so cross-axis alignment is visible.
const mixed = (
  <>
    <Heading role="display">Big</Heading>
    <Text inline>Body</Text>
    <Text inline role="caption">
      caption
    </Text>
  </>
);

const many = (
  <>
    {Array.from({ length: 24 }, (_, i) => (
      <Text inline key={i}>
        Item {i + 1}
      </Text>
    ))}
  </>
);

const meta = {
  title: 'Layout/Inline',
  component: Inline,
  args: { children: items },
} satisfies Meta<typeof Inline>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GapNone: Story = { args: { gap: 'none' } };
export const GapSection: Story = { args: { gap: 'section' } };
export const AlignStart: Story = { args: { align: 'start', children: mixed } };
export const AlignCenter: Story = { args: { align: 'center', children: mixed } };
export const AlignEnd: Story = { args: { align: 'end', children: mixed } };
export const AlignBaseline: Story = { args: { align: 'baseline', children: mixed } };
export const JustifyStart: Story = { args: { justify: 'start' } };
export const JustifyBetween: Story = { args: { justify: 'between' } };
export const JustifyEnd: Story = { args: { justify: 'end' } };
export const Wrap: Story = { args: { wrap: true, gap: 'lg', children: many } };
export const NoWrap: Story = { args: { gap: 'lg', children: many } };
