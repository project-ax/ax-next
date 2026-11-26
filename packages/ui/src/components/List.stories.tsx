import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Stack } from '../layout/Stack.js';
import { Avatar } from './Avatar.js';
import { IconButton } from './IconButton.js';
import { List, ListRow } from './List.js';
import { StatusMark } from './StatusMark.js';
import { Text } from './Text.js';

const meta = {
  title: 'Components/List',
  component: List,
  args: { label: 'Connectors', children: null },
} satisfies Meta<typeof List>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Basic: Story = {
  render: () => (
    <List label="Connectors">
      <ListRow title="GitHub" meta="12 tools" />
      <ListRow title="Linear" meta="8 tools" />
      <ListRow title="Google Drive" meta="5 tools" />
    </List>
  ),
};

export const WithLeadingAvatar: Story = {
  render: () => (
    <List label="Agents">
      <ListRow leading={<Avatar name="Quill Bot" size="lg" />} title="Quill Bot" meta="Writes the weekly report" />
      <ListRow leading={<Avatar name="Juniper" size="lg" />} title="Juniper" meta="Triage for support tickets" />
      <ListRow leading={<Avatar name="Fern" size="lg" tone="neutral" />} title="Fern" meta="Paused" />
    </List>
  ),
};

export const WithStatusMark: Story = {
  render: () => (
    <List label="Tasks">
      <ListRow leading={<StatusMark tone="warning" label="Waiting on you" />} title="Approve the invoice export" meta="Waiting on you" />
      <ListRow leading={<StatusMark tone="info" label="Working" />} title="Summarize the board meeting" meta="Working" />
      <ListRow leading={<StatusMark tone="success" label="Done" />} title="Draft the release notes" meta="Done" />
      <ListRow leading={<StatusMark tone="danger" label="Failed" />} title="Sync the CRM" meta="Failed" />
    </List>
  ),
};

// The counter line lets stories.spec.ts prove where a click or key press landed.
function OpenableDemo({ withTrailing }: { withTrailing: boolean }) {
  const [opened, setOpened] = useState<string[]>([]);
  const [on, setOn] = useState<Record<string, boolean>>({ GitHub: true, Linear: false });
  const [removed, setRemoved] = useState<string[]>([]);
  const names = ['GitHub', 'Linear'].filter((n) => !removed.includes(n));
  return (
    <Stack gap="md">
      <List label="Connectors">
        {names.map((name) => (
          <ListRow
            key={name}
            title={name}
            meta={name === 'GitHub' ? '12 tools' : '8 tools'}
            description={name === 'GitHub' ? 'Issues, pull requests and code search.' : 'Issues and projects.'}
            onOpen={() => setOpened((o) => [...o, name])}
            {...(withTrailing
              ? {
                  trailing: (
                    <>
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={`Use ${name}`}
                        checked={on[name] ?? false}
                        onChange={(e) => setOn((s) => ({ ...s, [name]: e.target.checked }))}
                      />
                      <IconButton label={`Remove ${name}`} icon={Trash2} onClick={() => setRemoved((r) => [...r, name])} />
                    </>
                  ),
                }
              : {})}
          />
        ))}
      </List>
      <Text role="meta">{`Opened: ${opened.length === 0 ? 'nothing yet' : opened.join(', ')}`}</Text>
    </Stack>
  );
}

export const Openable: Story = { render: () => <OpenableDemo withTrailing={false} /> };

export const OpenableWithTrailingSwitch: Story = { render: () => <OpenableDemo withTrailing /> };

// Expand-only rows toggle from the whole row (the title is the toggle, the chevron is decorative). An openable row
// keeps its title for opening, so its chevron is a separate button named by `label`.
export const Expandable: Story = {
  render: () => (
    <List label="About this task">
      <ListRow
        title="Instructions"
        meta="Edited yesterday"
        expandable={{
          defaultOpen: true,
          content: 'Every Monday, collect the open invoices and post a summary to the finance channel.',
        }}
      />
      <ListRow title="Schedule" meta="Mondays at 9:00 AM" expandable={{ content: 'Runs weekly.' }} />
      <ListRow
        title="Last run"
        meta="Succeeded"
        onOpen={() => {}}
        expandable={{ label: 'Show details for Last run', content: 'Posted 12 invoices to #finance.' }}
      />
    </List>
  ),
};

export const Compact: Story = {
  render: () => (
    <List label="Chats" density="compact">
      <ListRow title="Quarterly planning" href="#quarterly" />
      <ListRow title="Invoice follow-ups" href="#invoices" />
      <ListRow title="Release notes draft" href="#release" />
    </List>
  ),
};

// stories.spec.ts runs at 800px wide, so a decorator pins this story to the 390px phone width.
const phoneWidth: Decorator = (Story) => (
  <div style={{ width: 390 }}>
    <Story />
  </div>
);

const LONG = 'Quarterly finance export for the leadership offsite, final version three, approved';

export const LongTitle: Story = {
  decorators: [phoneWidth],
  render: () => (
    <List label="Long names">
      <ListRow
        leading={<Avatar name={LONG} size="lg" />}
        title={LONG}
        meta={`Edited by the finance team for ${LONG}`}
        description={`${LONG}. ${LONG}. ${LONG}. ${LONG}.`}
        onOpen={() => {}}
        trailing={<IconButton label={`Remove ${LONG}`} icon={Trash2} />}
      />
      <ListRow title={`${LONG}-${LONG}`.replace(/\s/g, '_')} meta="An unbroken 140-character name" />
    </List>
  ),
};
