import { describe, it, expect } from 'vitest';
import { StorageHttpError } from '../storage-api';
import {
  LIMIT_MB_INVALID,
  NEAR_LIMIT_BODY,
  NEAR_LIMIT_TITLE,
  FULL_BODY,
  FULL_TITLE,
  STORAGE_FULL_IDENTITY,
  STORAGE_FULL_ROUTINE_REMOVE,
  STORAGE_FULL_ROUTINE_SAVE,
  STORAGE_FULL_RULES,
  STORAGE_FULL_SEND,
  WARN_PERCENT_INVALID,
  breakdownRows,
  failureMessage,
  formatBytes,
  formatMb,
  ownerBreakdown,
  ownerLabel,
  ownerSubline,
  ownersSummary,
  shareOfLimit,
  statusLabel,
  usageLine,
} from '../storage-copy';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

describe('formatBytes', () => {
  it('counts in 1024s, with one decimal only when there is one to show', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(KB)).toBe('1 KB');
    expect(formatBytes(1.5 * KB)).toBe('1.5 KB');
    expect(formatBytes(MB)).toBe('1 MB');
    expect(formatBytes(123.4 * MB)).toBe('123.4 MB');
    expect(formatBytes(GB)).toBe('1 GB');
    expect(formatBytes(2.3 * GB)).toBe('2.3 GB');
    expect(formatBytes(5 * GB)).toBe('5 GB');
    expect(formatBytes(3 * 1024 * GB)).toBe('3 TB');
  });

  it('trims a ".0" that rounding leaves behind', () => {
    // 2.04 GB rounds to 2.0 and must read "2 GB", not "2.0 GB".
    expect(formatBytes(2.04 * GB)).toBe('2 GB');
  });

  it('rolls over to the next unit instead of printing "1024 KB"', () => {
    expect(formatBytes(1024 * KB - 1)).toBe('1 MB');
    expect(formatBytes(1024 * MB - 1)).toBe('1 GB');
  });

  it('never prints nonsense for input that is not a size', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });

  it('stops at TB rather than inventing a unit', () => {
    expect(formatBytes(2048 * 1024 * GB)).toBe('2048 TB');
  });
});

describe('formatMb', () => {
  it('reads a limit in MB the way a person would say it', () => {
    expect(formatMb(1024)).toBe('1 GB');
    expect(formatMb(64)).toBe('64 MB');
    expect(formatMb(5120)).toBe('5 GB');
    expect(formatMb(1536)).toBe('1.5 GB');
  });
});

describe('usageLine', () => {
  it('says how much of how much, in words', () => {
    expect(usageLine(2.3 * GB, 5 * GB)).toBe('2.3 GB of 5 GB used');
    expect(usageLine(0, GB)).toBe('0 B of 1 GB used');
  });
});

describe('shareOfLimit', () => {
  it('says nothing when there is nothing to say', () => {
    expect(shareOfLimit(0, GB)).toBeNull();
    expect(shareOfLimit(10, 0)).toBeNull();
  });

  it('rounds, calls a sliver "<1%", and does not clamp at 100', () => {
    expect(shareOfLimit(GB / 2, GB)).toBe('50% of limit');
    expect(shareOfLimit(1, GB)).toBe('<1% of limit');
    expect(shareOfLimit(1.1 * GB, GB)).toBe('110% of limit');
  });
});

describe('breakdownRows', () => {
  it('names the two kinds of storage the way a person thinks of them', () => {
    expect(breakdownRows({ workspaceBytes: 2 * GB, fileBytes: 0.5 * GB })).toEqual([
      { label: 'Agent files', value: '2 GB' },
      { label: 'Uploads and published files', value: '512 MB' },
    ]);
  });
});

describe('ownerBreakdown', () => {
  it('says both halves, in the same words as the person view but shorter', () => {
    expect(ownerBreakdown({ workspaceBytes: 800 * MB, fileBytes: 100 * MB })).toBe(
      '800 MB agent files, 100 MB uploads',
    );
    expect(ownerBreakdown({ workspaceBytes: 0, fileBytes: 0 })).toBe('0 B agent files, 0 B uploads');
  });
});

describe('statusLabel', () => {
  it('uses the words the Usage tab uses for "close" and says "Full" for full', () => {
    expect(statusLabel('ok')).toBe('OK');
    expect(statusLabel('near-limit')).toBe('Close to limit');
    expect(statusLabel('full')).toBe('Full');
  });

  it('shows a status a newer server invents as "Unknown", not as nothing', () => {
    expect(statusLabel('brand-new' as never)).toBe('Unknown');
    // A plain object lookup would answer for the prototype too.
    expect(statusLabel('constructor' as never)).toBe('Unknown');
  });
});

