/**
 * Guard: the FOUR hand-copied spellings of the declared-effect member list must
 * stay equal, and every member the producer can declare must survive the wire
 * projection with authored copy behind it.
 *
 * WHY THIS EXISTS (TASK-408, found by the reviewer on #580). `@ax/tool-policy`
 * declares the members twice — the `ToolEffect` union and the `ToolEffectSchema`
 * `z.enum` that pins them on the bus — and `channel-web` copies them twice more,
 * as the `CapabilityEffect` union and as the `KNOWN_EFFECTS` allow-list that
 * `toWireEffects` filters against. Nothing kept the four in step. Add a member to
 * one alone and `toWireEffects` DROPS it, silently: the rail then claims LESS
 * reach than the tool actually has, so a person under-estimates what they just
 * approved. That is the understating direction design H4 forbids, and it is the
 * same class as #574 / TASK-330 — widening `CapabilityRow.effect` to an array
 * compiled green while every array answer fell into a `null` branch and the rail
 * stopped disclosing that `web_extract` spends money and acts outward.
 *
 * `tsc` CANNOT SEE THE DROP, which is the whole reason a test has to. The hop
 * from `@ax/tool-policy` to here is duck-typed on purpose (invariant 2 forbids
 * the import), so `PolicyCapabilityRow.effect` is `unknown` and the mirror is a
 * bare string literal.
 *
 * Be precise about what the compiler does and does not cover here, because the
 * first draft of this comment got it wrong and a reviewer had to measure it.
 * `tsc` is good at PHANTOM members — a name that exists downstream and nowhere
 * upstream — and it is blind to MISSING ones, which is the direction that
 * matters. Measured, one edit per mutant:
 *
 *   PHANTOM (caught at three of the four sites)
 *     + `KNOWN_EFFECTS` alone      TS2769 — `new Set<CapabilityEffect>` rejects
 *                                  a literal outside the union
 *     + `CapabilityEffect` alone   TS2741 — `EFFECT_DISCLOSURES`'s
 *                                  `Record<CapabilityEffect, …>` loses exhaustiveness
 *     + `ToolEffectSchema` alone   TS2322 ×2 — `plugin.ts`'s `returns` schemas
 *                                  stop matching the interfaces they pin
 *     + `ToolEffect` alone         GREEN. Nothing type-checked depends on this
 *                                  union's width across the boundary.
 *
 *   MISSING (caught at none of them — every one of these is silent)
 *     + `ToolEffect` alone, with the rules declaring it
 *     + `ToolEffect` AND `ToolEffectSchema` together, `channel-web` untouched —
 *       the REALISTIC half-edit, and the one this guard is really for
 *     - `'spends'` removed from `KNOWN_EFFECTS` alone
 *
 * So the compiler's coverage sits entirely on the harmless side of this mirror
 * and entirely absent from the dangerous one. A phantom member downstream
 * discloses nothing false; a member the rail cannot render understates a real
 * tool's reach.
 *
 * WHY A SOURCE SCAN RATHER THAN A SHARED TYPE. Invariant 2 forbids the
 * cross-plugin import, so the mirror is the architecture, not an oversight: the
 * two sides will stay hand-copied. A guard that wants to compare them therefore
 * has to read the TEXT of both files. `scripts/__tests__/disabled-builtin-rail-drift.test.js`
 * is the established pattern for exactly this shape and this file follows it,
 * including its fail-loud discipline: every parse is proved non-empty before
 * anything is compared, because an empty parse is what would make the comparison
 * pass while guarding nothing. Reading a file is not an import — no dependency
 * edge is created and `no-restricted-imports` is untouched.
 *
 * WHY IT LIVES HERE AND NOT IN `scripts/__tests__/`, which is where the pattern
 * it copies lives: the acceptance for this card is that the guard catches the
 * DROP, not merely the two declarations diverging — so it has to assert on what
 * `toWireEffects` EMITS. That means executing TypeScript from `channel-web`, and
 * the `scripts` suite is plain JS with no access to it. A declaration-only guard
 * would be the weaker half of this file.
 *
 * WHAT THIS DOES NOT COVER. It pins the member LISTS and the projection; it does
 * not check that any particular rule declares the right effects (that is
 * `capability-lint.ts` and the rail tests), nor that the authored copy is
 * accurate (that is `permission-frames.test.ts`). It also reads only the four
 * sites named below — a fifth copy made somewhere else is invisible to it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { toWirePermission } from '../../server/routes-workspace.js';
import { effectDisclosure } from '../../lib/permission-frames.js';
import type { CapabilityEffect } from '../../lib/workspace-types.js';

// …/packages/channel-web/src/__tests__/server -> repo root.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

const TOOL_POLICY_TYPES = join(REPO_ROOT, 'packages/tool-policy/src/types.ts');
const WORKSPACE_TYPES = join(REPO_ROOT, 'packages/channel-web/src/lib/workspace-types.ts');
const ROUTES_WORKSPACE = join(REPO_ROOT, 'packages/channel-web/src/server/routes-workspace.ts');

/**
 * Comments out, THEN members out — in that order, and the order is the point.
 * TASK-454 is a sibling guard that joined `\`-continuations BEFORE dropping
 * comments and so failed OPEN: a comment hid a live line from every scan.
 *
 * WHAT THIS ACTUALLY PROTECTS AGAINST, stated narrowly because a reviewer
 * caught the first draft overstating it. The hazard is an INLINE comment inside
 * the region being scanned — a `// plus 'destroys' once the rules declare it`
 * parked in the middle of the `KNOWN_EFFECTS` array, say, which a raw quote
 * scan would read as a member that is not there. The doc comments ABOVE the two
 * union declarations are not the hazard and never were: `capture()` starts at
 * the `=`, so the chunk handed to this function is only ever the right-hand
 * side. (They also use backticks, not single quotes.)
 *
 * Block comments first, then line comments: a `//` inside an already-removed
 * block comment must not survive to eat the line after it. The
 * `strips comments BEFORE extracting, and in the right order` test below pins
 * that ordering rather than asserting it here in prose.
 *
 * THE LIMIT, stated rather than dressed up as a guarantee — an earlier draft of
 * this paragraph claimed "an unparseable declaration comes back EMPTY and every
 * extractor throws, so this is fail-CLOSED", and a reviewer disproved it by
 * measurement. A `//` inside a string literal swallows the rest of THAT LINE
 * only: given `'outward'`, `'spends'` and `'we//ird'` on separate lines the scan
 * returns `['outward', 'spends']` — non-empty, so nothing throws, and the third
 * token is simply invisible. Emptiness is the failure mode only when the `//`
 * precedes every member.
 *
 * What makes that acceptable is the DOMAIN, not the parser: an effect member is
 * a slug (the parse-sanity test pins `^[a-z][a-z0-9-]*$`), so a `//` cannot
 * legitimately appear inside one. If somebody ever writes a member that
 * contains one, this guard will quietly not see it. Known, narrow, and written
 * down here so the next reader does not have to re-derive it.
 */
