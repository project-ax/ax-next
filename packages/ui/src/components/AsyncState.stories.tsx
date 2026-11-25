import type { Meta, StoryObj } from '@storybook/react-vite';
import { AsyncState } from './AsyncState.js';

const meta = {
  title: 'Components/AsyncState',
  component: AsyncState,
  args: { status: 'ready', skeleton: 'rows', loadingLabel: 'Loading sites', children: <p>The content is ready.</p> },
} satisfies Meta<typeof AsyncState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LoadingRows: Story = { args: { status: 'loading', skeleton: 'rows' } };
export const LoadingLines: Story = { args: { status: 'loading', skeleton: 'lines' } };
export const LoadingBlock: Story = { args: { status: 'loading', skeleton: 'block' } };

export const ErrorWithRetry: Story = {
  args: { status: 'error', error: { message: 'We could not load your sites.', onRetry: () => {} } },
};
export const ErrorNoRetry: Story = { args: { status: 'error', error: { message: 'We could not load your sites.' } } };
export const ErrorInfoTone: Story = {
  args: { status: 'error', error: { message: 'Your session expired. Sign in again to continue.', tone: 'info' } },
};

export const Empty: Story = { args: { status: 'empty', empty: { title: 'No sites yet', description: 'Sites you connect will show up here.' } } };
export const Ready: Story = { args: { status: 'ready' } };