describe('ownerLabel and ownerSubline', () => {
  const base = { ownerId: 'u-1', displayName: null, email: null } as const;

  it('names an owner by name, then email, then id', () => {
    expect(ownerLabel({ ...base, displayName: 'Sam', email: 's@x.co' })).toBe('Sam');
    expect(ownerLabel({ ...base, email: 's@x.co' })).toBe('s@x.co');
    expect(ownerLabel(base)).toBe('u-1');
    // Blank strings are not names.
    expect(ownerLabel({ ...base, displayName: '  ', email: '' })).toBe('u-1');
  });

  it('puts the email under a name, and nothing under an email or an id', () => {
    expect(ownerSubline({ ...base, displayName: 'Sam', email: 's@x.co' })).toBe('s@x.co');
    expect(ownerSubline({ ...base, displayName: 'Sam' })).toBe('u-1');
    expect(ownerSubline({ ...base, email: 's@x.co' })).toBeNull();
    expect(ownerSubline(base)).toBeNull();
  });
});

describe('ownersSummary', () => {
  it('agrees in number and says the total', () => {
    expect(ownersSummary({ ownerCount: 1, totalBytes: GB })).toBe(
      '1 person or team, 1 GB in total',
    );
    expect(ownersSummary({ ownerCount: 12, totalBytes: 3.4 * GB })).toBe(
      '12 people and teams, 3.4 GB in total',
    );
    expect(ownersSummary({ ownerCount: 0, totalBytes: 0 })).toBe(
      '0 people and teams, 0 B in total',
    );
  });
});

