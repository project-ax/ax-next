import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { RotateCcw, X } from 'lucide-react';
import { Inline } from '../layout/Inline.js';
import { Stack } from '../layout/Stack.js';
import { FileTile } from './FileTile.js';
import { IconButton } from './IconButton.js';
import { List } from './List.js';

const meta = {
  title: 'Components/FileTile',
  component: FileTile,
  args: { name: 'report.csv', variant: 'card' },
} satisfies Meta<typeof FileTile>;

export default meta;
type Story = StoryObj<typeof meta>;

// 80 characters, extension included: the stem truncates, ".csv" stays.
const LONG = 'quarterly-report-final-really-final-for-the-leadership-offsite-all-appendix1.csv';
// An artifact title has no extension: the whole title truncates.
const LONG_TITLE = 'Quarterly finance summary for the leadership offsite, with every appendix + note';

// stories.spec.ts runs at 800px wide, so a decorator pins the phone stories to 390px.
const phoneWidth: Decorator = (Story) => (
  <div style={{ width: 390 }}>
    <Story />
  </div>
);

// A small inline picture, so the preview story needs no network.
const PREVIEW =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#7c83db"/><circle cx="28" cy="30" r="10" fill="#fff"/><path d="M0 80 L30 46 L50 62 L64 50 L80 66 L80 80 Z" fill="#3e4396"/></svg>',
  );

export const Card: Story = {
  render: () => (
    <Stack gap="sm">
      <FileTile variant="card" name="Q3 report" kind="PDF" detail="Document · PDF" onOpen={() => {}} />
      <FileTile variant="card" name="Pipeline" kind="XLSX" detail="Spreadsheet · XLSX" actionLabel="Download" onOpen={() => {}} />
    </Stack>
  ),
};

export const CardLongName: Story = {
  decorators: [phoneWidth],
  render: () => (
    <Stack gap="sm">
      <FileTile variant="card" name={LONG} size={48_213} detail="Spreadsheet · CSV" onOpen={() => {}} />
      <FileTile variant="card" name={LONG_TITLE} kind="HTML" detail="Web page · HTML" onOpen={() => {}} />
    </Stack>
  ),
};

export const Row: Story = {
  render: () => (
    <List label="Artifacts">
      <FileTile variant="row" name="Q3 report" kind="PDF" detail="Document · PDF" onOpen={() => {}} />
      <FileTile variant="row" name="Pipeline" kind="XLSX" detail="Spreadsheet · XLSX" onOpen={() => {}} />
      <FileTile variant="row" name="Launch page" kind="HTML" detail="Web page · HTML" onOpen={() => {}} />
    </List>
  ),
};

export const RowLongName: Story = {
  decorators: [phoneWidth],
  render: () => (
    <List label="Long artifacts">
      <FileTile variant="row" name={LONG} detail="Spreadsheet · CSV" onOpen={() => {}} />
      <FileTile variant="row" name={LONG_TITLE} kind="MD" detail="Document · MD" onOpen={() => {}} />
    </List>
  ),
};

export const Chip: Story = {
  render: () => (
    <Inline gap="sm" wrap>
      <FileTile variant="chip" name="budget.csv" size={2048} detail="Download" actionLabel="Download" status="ready" onOpen={() => {}} />
      <FileTile variant="chip" name="notes.txt" status="ready" detail="Ready to send" trailing={<IconButton label="Remove notes.txt" icon={X} size="sm" />} />
      <FileTile variant="chip" name="README" />
    </Inline>
  ),
};

export const ChipLongName: Story = {
  decorators: [phoneWidth],
  render: () => (
    <Inline gap="sm" wrap>
      <FileTile variant="chip" name={LONG} size={10_240} detail="Download" actionLabel="Download" status="ready" onOpen={() => {}} />
      <FileTile
        variant="chip"
        name={LONG}
        status="ready"
        detail="Ready to send"
        trailing={<IconButton label={`Remove ${LONG}`} icon={X} size="sm" />}
      />
    </Inline>
  ),
};

// The 80-character names at desktop width: the chip still caps at 280px, card and row use the room.
export const LongNamesWide: Story = {
  render: () => (
    <Stack gap="md">
      <FileTile variant="card" name={LONG} size={48_213} detail="Spreadsheet · CSV" onOpen={() => {}} />
      <List label="Wide artifacts">
        <FileTile variant="row" name={LONG} detail="Spreadsheet · CSV" onOpen={() => {}} />
      </List>
      <div>
        <FileTile variant="chip" name={LONG} size={10_240} detail="Download" actionLabel="Download" onOpen={() => {}} />
      </div>
    </Stack>
  ),
};

export const Working: Story = {
  render: () => (
    <Stack gap="sm" align="start">
      <FileTile variant="chip" name="budget.csv" size={2048} detail="Downloading…" actionLabel="Download" status="working" onOpen={() => {}} />
      <FileTile variant="card" name="Q3 report" kind="PDF" detail="Document · PDF" actionLabel="Download" status="working" onOpen={() => {}} />
    </Stack>
  ),
};

export const Failed: Story = {
  render: () => (
    <FileTile
      variant="chip"
      name="holiday-photos.zip"
      status="failed"
      detail="That file is too big to send. The limit is 25 MB."
      trailing={
        <>
          <IconButton label="Try again" icon={RotateCcw} size="sm" />
          <IconButton label="Remove" icon={X} size="sm" />
        </>
      }
    />
  ),
};

export const WithProgress: Story = {
  render: () => (
    <FileTile
      variant="chip"
      name="board-deck.pdf"
      status="working"
      progress={40}
      trailing={<IconButton label="Remove board-deck.pdf" icon={X} size="sm" />}
    />
  ),
};

// Pictures far wider and far taller than the box: the preview shows each whole, inside 200px by the card's width.
const svg = (w: number, h: number) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#7c83db"/><circle cx="${w / 3}" cy="${h / 3}" r="${Math.min(w, h) / 6}" fill="#fff"/></svg>`,
  );

export const ImagePreviewPhone: Story = {
  decorators: [phoneWidth],
  render: () => (
    <Stack gap="sm">
      <FileTile variant="card" name="panorama.png" kind="image/png" size={2_400_000} actionLabel="Download" previewUrl={svg(1600, 400)} onOpen={() => {}} />
      <FileTile variant="card" name={`${LONG.slice(0, -4)}.png`} kind="image/png" actionLabel="Download" previewUrl={svg(300, 1200)} onOpen={() => {}} />
    </Stack>
  ),
};

export const ImagePreview: Story = {
  render: () => (
    <Inline gap="sm" wrap>
      <FileTile variant="chip" name="whiteboard.png" kind="image/png" size={182_000} actionLabel="Download" previewUrl={PREVIEW} onOpen={() => {}} />
      <FileTile variant="card" name="whiteboard.png" kind="image/png" size={182_000} actionLabel="Download" previewUrl={PREVIEW} onOpen={() => {}} />
    </Inline>
  ),
};
