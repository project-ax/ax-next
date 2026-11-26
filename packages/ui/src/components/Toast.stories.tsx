import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { toast, ToastRegion, type ToastInput } from './Toast.js';

// Stories seed the module-singleton store on mount; sticky tones (warning, danger) keep the screenshot stable.
// The region mounts only after seeding, so the screenshot runner's wait on #storybook-root sees the toasts.
function Seed({ items }: { items: ToastInput[] }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const ids = items.map((i) => toast.show(i));
    setReady(true);
    return () => {
      setReady(false);
      ids.forEach((id) => toast.dismiss(id));
    };
  }, [items]);
  return ready ? <ToastRegion /> : null;
}

const meta = { title: 'Components/Toast' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const INFO: ToastInput[] = [{ title: 'Link copied', description: 'Anyone with the link can view.', duration: 600_000 }];
const DANGER: ToastInput[] = [{ title: 'Could not save', description: 'Check your connection and try again.', tone: 'danger' }];
const STACK: ToastInput[] = [
  { title: 'Site connected', tone: 'success', duration: 600_000 },
  { title: 'Storage almost full', description: 'You have used 90% of your space.', tone: 'warning' },
  { title: 'Could not save', tone: 'danger' },
];

const seeded = (items: ToastInput[]): Decorator => () => <Seed items={items} />;

export const Info: Story = { decorators: [seeded(INFO)] };
export const Danger: Story = { decorators: [seeded(DANGER)] };
export const StackOfThree: Story = { decorators: [seeded(STACK)] };
