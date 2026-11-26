import * as Tooltip from '@radix-ui/react-tooltip';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus, Trash2 } from 'lucide-react';
import { ButtonBase } from '../internal/ButtonBase.js';
import { Inline } from '../layout/Inline.js';
import { IconButton, TOOLTIP_CLASS } from './IconButton.js';

const meta = {
  title: 'Components/IconButton',
  component: IconButton,
  args: { label: 'Add item', icon: Plus },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Quiet: Story = { args: { intent: 'quiet' } };
export const Secondary: Story = { args: { intent: 'secondary' } };
export const Busy: Story = { args: { busy: true } };
export const Sizes: Story = {
  render: () => (
    <Inline gap="md">
      <IconButton label="Add item" icon={Plus} size="md" />
      <IconButton label="Remove item" icon={Trash2} size="sm" />
    </Inline>
  ),
};

// IconButton has no defaultOpen prop (a public prop would be a stray escape hatch), so this assembles the same tree with the tooltip forced open.
export const TooltipOpen: Story = {
  render: () => (
    <>
      <Tooltip.Provider>
        <Tooltip.Root defaultOpen>
          <Tooltip.Trigger asChild>
            <ButtonBase intent="quiet" size="md" icon={Plus} iconOnly aria-label="Add item" />
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className={TOOLTIP_CLASS} side="bottom" sideOffset={4}>
              Add item
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    </>
  ),
};