function stripComments(chunk: string): string {
  return chunk.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Every single-quoted string in a chunk, comments excluded, in source order. */
function quotedMembers(chunk: string, site: string): string[] {
  // `flatMap` and not `map(m => m[1])`: under `noUncheckedIndexedAccess` a capture
  // group is `string | undefined` even though group 1 here is mandatory, and the
  // honest widening is to drop the impossible case rather than cast it away or
  // `?? ''` it into a member that is not there.
  const members = [...stripComments(chunk).matchAll(/'([^']*)'/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
  if (members.length === 0) {
    throw new Error(
      `Parsed NO members out of ${site}. The declaration was reshaped — update this ` +
        `guard's parser. Do NOT delete the assertion: an empty parse here is exactly ` +
        `what would make this guard pass while checking nothing.`,
    );
  }
  return members;
}

/** The single capture group of `re` against `file`, or a loud failure. */
function capture(file: string, re: RegExp, site: string): string {
  const match = re.exec(readFileSync(file, 'utf8'));
  if (!match?.[1]) {
    throw new Error(
      `Could not find ${site} in ${file} (looked for ${re}). If it was renamed or ` +
        `reshaped, update this guard — do not delete it: it is the only thing that ` +
        `notices the four copies of this list drifting apart.`,
    );
  }
  return match[1];
}

/** `@ax/tool-policy`: the producer's union. The authoritative list. */
function toolEffectUnion(): string[] {
  const site = "`export type ToolEffect = …;`";
  return quotedMembers(
    capture(TOOL_POLICY_TYPES, /^export type ToolEffect\s*=\s*([^;]*);/m, site),
    site,
  );
}

/**
 * `@ax/tool-policy`: the `z.enum` the hook bus re-parses every answer against.
 *
 * Both directions of drift between this and `ToolEffect` are already caught,
 * which is why this site is the least interesting of the four: a member in the
 * union but not here fails the bus parse loudly at runtime, and a member here
 * but not in the union fails `tsc` at `plugin.ts`'s `returns` schemas (TS2322
 * ×2, measured). It is pinned anyway so that the guard's list is the whole
 * mirror rather than the parts somebody remembered.
 */
function toolEffectSchemaEnum(): string[] {
  const site = '`export const ToolEffectSchema = z.enum([…])`';
  return quotedMembers(
    capture(
      TOOL_POLICY_TYPES,
      /export const ToolEffectSchema\s*=\s*z\.enum\(\[([^\]]*)\]\)/,
      site,
    ),
    site,
  );
}

