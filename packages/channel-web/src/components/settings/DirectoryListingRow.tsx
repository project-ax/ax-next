/**
 * TASK-1101 — one listing in Admin › Connectors › Find in directory: a
 * settings row (its title, who published it, its description and chips)
 * whose sheet holds the details and "Set it up".
 *
 * Registry text is untrusted: text nodes only, the URL shown only as its
 * host, never a link. The title, description, publisher, version and key
 * header are third-party text from a public directory, so each renders as a
 * React text child and nothing else. There is no `dangerouslySetInnerHTML`,
 * and no listing value goes in an `href` or `src`. The address appears only
 * as `directoryHost(url)`.
 *
 * The publisher line is the defense against lookalike listings. The shield
 * appears only for an exact `'domain'` proof, which the client normalizer
 * never upgrades. An `'account'` publisher reads "Community · X", never
 * "GitHub user X", because `'account'` doesn't promise a GitHub account. The
 * auth copy says only what the listing says. `'none'` means the listing
 * declares no key, not that nobody signs in, so it gets no chip and never
 * "No sign-in".
 *
 * shadcn primitives and semantic tokens only (invariant 6). The chips are
 * `badgeVariants` on a `span` rather than `Badge`, because `Badge` renders a
 * `div` and a row's value sits inside the row's `button` (the `UsageTab`
 * precedent).
 */
import type { ReactNode } from 'react';
import { Info, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { directoryHost, type DirectoryAuth, type DirectoryEntry } from '@/lib/connector-directory';
import { monthDay } from '@/lib/workspace-time';
import { SettingsDetailRow } from './SettingsLayout';

const NO_DESCRIPTION = 'The publisher didn’t add a description.';
const DEPRECATED_NOTE = 'This listing is marked deprecated, so it may stop working.';
const TRUST_NOTE =
  'The directory checks who published a server, not what it does. An agent with this connector can send it whatever the agent is working on, so only add servers you’d trust with that.';

/** The row's chip for each way of connecting. `'none'` has no chip: it isn't "No sign-in". */
const AUTH_CHIP: Record<DirectoryAuth, string | null> = {
  key: 'API key',
  signin: 'Sign-in',
  none: null,
};

/** "How people connect": what the listing says, and nothing more. */
function howPeopleConnect(entry: DirectoryEntry): string {
  switch (entry.auth) {
    case 'signin':
      return 'Each person signs in from their agent’s Connectors tab.';
    case 'key':
      return entry.keyHeader
        ? `Needs an API key, sent in the ${entry.keyHeader} header. You choose whether each agent brings its own key or everyone shares one.`
        : 'Needs an API key. You’ll add the request header it goes in when you set it up.';
    case 'none':
      return 'The listing doesn’t mention a key. When you set it up, we’ll check whether people need to sign in.';
  }
}

/** "Version 1.4.0 · updated Nov 3", or only the version when the date can't be read. */
function listingLine(entry: DirectoryEntry): string {
  const updated = monthDay(entry.updatedAt);
  return updated ? `Version ${entry.version} · updated ${updated}` : `Version ${entry.version}`;
}

/** The row's publisher line. The shield is only for an exact `'domain'` proof. */
function ProofLine({ entry }: { entry: DirectoryEntry }) {
  if (entry.publisherProof === 'domain') {
    return (
      <span data-testid="directory-proof-domain" className="flex items-center gap-1">
        <ShieldCheck aria-hidden="true" className="text-primary" />
        <span className="min-w-0">{`Published by ${entry.publisher}`}</span>
        <span className="sr-only">{' (verified)'}</span>
      </span>
    );
  }
  return (
    <span data-testid="directory-proof-account" className="block">
      {`Community · ${entry.publisher}`}
    </span>
  );
}

/** One `dt`/`dd` pair in the sheet. */
function DetailItem({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="flex flex-col gap-1 break-words">{children}</dd>
    </div>
  );
}

export function DirectoryListingRow({
  entry,
  added,
  onSetUp,
}: {
  entry: DirectoryEntry;
  /** A connector already uses this listing's server address. */
  added: boolean;
  onSetUp: (entry: DirectoryEntry) => void;
}) {
  const domain = entry.publisherProof === 'domain';
  const hasDescription = entry.description.trim() !== '';
  const authChip = AUTH_CHIP[entry.auth];
  const hasChips = added || entry.deprecated === true || authChip !== null;

  return (
    <SettingsDetailRow
      label={entry.title}
      detail={
        <>
          <ProofLine entry={entry} />
          {hasDescription && <span className="block truncate">{entry.description}</span>}
        </>
      }
      value={
        hasChips ? (
          <span className="flex items-center gap-1.5">
            {added && <span className={badgeVariants({ variant: 'accent', size: 'compact' })}>Added</span>}
            {entry.deprecated && (
              <span className={badgeVariants({ variant: 'warning', size: 'compact' })}>Deprecated</span>
            )}
            {authChip !== null && (
              <span className={badgeVariants({ variant: 'secondary', size: 'compact' })}>{authChip}</span>
            )}
          </span>
        ) : undefined
      }
      description={<span className="break-words">{hasDescription ? entry.description : NO_DESCRIPTION}</span>}
    >
      {(close) => (
        <>
          <dl className="flex flex-col gap-4 text-sm">
            <DetailItem term="Published by">
              <span className="flex items-center gap-1.5">
                {domain && <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-primary" />}
                <span className="min-w-0">{entry.publisher}</span>
              </span>
              <span className="text-muted-foreground">
                {domain
                  ? `The publisher proved they control ${entry.publisher}.`
                  : 'A community listing. It isn’t checked against any company.'}
              </span>
            </DetailItem>
            <DetailItem term="Connects to">{directoryHost(entry.url)}</DetailItem>
            <DetailItem term="How people connect">{howPeopleConnect(entry)}</DetailItem>
            <DetailItem term="Listing">{listingLine(entry)}</DetailItem>
          </dl>
          {entry.deprecated && <p className="text-sm text-muted-foreground">{DEPRECATED_NOTE}</p>}
          <Alert role="note">
            <Info aria-hidden="true" className="size-4" />
            <AlertDescription>{TRUST_NOTE}</AlertDescription>
          </Alert>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {added ? (
              <Button type="button" variant="outline" size="sm" disabled>
                Already in your connectors
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  close();
                  onSetUp(entry);
                }}
              >
                Set it up
              </Button>
            )}
          </div>
        </>
      )}
    </SettingsDetailRow>
  );
}
