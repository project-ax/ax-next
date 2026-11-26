/**
 * sharing-copy — every word the "Who can use <agent>?" screens say.
 *
 * One module, so a wording change never touches a component or a test, and so
 * a single test can walk every line. Components read strings from here; tests
 * read them from here too and never repeat a sentence.
 *
 * Two rules the test pins:
 *  - No product or company name anywhere. Deployments are white-labeled
 *    through Branding, so the option reads "Everyone", never "Everyone at <X>".
 *  - A name a person or a connection carries is user-written, so it never
 *    reaches the screen unfenced. Callers pass names through `personLabel()`
 *    (80 code points, bidi and zero-width characters turned into spaces).
 *
 * Voice (CLAUDE.md): warm, plain, short. What sharing exposes is stated
 * directly, with no jokes.
 */

import { fenceLine } from './fence-line';

/** Who an agent's routines run as: the reader, or a (fenced) name. */
export type RoutinesRunAs = { kind: 'you' } | { kind: 'name'; name: string };

/** Longest name the screens show before it is cut. */
const NAME_MAX = 80;

/** "a", "a and b", "a, b and c". */
function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** At most two names, then a count of the rest. `total` may exceed `names.length`. */
function nameList(names: readonly string[], total: number): string {
  const shown = names.slice(0, 2);
  const rest = Math.max(total, names.length) - shown.length;
  if (rest <= 0) return joinAnd(shown);
  return `${shown.join(', ')} and ${rest} more`;
}

