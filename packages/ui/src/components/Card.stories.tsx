import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '../layout/Stack.js';
import { Card } from './Card.js';
import { InsetBlock } from './InsetBlock.js';
import { Text } from './Text.js';

const meta = {
  title: 'Components/Card',
  component: Card,
  args: { children: 'placeholder' },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Card label="Summary">
      <Stack gap="sm">
        <Text role="body-strong">Weekly summary</Text>
        <Text role="meta">Posted every Friday morning.</Text>
      </Stack>
    </Card>
  ),
};

// Stands in for a List: rows that run edge to edge with their own dividers.
export const Flush: Story = {
  render: () => (
    <Card flush label="Agents">
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {['Quill', 'Juniper', 'Fern'].map((n, i) => (
          <li key={n} style={{ padding: 12, borderTop: i ? '1px solid hsl(var(--ax-line-soft))' : 'none' }}>
            <Text role="body">{n}</Text>
          </li>
        ))}
      </ul>
    </Card>
  ),
};

export const WithInsetBlock: Story = {
  render: () => (
    <Card>
      <Stack gap="md">
        <Text role="body-strong">Reply preview</Text>
        <InsetBlock>
          <Text role="body">Thanks for the report. I'll have the reconciled numbers to you by Friday.</Text>
        </InsetBlock>
      </Stack>
    </Card>
  ),
};