/** `channel-web`: the consumer's hand-copied union. */
function capabilityEffectUnion(): string[] {
  const site = "`export type CapabilityEffect = …;`";
  return quotedMembers(
    capture(WORKSPACE_TYPES, /^export type CapabilityEffect\s*=\s*([^;]*);/m, site),
    site,
  );
}

/** `channel-web`: the allow-list `toWireEffects` filters against — the dropper. */
function knownEffectsSet(): string[] {
  const site = '`const KNOWN_EFFECTS = new Set<CapabilityEffect>([…])`';
  return quotedMembers(
    capture(
      ROUTES_WORKSPACE,
      /const KNOWN_EFFECTS\b[^=]*=\s*new Set<[^>]*>\(\[([^\]]*)\]\)/,
      site,
    ),
    site,
  );
}

const sorted = (names: readonly string[]) => [...names].sort();

describe('declared-effect mirror — ToolEffect vs CapabilityEffect drift (TASK-408)', () => {
  const toolEffect = toolEffectUnion();
  const toolEffectSchema = toolEffectSchemaEnum();
  const capabilityEffect = capabilityEffectUnion();
  const knownEffects = knownEffectsSet();

  it('strips comments BEFORE extracting, and in the right order', () => {
    /*
      `stripComments` is the identity on all four chunks as they stand today —
      none contains a comment — so nothing else in this file exercises it and
      deleting it would fail no test. That is precisely the shape this branch
      already rejected once: a protection asserted only in prose does not fail
      when the thing it warns about happens.

      What it protects is a FALSE POSITIVE, not a real drift: a future inline
      comment in one of the member lists would otherwise be read as a member,
      and the guard would report a mirror mismatch that does not exist.
    */
    const parse = (chunk: string) => quotedMembers(chunk, 'a test probe');

    // A comment inside the list must not contribute a member. Both spellings.
    expect(
      parse("\n  'outward',\n  /* 'destroys' when a rule declares it */\n  'spends',\n"),
    ).toEqual(['outward', 'spends']);
    expect(parse("\n  'outward',\n  // 'destroys' when a rule declares it\n  'spends',\n")).toEqual([
      'outward',
      'spends',
    ]);

    // THE ORDERING, which is the half TASK-454's siblings got wrong. Block
    // comments must go first: strip line comments first and the `//` INSIDE
    // this block comment eats the rest of the line — both members with it —
    // leaving an unterminated `/*` and an empty parse, which throws. Measured:
    // swapping the two `.replace` calls takes this test from green to red.
    expect(parse("/* // */ 'outward', 'spends'")).toEqual(['outward', 'spends']);

    // An empty parse throws rather than returning `[]`. An empty member list
    // would make every set-equality below pass while comparing nothing.
    expect(() => parse("\n  // 'outward', 'spends'\n")).toThrow(/Parsed NO members/);
  });

  it('parsed real members out of all four sites', () => {
    // A floor plus both current anchors, not an exact list: this proves the
    // parsers read the declarations rather than empty space, and it makes a
    // REMOVAL a review moment too. It is deliberately NOT the whole guard — a
    // check that only asserts "all four files contain these two strings today"
    // goes vacuous the moment somebody edits all four, which is why the two
    // assertions below are the ones that carry the card.
    for (const [site, members] of [
      ['ToolEffect', toolEffect],
      ['ToolEffectSchema', toolEffectSchema],
      ['CapabilityEffect', capabilityEffect],
      ['KNOWN_EFFECTS', knownEffects],
    ] as const) {
      expect(members.length, `${site} members parsed`).toBeGreaterThanOrEqual(2);
      expect(members, `${site} members`).toContain('outward');
      expect(members, `${site} members`).toContain('spends');
      for (const member of members) {
        expect(member, `${site} member`).toMatch(/^[a-z][a-z0-9-]*$/);
      }
    }
  });

  it('all four hand-copied member lists are the same set', () => {
    const expected = sorted(toolEffect);
    const message =
      'The four copies of the declared-effect member list have DRIFTED.\n' +
      'They are hand-copied by design — invariant 2 forbids `channel-web` importing ' +
      '`@ax/tool-policy` — so adding a member means adding it to all four:\n' +
      '  1. `ToolEffect`        packages/tool-policy/src/types.ts\n' +
      '  2. `ToolEffectSchema`  packages/tool-policy/src/types.ts (the bus re-parse)\n' +
      '  3. `CapabilityEffect`  packages/channel-web/src/lib/workspace-types.ts\n' +
      '  4. `KNOWN_EFFECTS`     packages/channel-web/src/server/routes-workspace.ts\n' +
      'and writing authored copy for it in `EFFECT_DISCLOSURES` ' +
      '(packages/channel-web/src/lib/permission-frames.ts).\n' +
      `  ToolEffect:        ${sorted(toolEffect).join(', ')}\n` +
      `  ToolEffectSchema:  ${sorted(toolEffectSchema).join(', ')}\n` +
      `  CapabilityEffect:  ${sorted(capabilityEffect).join(', ')}\n` +
      `  KNOWN_EFFECTS:     ${sorted(knownEffects).join(', ')}\n` +
      'A member missing from `KNOWN_EFFECTS` is the dangerous one: `toWireEffects` ' +
      'drops it without a word and the rail claims LESS reach than the tool has.';

    expect(sorted(toolEffectSchema), message).toEqual(expected);
    expect(sorted(capabilityEffect), message).toEqual(expected);
    expect(sorted(knownEffects), message).toEqual(expected);
  });

  it('every member the producer can declare SURVIVES the wire projection', () => {
    // The half that catches the DROP rather than the divergence. `toWireEffects`
    // is module-private, so this asks through the real exported projection,
    // which is also the honest question: a filter that is correct but no longer
    // WIRED IN is #574's regression, and a unit test of the filter alone cannot
    // see it.
    //
    // HOW MUCH UNWIRING THIS ACTUALLY CATCHES, measured rather than assumed
    // after a reviewer pushed on it. Deleting the `effect:` line entirely →
    // caught (`undefined`). Replacing `toWireEffects(row.effect)` with the cast
    // `row.effect as CapabilityEffect[]` → NOT caught by the loop below, because
    // with the four lists in sync every real member survives a cast too. That
    // mutant is what the junk probe at the end of this test is for: a cast puts
    // the invented member straight onto the security surface, where the renderer
    // has no entry for it and drops it silently.
    for (const member of toolEffect) {
      const wire = toWirePermission({
        verdict: 'hold',
        capability: 'do the thing this member describes',
        source: 'rule:mirror.probe',
        provenance: 'rule',
        described: true,
        effect: [member],
      });

      expect(
        wire.effect,
        `\`toWireEffects\` DROPPED '${member}', a member \`ToolEffect\` can declare.\n` +
          'The rail would render that call as claiming less reach than it has — the ' +
          'understating direction design H4 forbids. Add it to `KNOWN_EFFECTS` in ' +
          'packages/channel-web/src/server/routes-workspace.ts (and give it authored ' +
          'copy in `EFFECT_DISCLOSURES`).',
      ).toEqual([member]);
    }

    // The junk probe. Not a duplicate of the end-to-end refusal test in
    // `routes-workspace-rail.test.ts` (TASK-383) — that one proves the ROUTE
    // refuses junk; this one proves the projection is still a FILTER and not a
    // cast, which is the mutant the loop above cannot see. A member that no
    // authored copy can render must not reach the wire, and the true half of
    // the set must survive alongside it (dropping the whole set over one bad
    // member would understate a real effect, design H4).
    const probe = toWirePermission({
      verdict: 'hold',
      capability: 'do the thing this member describes',
      source: 'rule:mirror.probe',
      provenance: 'rule',
      described: true,
      effect: [...toolEffect, 'not-a-real-effect'],
    });
    expect(
      probe.effect,
      'An invented effect member reached the wire. `toWirePermission` must FILTER ' +
        '`row.effect` per member (`toWireEffects`), never cast it: a cast puts ' +
        "whatever an alternate policy impl invented onto the rail, where the " +
        'renderer has no entry for it and drops it without a word.',
    ).toEqual(toolEffect);
  });

  it('every member the producer can declare has authored disclosure copy', () => {
    // The renderer's half. `EFFECT_DISCLOSURES` is `Record<CapabilityEffect, …>`,
    // so `tsc` already pins it to the CONSUMER's union — but not to the
    // PRODUCER's, which is the union that decides what actually arrives. A
    // member added to `ToolEffect` alone reaches a row with no copy behind it,
    // and `effectDisclosure` spreads `undefined` into an empty object rather
    // than throwing, so the badge would render blank instead of failing.
    for (const member of toolEffect) {
      const disclosure = effectDisclosure(member as CapabilityEffect);
      for (const field of ['label', 'srLabel', 'detail'] as const) {
        expect(
          disclosure[field],
          `No authored \`${field}\` for effect '${member}' in \`EFFECT_DISCLOSURES\` ` +
            '(packages/channel-web/src/lib/permission-frames.ts). A declared effect ' +
            'with no copy renders as a blank badge on a consent surface.',
        ).toBeTruthy();
      }
    }
  });
});
