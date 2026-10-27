/** Fixed repeat-admission bounds; none are caller-controlled configuration. */
export const REPEAT_DELIVERY_LIMITS = Object.freeze({
  active: 3,
  waitingPerRoutine: 32,
  pendingPerOwner: 64,
  bytesPerOwner: 8 * 1024 * 1024,
  idsPerRoutine: 2048,
  idsPerOwner: 10_000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  leaseMs: 120_000,
  heartbeatMs: 10_000,
  drainMs: 1000,
});

/** Check the delivery identifier after verifying the sender, checking the body and selecting the event. */
export function githubDeliveryId(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error('Invalid delivery ID.');
  return value;
}

export function repeatQueueFits(input: { waiting: number; ownerPending: number; ownerBytes: number; incomingBytes: number }): boolean {
  if (!Object.values(input).every(value => Number.isSafeInteger(value) && value >= 0) || input.incomingBytes === 0) return false;
  return input.waiting < REPEAT_DELIVERY_LIMITS.waitingPerRoutine
    && input.ownerPending < REPEAT_DELIVERY_LIMITS.pendingPerOwner
    && input.ownerBytes + input.incomingBytes <= REPEAT_DELIVERY_LIMITS.bytesPerOwner;
}
