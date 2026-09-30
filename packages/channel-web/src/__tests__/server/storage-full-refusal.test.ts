/**
 * The one test a route uses to decide "this refusal is the storage limit"
 * (TASK-719), pinned from BOTH directions.
 *
 * Getting it wrong in the loose direction is the quiet failure: a validator's
 * veto (the person can fix what they wrote) or a real fault would be told
 * "your storage is full. Ask an admin for more room", which is a false
 * diagnosis with a false remedy. So the test is exactly one shape, and none of
 * the things that merely look like it count.
 */
import { describe, it, expect } from 'vitest';
import { PluginError } from '@ax/core';
import { isStorageFullRefusal } from '../../server/storage-full-refusal.js';

const veto = (over: Partial<ConstructorParameters<typeof PluginError>[0]> = {}): PluginError =>
  new PluginError({
    code: 'rejected',
    plugin: '@ax/workspace-git',
    hookName: 'workspace:apply',
    message: 'refused',
    ...over,
  });

describe('isStorageFullRefusal', () => {
  it('is true for a veto that carries the storage-full code', () => {
    expect(isStorageFullRefusal(veto({ reasonCode: 'storage-full' }))).toBe(true);
  });

  it('is true whichever plugin the facade names, and whatever the message says', () => {
    expect(
      isStorageFullRefusal(veto({ reasonCode: 'storage-full', plugin: 'anything', message: 'x' })),
    ).toBe(true);
  });

  it('is false for a veto with no code, or with a different one', () => {
    expect(isStorageFullRefusal(veto())).toBe(false);
    expect(isStorageFullRefusal(veto({ reasonCode: 'something-else' }))).toBe(false);
    expect(isStorageFullRefusal(veto({ reasonCode: '' }))).toBe(false);
  });

  it('never keys on who said no, or on what the message says', () => {
    expect(isStorageFullRefusal(veto({ plugin: '@ax/disk-quota' }))).toBe(false);
    expect(isStorageFullRefusal(veto({ message: 'Your storage is full' }))).toBe(false);
    expect(isStorageFullRefusal(veto({ message: 'storage-full' }))).toBe(false);
  });

  it('is false when the code sits on an error that is not a rejected', () => {
    expect(isStorageFullRefusal(veto({ code: 'unknown', reasonCode: 'storage-full' }))).toBe(false);
    expect(isStorageFullRefusal(veto({ code: 'invalid-payload', reasonCode: 'storage-full' }))).toBe(
      false,
    );
  });

  it('is false for anything that is not a PluginError, however much it looks like one', () => {
    expect(isStorageFullRefusal(new Error('storage-full'))).toBe(false);
    expect(isStorageFullRefusal({ code: 'rejected', reasonCode: 'storage-full' })).toBe(false);
    expect(isStorageFullRefusal({ rejected: true, reason: 'x', code: 'storage-full' })).toBe(false);
    expect(isStorageFullRefusal('storage-full')).toBe(false);
    expect(isStorageFullRefusal(null)).toBe(false);
    expect(isStorageFullRefusal(undefined)).toBe(false);
  });
});
