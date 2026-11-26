/**
 * PeoplePicker — find a person by name (TASK-1247).
 *
 * A closed field that opens a search list. Fixed choices (Just me, Everyone)
 * are always listed first; people are searched by name only once at least two
 * characters are typed and the typing has paused. One request in flight at a
 * time: a newer search aborts the older one, and a sequence number makes sure
 * a late answer never lands. Every name goes through `personLabel` (fenced).
 *
 * Words come from `SHARING_COPY.picker`; the caller passes the field's
 * accessible name and placeholder. Nothing here knows what the choice means:
 * the caller decides what picking a person or a fixed option does.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { replaceSurfaceRewriters } from '@ax/core/surface-text';
import { Stack, Text } from '@project-ax/ui';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { searchPeople, SharingRequestError, type PersonMatch } from '@/lib/agent-sharing-api';
import { logRequestFailure } from '@/lib/http';
import { SHARING_COPY, personLabel } from '@/lib/sharing-copy';

/** ConnectorDirectory's pause (settings/ConnectorDirectory.tsx). */
export const PEOPLE_SEARCH_DEBOUNCE_MS = 300;
/** Fewest characters (code points) the server will search for. */
const MIN_QUERY = 2;
/** Most characters (code points) the server will search for. */
const MAX_QUERY = 64;
/** The field's cap, in UTF-16 units (all `maxLength` counts): room for
 *  MAX_QUERY code points of any kind. Anything past MAX_QUERY isn't sent. */
const MAX_INPUT_UNITS = MAX_QUERY * 2;
/** The most people one search returns. Mirrors `PEOPLE_RESULTS_MAX` in
 *  `packages/auth-better/src/people-search.ts`; a full page means more may match. */
export const PEOPLE_RESULTS_CAP = 10;

/**
 * What the server is sent for `text`: whitespace runs to one space, then the
 * control, bidi and zero-width characters it refuses (400 invalid-query)
 * dropped, trimmed, and cut to MAX_QUERY code points. Dropped, not turned into
 * spaces: a zero-width space pasted inside a name shouldn't split it.
 */
function searchQuery(text: string): string {
  const cleaned = replaceSurfaceRewriters(text.replace(/\s+/g, ' '), '').trim();
  const points = [...cleaned];
  return points.length <= MAX_QUERY ? cleaned : points.slice(0, MAX_QUERY).join('').trimEnd();
}

export interface PeoplePickerProps {
  /** The field's accessible name. */
  label: string;
  placeholder: string;
  /** Already chosen or already owners: never offered. */
  excludeIds: ReadonlySet<string>;
  /** Just me / Everyone, listed first. */
  fixedOptions?: Array<{ id: string; label: string; hint?: string }>;
  onPickFixed?: (id: string) => void;
  onPickPerson: (person: PersonMatch) => void;
  disabled?: boolean;
  /** Switch off only the people search (e.g. the list is full): the fixed
   *  options stay choosable. */
  peopleDisabled?: boolean;
}

type SearchState =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'ready'; people: PersonMatch[] }
  | { kind: 'rate-limited' }
  | { kind: 'invalid' }
  | { kind: 'failed' };

export function PeoplePicker({
  label,
  placeholder,
  excludeIds,
  fixedOptions = [],
  onPickFixed,
  onPickPerson,
  disabled = false,
  peopleDisabled = false,
}: PeoplePickerProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' });
  const inFlight = useRef<AbortController | null>(null);
  const latest = useRef(0);

  const query = searchQuery(text);
  const queryChars = [...query].length;

  // Search once the typing pauses. Re-running (or leaving) aborts the request
  // in flight and moves the number on, so its answer never lands.
  useEffect(() => {
    if (peopleDisabled || [...query].length < MIN_QUERY) {
      setSearch({ kind: 'idle' });
      return;
    }
    setSearch({ kind: 'searching' });
    const timer = setTimeout(() => {
      const controller = new AbortController();
      inFlight.current = controller;
      latest.current += 1;
      const seq = latest.current;
      searchPeople(query, controller.signal).then(
        (people) => {
          if (seq !== latest.current) return;
          setSearch({ kind: 'ready', people });
        },
        (e: unknown) => {
          if (seq !== latest.current) return;
          if (e instanceof SharingRequestError && e.code === 'rate-limited') {
            setSearch({ kind: 'rate-limited' });
          } else if (e instanceof SharingRequestError && e.code === 'invalid-query') {
            // The text was cleaned to the server's rules first, so a refusal
            // means the two sides' rules have drifted.
            logRequestFailure(e, 'people search');
            setSearch({ kind: 'invalid' });
          } else {
            logRequestFailure(e, 'people search');
            setSearch({ kind: 'failed' });
          }
        },
      );
    }, PEOPLE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      inFlight.current?.abort();
      inFlight.current = null;
      latest.current += 1;
    };
  }, [query, peopleDisabled]);

  const finish = () => {
    setText('');
    setOpen(false);
  };

  const found = !peopleDisabled && search.kind === 'ready' ? search.people : [];
  const people = found.filter((p) => !excludeIds.has(p.id));

  let status: string | null = null;
  if (peopleDisabled) status = null;
  else if (text.trim().length > 0 && queryChars < MIN_QUERY) status = SHARING_COPY.picker.keepTyping;
  else if (search.kind === 'searching') status = SHARING_COPY.picker.searching;
  else if (search.kind === 'rate-limited') status = SHARING_COPY.picker.searchRateLimited;
  else if (search.kind === 'invalid') status = SHARING_COPY.picker.searchInvalid;
  else if (search.kind === 'failed') status = SHARING_COPY.picker.searchFailed;
  else if (search.kind === 'ready' && found.length === 0) status = SHARING_COPY.picker.noMatches;
  else if (search.kind === 'ready' && people.length === 0) {
    status =
      found.length >= PEOPLE_RESULTS_CAP
        ? SHARING_COPY.picker.allExcludedMaybeMore
        : SHARING_COPY.picker.allExcluded;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
          className="w-full justify-between font-normal text-muted-foreground"
        >
          {placeholder}
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={placeholder}
            value={text}
            onValueChange={setText}
            maxLength={MAX_INPUT_UNITS}
            disabled={peopleDisabled}
          />
          <CommandList>
            {fixedOptions.length > 0 && (
              <CommandGroup>
                {fixedOptions.map((o) => (
                  <CommandItem
                    key={o.id}
                    value={`fixed:${o.id}`}
                    onSelect={() => {
                      onPickFixed?.(o.id);
                      finish();
                    }}
                  >
                    <Stack gap="xs">
                      <Text role="body-strong">{o.label}</Text>
                      {o.hint !== undefined && <Text role="meta">{o.hint}</Text>}
                    </Stack>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {status !== null && (
              <CommandGroup>
                <output>
                  <Text inline role="meta">
                    {status}
                  </Text>
                </output>
              </CommandGroup>
            )}
            {people.length > 0 && (
              <CommandGroup>
                {people.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`person:${p.id}`}
                    onSelect={() => {
                      onPickPerson(p);
                      finish();
                    }}
                  >
                    {personLabel(p.displayName)}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