export const SHARING_COPY = {
  nav: {
    label: 'Sharing',
    summary: (agent: string): string => `Who can use ${agent} and who owns it`,
  },
  heading: (agent: string): string => `Who can use ${agent}?`,
  change: 'Change',
  someone: 'Someone',
  loading: 'Checking who can use it…',
  tryAgain: 'Try again',

  audience: {
    justMe: (ownerCount: number): string => (ownerCount > 1 ? 'Just its owners' : 'Just me'),
    everyone: 'Everyone',
    people: (names: string[], total: number): string => nameList(names, total),
  },

  picker: {
    title: (agent: string): string => `Who can use ${agent}?`,
    fieldLabel: 'Who can use it',
    placeholder: 'Type a name or choose Everyone',
    /** Render `audience.justMe(ownerCount)` instead when the agent has co-owners: owners can always use it. */
    justMeOption: 'Just me',
    everyoneOption: 'Everyone',
    everyoneHint: 'Anyone who can sign in here, including people who join later',
    emptyDraft: (agent: string): string =>
      `${agent} isn't shared with anyone. Search for people by name, or choose Everyone.`,
    remove: (name: string): string => `Remove ${name}`,
    sameAs: 'Same people as…',
    /** Sits under "Same people as…", so it is just the agent's name. */
    sameAsItem: (agent: string): string => agent,
    copyFailed: (agent: string): string => `We couldn't copy who can use ${agent}. Try again.`,
    narrowed: (agent: string): string => `People who used ${agent} may still remember what it told them.`,
    peopleCap: "That's the most people we can list here. To share with more, choose Everyone.",
    keepTyping: 'Type at least two letters to search.',
    searching: 'Searching…',
    noMatches: "No one by that name. If they've never signed in here, ask them to sign in once.",
    /** Everyone the search found is an owner or already chosen. */
    allExcluded: 'Everyone by that name is already here.',
    /** The search returned its full page and all of it is excluded, so more people may match. */
    allExcludedMaybeMore: 'Everyone shown is already here. Type more of their name.',
    /** The server refused the text itself (400 invalid-query). */
    searchInvalid: 'Search with just the letters of their name.',
    searchFailed: "We couldn't search just now. Try again in a moment.",
    searchRateLimited: 'That was a lot of searches. Wait a minute and try again.',
    save: 'Save',
    cancel: 'Cancel',
  },

  confirm: {
    title: (agent: string, who: 'everyone' | string[]): string =>
      who === 'everyone'
        ? `Share ${agent} with Everyone?`
        : `Share ${agent} with ${nameList(who, who.length) || 'these people'}?`,
    lead: "They'll be able to:",
    /**
     * `names` are connection names, already fenced by the caller. Deliberately
     * neutral about whose accounts they are: a co-owner sharing the agent is
     * handing over the creator's accounts, and "your Gmail" would be false.
     * The caller renders each account next to its name with `signedInAs`.
     */
    connections: (agent: string, names: string[]): string =>
      `Ask ${agent} to do things with ${joinAnd(names)}. ${agent} uses the accounts signed in there, not their own.`,
    /** The caller renders "Gmail (signed in as …)". */
    signedInAs: (account: string): string => `signed in as ${account}`,
    memory: (agent: string): string =>
      `See everything ${agent} remembers, including what you told it before today.`,
    filesAndInstructions: (agent: string): string =>
      `Open, change and delete ${agent}'s files and artifacts, make public links to them, and read its Instructions.`,
    removeConnectionsFirst: 'Remove connections first',
    share: 'Share',
    cancel: 'Cancel',
    loading: 'Checking its connections…',
    connectionsFailed: (agent: string): string =>
      `We couldn't check what ${agent} is connected to, so we can't show what you'd be sharing. Share stays off until we can.`,
    tryAgain: 'Try again',
  },

  owners: {
    heading: 'Owners',
    creator: 'Creator',
    you: 'You',
    add: 'Add owner',
    remove: (name: string): string => `Remove ${name} as an owner`,
    cap: "That's the most owners an agent can have. Remove one to add someone else.",
    addTitle: (agent: string): string => `Add an owner to ${agent}`,
    /**
     * The person field in Add owner (added with the owners list, after the
     * ux-designer pass). Not the audience picker's placeholder: there is no
     * Everyone here.
     */
    fieldLabel: 'New owner',
    placeholder: 'Type a name',
    confirmTitle: (person: string, agent: string): string => `Add ${person} as an owner of ${agent}?`,
    /**
     * Said plainly, because it's the one real risk of this screen. Owners are
     * fully trusted: they change what the agent does with the creator's
     * connections. Routines run as the creator, so an owner's changes change
     * what those routines do. Only the creator deletes the agent or edits its
     * routines (TASK-1246).
     */
    consequences: (agent: string, routinesRunAs: RoutinesRunAs): string => {
      // Tagged, not a 'you' string: a creator whose name is literally "you"
      // is a name, and must not read as the person looking at the screen.
      const who = routinesRunAs.kind === 'you' ? 'you' : routinesRunAs.name;
      const whose = routinesRunAs.kind === 'you' ? 'your' : `${routinesRunAs.name}'s`;
      return (
        `Owners can change everything ${agent} does with ${whose} connections: its Instructions, tools, connections and who can use it. ` +
        `${agent}'s routines run as ${who}, so an owner's changes also change what those routines do. ` +
        `Only ${who} can delete ${agent} or edit its routines. ` +
        `Only add someone you'd trust with ${whose} accounts.`
      );
    },
    confirm: 'Add owner',
    cancel: 'Cancel',
  },

  team: (agent: string): string => `${agent} belongs to a team, so everyone on that team can use it.`,
  sharedBy: (name: string | null): string => (name === null ? 'Shared with you' : `Shared by ${name}`),

  errors: {
    forbidden: (agent: string): string =>
      `Only ${agent}'s owners can change who can use it. Ask one of them if you need a change.`,
    unknownPerson: "We couldn't find someone you picked. Search for them again, then save.",
    /**
     * The server refuses only a body that names someone twice, which the picker
     * never builds: a bug, not a stale page. Saving the same draft again is
     * refused the same way, so this never says "try again"; a reload rebuilds it.
     */
    duplicatePerson:
      'Something went wrong saving that list. Reload the page and pick the people again.',
    /** Likewise a body without the creator, which the owners dialog never builds. */
    creatorRequired:
      'Something went wrong saving that list. Reload the page and pick the people again.',
    accountsUnavailable: "We can't look people up right now. Try again in a moment.",
    notFound: (agent: string): string => `We can't find ${agent}. It may have been deleted.`,
    generic: "That didn't save. Try again in a moment.",
    loadFailed: (agent: string): string => `We couldn't load who can use ${agent}.`,
  },
} as const;

/** A person's or connection's name, fenced for the screen, or "Someone". */
export function personLabel(name: string | null | undefined): string {
  return fenceLine(name, NAME_MAX) ?? SHARING_COPY.someone;
}
