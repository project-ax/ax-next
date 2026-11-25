import type { Meta, StoryObj } from '@storybook/react-vite';
import { Text } from '../components/Text.js';
import { Grid } from './Grid.js';

const cells = (
  <>
    {Array.from({ length: 8 }, (_, i) => (
      <Text key={i}>Cell {i + 1}</Text>
    ))}
  </>
);

const meta = {
  title: 'Layout/Grid',
  component: Grid,
  args: { columns: 3, children: cells },
} satisfies Meta<typeof Grid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeColumns: Story = {};
export const SevenColumns: Story = { args: { columns: 7 } };
export const GapNone: Story = { args: { gap: 'none' } };
export const GapSection: Story = { args: { gap: 'section' } };
// One column below md (768px), two from md, four from lg (1024px). The 800px test viewport shows the md step.
export const Responsive: Story = { args: { columns: { base: 1, md: 2, lg: 4 } } };
