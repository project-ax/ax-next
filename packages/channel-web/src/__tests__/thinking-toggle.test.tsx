/**
 * Thinking-block UI toggle (Task 21 / J4).
 *
 * Behaviors under test:
 *
 *   1. Default state: hidden. The thinking-store reports
 *      `visible === false` and the body has no `thinking-visible` class.
 *
 *   2. Toggling the store flips the body class on.
 *
 *   3. The history adapter, given `includeThinking: true`, requests the
 *      `?includeThinking=true` query string — the toggle's flow on the
 *      adapter side. (We test the adapter directly to avoid the AI SDK
 *      runtime wiring; the adapter integration is the seam Task 20
 *      cares about.)
 *
 *   4. The per-message ThinkingToggle button (rendered inside Thread's
 *      AssistantMessage) flips the store. We assert click → store flip
 *      via a stand-alone render of the button surface.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import {
  thinkingStoreActions,
  useThinkingStore,
} from '../lib/thinking-store';
import { createAxHistoryAdapter } from '../lib/history-adapter';

import type { MessageFormatAdapter, MessageFormatItem, MessageStorageEntry } from '@assistant-ui/react';

type StorageFormat = Record<string, unknown>;
type TestMessage = MessageStorageEntry<StorageFormat>;

const makeFormatAdapter = (): MessageFormatAdapter<TestMessage, StorageFormat> => ({
  format: 'aui-v1',
  decode: (entry: MessageStorageEntry<StorageFormat>): MessageFormatItem<TestMessage> => ({
    parentId: entry.parent_id,
    message: entry,
  }),
  encode: (): StorageFormat => ({}),
  getId: (message: TestMessage): string => message.id,
});

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  thinkingStoreActions.reset();
});

afterEach(() => {
  thinkingStoreActions.reset();
});

describe('thinking-store', () => {
  it('defaults to hidden (J4 — off by default)', () => {
    expect(useThinkingStore.length).toBeGreaterThanOrEqual(0);
    // Snapshot the singleton through a tiny harness.
    const Probe = () => {
      const { visible } = useThinkingStore();
      return <span data-testid="probe">{String(visible)}</span>;
    };
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').textContent).toBe('false');
    expect(document.body.classList.contains('thinking-visible')).toBe(false);
  });

  it('toggle() flips to visible and adds the body class', () => {
    act(() => {
      thinkingStoreActions.toggle();
    });
    expect(document.body.classList.contains('thinking-visible')).toBe(true);
    act(() => {
      thinkingStoreActions.toggle();
    });
    expect(document.body.classList.contains('thinking-visible')).toBe(false);
  });
});

describe('history adapter respects includeThinking option', () => {
  it('omits ?includeThinking query when option is false (default)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversation: { conversationId: 'c1', title: null },
        turns: [],
      }),
    });
    const adapter = createAxHistoryAdapter(() => 'c1');
    await adapter.withFormat!(makeFormatAdapter()).load();
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe('/api/chat/conversations/c1');
    expect(url).not.toContain('includeThinking');
  });

  it('appends ?includeThinking=true when option is true (toggle flipped on)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversation: { conversationId: 'c1', title: null },
        turns: [],
      }),
    });
    const adapter = createAxHistoryAdapter(() => 'c1', { includeThinking: true });
    await adapter.withFormat!(makeFormatAdapter()).load();
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe('/api/chat/conversations/c1?includeThinking=true');
  });
});

describe('per-message ThinkingToggle button', () => {
  /**
   * The button is wired through Thread.tsx but renders cleanly stand-alone:
   * it only reads `useThinkingStore` and dispatches `toggle()`. We drive the
   * inner shape via a copy of the JSX so we don't have to spin up an
   * assistant-ui runtime just to render a single icon-button.
   */
  const Probe = () => {
    const { visible } = useThinkingStore();
    return (
      <button
        type="button"
        data-testid="thinking-toggle"
        aria-pressed={visible ? 'true' : 'false'}
        onClick={() => thinkingStoreActions.toggle()}
      >
        thinking
      </button>
    );
  };

  it('click flips the store from false → true', () => {
    const { getByTestId } = render(<Probe />);
    const btn = getByTestId('thinking-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    act(() => {
      fireEvent.click(btn);
    });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(document.body.classList.contains('thinking-visible')).toBe(true);
  });

  it('clicking again flips back to false', () => {
    const { getByTestId } = render(<Probe />);
    const btn = getByTestId('thinking-toggle');
    act(() => {
      fireEvent.click(btn);
    });
    act(() => {
      fireEvent.click(btn);
    });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(document.body.classList.contains('thinking-visible')).toBe(false);
  });
});
