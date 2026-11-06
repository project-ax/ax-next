import { describe, expect, it } from 'vitest';
import {
  VISUAL_MAX_EXPORT_BYTES,
  clampHeight,
  isPngBlob,
  parseFrameMessage,
} from '../frame-messages';

// Any Window other than `window` stands in for the frame's.
const frame = document.createElement('iframe');
document.body.appendChild(frame);
const frameWin = frame.contentWindow!;

describe('parseFrameMessage', () => {
  it('ignores other windows, other origins and unknown types', () => {
    const ev = (o: object) => ({ source: frameWin, origin: 'null', data: { type: 'ax-visual:size', height: 300 }, ...o });
    expect(parseFrameMessage(ev({}), frameWin, new Set())).toEqual({ type: 'size', height: 300 });
    expect(parseFrameMessage(ev({ source: window }), frameWin, new Set())).toBeNull();
    expect(parseFrameMessage(ev({ origin: window.location.origin }), frameWin, new Set())).toBeNull();
    expect(parseFrameMessage(ev({ data: { type: 'ax-oauth-done' } }), frameWin, new Set())).toBeNull();
    // Parent -> frame types are never accepted coming back the other way.
    for (const type of ['ax-visual:visible', 'ax-visual:theme', 'ax-visual:export']) {
      expect(parseFrameMessage(ev({ data: { type } }), frameWin, new Set())).toBeNull();
    }
    expect(parseFrameMessage(ev({ data: { type: 'ax-visual:size', height: 'NaN' } }), frameWin, new Set())).toBeNull();
  });

  it('accepts nothing when no frame is mounted, even a null source', () => {
    expect(parseFrameMessage({ source: null, origin: 'null', data: { type: 'ax-visual:error' } }, null, new Set())).toBeNull();
  });

  it('rejects non-plain data and non-finite heights', () => {
    const at = (data: unknown) => parseFrameMessage({ source: frameWin, origin: 'null', data }, frameWin, new Set());
    expect(at('ax-visual:error')).toBeNull();
    expect(at([{ type: 'ax-visual:error' }])).toBeNull();
    expect(at(null)).toBeNull();
    expect(at({ type: 'ax-visual:size', height: Infinity })).toBeNull();
    expect(at({ type: 'ax-visual:ready', height: 100 })).toBeNull();
  });

  it('clamps heights', () => {
    expect(
      [99_999, -5].map((h) =>
        parseFrameMessage({ source: frameWin, origin: 'null', data: { type: 'ax-visual:size', height: h } }, frameWin, new Set()),
      ),
    ).toEqual([
      { type: 'size', height: 1200 },
      { type: 'size', height: 48 },
    ]);
    expect(clampHeight(300.4)).toBe(300);
  });

  it('parses ready, carrying locked only as an optional boolean', () => {
    const at = (data: object) => parseFrameMessage({ source: frameWin, origin: 'null', data }, frameWin, new Set());
    expect(at({ type: 'ax-visual:ready', height: 200, rendered: true, locked: false })).toEqual({
      type: 'ready',
      height: 200,
      rendered: true,
      locked: false,
    });
    expect(at({ type: 'ax-visual:ready', height: 200, rendered: true, locked: 'yes' })).toEqual({
      type: 'ready',
      height: 200,
      rendered: true,
    });
  });

  it('accepts an error at any time', () => {
    expect(parseFrameMessage({ source: frameWin, origin: 'null', data: { type: 'ax-visual:error' } }, frameWin, new Set())).toEqual({
      type: 'error',
    });
  });

  it('accepts an export result only for a pending id, and only a bounded png', () => {
    const r = (blob: unknown, requestId = 'r1', ok: unknown = true) =>
      parseFrameMessage(
        { source: frameWin, origin: 'null', data: { type: 'ax-visual:export-result', requestId, ok, blob } },
        frameWin,
        new Set(['r1']),
      );
    expect(r(new Blob(['x'], { type: 'image/png' }), 'forged')).toBeNull();
    expect(r(new Blob([new Uint8Array(VISUAL_MAX_EXPORT_BYTES + 1)], { type: 'image/png' }))).toEqual({
      type: 'export-result',
      requestId: 'r1',
      blob: null,
    });
    expect(r(new Blob(['<p>'], { type: 'text/html' }))).toEqual({ type: 'export-result', requestId: 'r1', blob: null });
    expect(r(new Blob([], { type: 'image/png' }))).toEqual({ type: 'export-result', requestId: 'r1', blob: null });
    expect(r('not a blob')).toEqual({ type: 'export-result', requestId: 'r1', blob: null });
    const png = new Blob(['x'], { type: 'image/png' });
    expect(r(png, 'r1', false)).toEqual({ type: 'export-result', requestId: 'r1', blob: null });
    expect(r(png)).toEqual({ type: 'export-result', requestId: 'r1', blob: png });
  });
});

describe('isPngBlob', () => {
  it('checks the png signature', async () => {
    expect(await isPngBlob(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])]))).toBe(true);
    expect(await isPngBlob(new Blob(['GIF89a']))).toBe(false);
    expect(await isPngBlob(new Blob([]))).toBe(false);
  });
});