describe('the sentences a person reads', () => {
  const sentences: Array<[string, string]> = [
    ['near-limit title', NEAR_LIMIT_TITLE],
    ['near-limit body', NEAR_LIMIT_BODY],
    ['full title', FULL_TITLE],
    ['full body', FULL_BODY],
    ['storage-full send refusal', STORAGE_FULL_SEND],
    ['storage-full rules refusal', STORAGE_FULL_RULES],
    ['storage-full identity refusal', STORAGE_FULL_IDENTITY],
  ];

  it('says what the status is, what happens at the limit, and who can help', () => {
    expect(NEAR_LIMIT_TITLE).toBe("You're getting close to your limit");
    expect(NEAR_LIMIT_BODY).toMatch(/won't be saved/);
    expect(NEAR_LIMIT_BODY).toMatch(/ask an admin for more room/i);
    expect(FULL_TITLE).toBe('Your storage is full');
    expect(FULL_BODY).toMatch(/nothing new can be saved/i);
    expect(FULL_BODY).toMatch(/ask an admin for more room/i);
  });

  it.each(sentences)('%s never tells anyone to delete anything', (_name, text) => {
    // Only deleting a whole agent frees space, and no smaller chore does, so
    // that advice would be a false promise.
    expect(text).not.toMatch(/\b(delet|remov|clear|clean|free up|free some|make (some )?space|tidy)/i);
  });

  it.each(sentences)('%s uses no jargon', (_name, text) => {
    expect(text).not.toMatch(/\b(git|repos?|repository|blobs?|pvc|quota|ledger|bytes?|disk|volume|sha)\b/i);
  });

  it('the storage-full refusal says the message was not sent, and who can help', () => {
    expect(STORAGE_FULL_SEND).toMatch(/storage is full/i);
    expect(STORAGE_FULL_SEND).toMatch(/ask an admin for more room/i);
  });

  /*
    TASK-719. Each one names what did NOT get saved, why, and who can help, and
    says nothing more than the code behind it can promise. The identity one is
    the delicate one: it says the AGENT was saved (true only because the form
    creates or patches it first) and that the IDENTITY was not, and it points at
    the edit screen rather than at "Save again", which on a brand-new agent
    would make a second agent.
  */
  it('the rules refusal says the rules were not saved, why, and who can help', () => {
    expect(STORAGE_FULL_RULES).toBe(
      "We couldn't save your rules because your storage is full. An admin can make more room, then you can try again.",
    );
  });

  it('the identity refusal says the agent was saved, its identity was not, and who can help', () => {
    expect(STORAGE_FULL_IDENTITY).toBe(
      "The agent was saved, but its identity wasn't, because storage is full. An admin can make more room, then you can edit the agent and save its identity again.",
    );
  });

  it('carry no number, so nothing can go stale when the limit changes', () => {
    for (const [, text] of sentences) expect(text).not.toMatch(/\d/);
  });
});

/*
  TASK-719: the routines screen's two refusals. The ROUTINES SERVER sends the same
  words (`@ax/routines-admin-routes`, which may not import from here), so these
  are only what a person reads if its sentence is missing, and they must agree
  with it word for word.

  They are NOT in the `sentences` table above on purpose: that table forbids the
  word "remov", to catch advice like "remove some files". The routine sentence
  says "remove" about what we COULD NOT do, and is true because the refused
  delete leaves the routine where it was. Nothing here tells anyone to do it.
*/
describe('the routine refusals', () => {
  const routineSentences: Array<[string, string]> = [
    ['save', STORAGE_FULL_ROUTINE_SAVE],
    ['remove', STORAGE_FULL_ROUTINE_REMOVE],
  ];

  it('say which action did not happen, why, and who can help', () => {
    expect(STORAGE_FULL_ROUTINE_SAVE).toBe(
      "We couldn't save that routine because your storage is full. An admin can make more room, then you can try again.",
    );
    expect(STORAGE_FULL_ROUTINE_REMOVE).toBe(
      "We couldn't remove that routine because your storage is full. An admin can make more room, then you can try again.",
    );
  });

  it.each(routineSentences)('%s advises nothing about deleting or freeing up space', (_name, text) => {
    expect(text).not.toMatch(/\b(delet|clear|clean|free up|free some|make (some )?space|tidy)/i);
  });

  it.each(routineSentences)('%s uses no jargon and no number', (_name, text) => {
    expect(text).not.toMatch(/\b(git|repos?|repository|blobs?|pvc|quota|ledger|bytes?|disk|volume|sha)\b/i);
    expect(text).not.toMatch(/\d/);
    expect(text).not.toMatch(/storage-full|\.ax/);
  });
});

describe('field errors', () => {
  it('spell out the range in whole numbers', () => {
    expect(LIMIT_MB_INVALID).toBe('Enter a whole number of MB between 64 and 10,485,760.');
    expect(WARN_PERCENT_INVALID).toBe('Enter a whole number between 1 and 99.');
  });
});

describe('failureMessage', () => {
  it('turns the save-time server codes into sentences, never the code', () => {
    const invalid = failureMessage("We couldn't save your changes.", new StorageHttpError(400, 'invalid-limits'));
    expect(invalid).toMatch(/64 to 10,485,760 MB/);
    expect(invalid).toMatch(/1 to 99/);
    expect(invalid).not.toContain('invalid-limits');

    for (const [status, code] of [
      [400, 'invalid-json'],
      [413, 'body-too-large'],
    ] as const) {
      const text = failureMessage("We couldn't save your changes.", new StorageHttpError(status, code), {
        settled: 'Nothing was changed.',
      });
      expect(text).toContain("We couldn't save your changes.");
      expect(text).toContain('Nothing was changed.');
      expect(text).not.toContain(code);
    }
  });

  it('tells a signed-out admin to sign in, and someone without access to ask an admin', () => {
    expect(failureMessage('x', new StorageHttpError(401, 'unauthenticated'))).toContain('Your session has ended.');
    expect(failureMessage('x', new StorageHttpError(401, 'unauthenticated'))).toContain('Sign in again');
    expect(failureMessage('x', new StorageHttpError(403, 'forbidden'))).toContain('needs an admin account');
  });

  it('separates our trouble from theirs', () => {
    expect(failureMessage('x', new StorageHttpError(500))).toContain('The server ran into a problem.');
    expect(failureMessage('x', new StorageHttpError(200, 'unexpected-response'))).toContain(
      "something we didn't expect",
    );
    const offline = failureMessage('x', new TypeError('Failed to fetch'));
    expect(offline).toContain("We couldn't reach the server.");
    expect(offline).not.toContain('Failed to fetch');
  });

  it('closes with "try again" unless the screen already has that button', () => {
    expect(failureMessage('We could not.', new StorageHttpError(500))).toMatch(/Try again in a moment\.$/);
    expect(failureMessage('We could not.', new StorageHttpError(500), { retry: null })).not.toMatch(
      /Try again/,
    );
  });

  it('does not answer to the prototype when the server sends a code named like one', () => {
    const text = failureMessage('We could not.', new StorageHttpError(400, 'constructor'));
    expect(text).not.toContain('function');
    expect(text).toContain('We could not.');
  });
});
