import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus } from 'lucide-react';
import { Inline } from '../layout/Inline.js';
import { Stack } from '../layout/Stack.js';
import { Button, type ButtonIntent, type ButtonSize } from './Button.js';

const meta = {
  title: 'Components/Button',
  component: Button,
  args: { children: 'Save changes' },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

const intents: ButtonIntent[] = ['primary', 'secondary', 'quiet'];
const sizes: ButtonSize[] = ['md', 'sm'];

export const Primary: Story = { args: { intent: 'primary' } };
export const Secondary: Story = { args: { intent: 'secondary' } };
export const Quiet: Story = { args: { intent: 'quiet' } };

export const AllIntentsAndSizes: Story = {
  render: () => (
    <Stack gap="md" align="start">
      {sizes.map((size) => (
        <Inline key={size} gap="md">
          {intents.map((intent) => (
            <Button key={intent} intent={intent} size={size}>
              {intent} {size}
            </Button>
          ))}
        </Inline>
      ))}
    </Stack>
  ),
};

export const Busy: Story = {
  render: () => (
    <Stack gap="md" align="start">
      {intents.map((intent) => (
        <Inline key={intent} gap="md">
          <Button intent={intent}>Save changes</Button>
          <Button intent={intent} busy>
            Save changes
          </Button>
          <Button intent={intent} busy icon={Plus}>
            Add site
          </Button>
        </Inline>
      ))}
    </Stack>
  ),
};

export const Disabled: Story = {
  render: () => (
    <Inline gap="md">
      {intents.map((intent) => (
        <Button key={intent} intent={intent} disabled>
          {intent}
        </Button>
      ))}
    </Inline>
  ),
};

export const WithIcon: Story = { args: { icon: Plus, children: 'Add site', intent: 'primary' } };

export const LongLabel: Story = {
  args: { children: 'Review every pending change across all connected workspaces before publishing' },
};
