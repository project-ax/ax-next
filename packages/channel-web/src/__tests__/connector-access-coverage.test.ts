/**
 * TASK-700 — the access disclosure must not depend on someone remembering it.
 *
 * `ConnectorAccessNotice` is rendered by each surface that hands an assistant
 * access to a service. It is NOT on `CredentialSlotForm`, because that primitive
 * is shared with model-provider keys and routine webhook secrets, where "your
 * assistant can read or change things in this service" would be false. So
 * coverage is per call site — and per-call-site coverage is exactly the kind
 * that quietly rots: the next person to add a key-entry surface copies the
 * neighbouring form, has no reason to know a notice exists, and ships an
 * unannounced way to give an agent a key.
 *
 * This scan turns that into a failing test. Any non-test source file that
 *   - calls `setDestinationCredential(...)` (writes a key to the vault),
 *   - renders `<CredentialSlotForm` (a key-entry form), or
 *   - renders `<ConnectorOAuthConnect` (a sign-in that grants access), or
 *   - calls `useOAuthPopup(` (the same sign-in without the widget — TASK-740),
 *   - renders `<ApiKeyField` (the bare key field, slice 3), or
 *   - calls `.attachConnector(` (adds a connector to an agent, keys and all —
 *     slice 3: a per-agent key rides in that request)
 * must render `<ConnectorAccessNotice` too, or be on the allowlist below with a
 * stated reason. The allowlist is checked BOTH ways: a stale entry (the file no
 * longer matches, or no longer exists) fails as loudly as a missing notice, so
 * the list cannot become a place to park exemptions nobody re-reads.
 *
 * Comments are stripped before scanning, the same crude way
 * `vocabulary.test.ts` does it: prose in a comment must not count as a call.
 *
 * What this CANNOT see, stated rather than implied: a surface that gets a key
 * to the vault by a route it does not spell with one of the names above
 * (a raw `fetch` to `/settings/destinations/...`). `lib/credentials.ts` is the
 * one place those routes are built, so that would have to bypass it on purpose.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

/** Files that touch a credential but are NOT a connector call site, and why. */
const EXEMPT: Record<string, string> = {
  'components/credentials/CredentialSlotForm.tsx':
    'the shared key-entry primitive: it also enters model-provider keys and routine webhook secrets. Connector call sites own the notice.',
  'components/credentials/CredentialSlotRow.tsx':
    'renders CredentialSlotForm for ProvidersPanel (model keys) and RoutinesList (webhook signing secrets); neither is a service the agent acts on.',
};

const TRIGGERS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'setDestinationCredential(', pattern: /\bsetDestinationCredential\s*\(/ },
  { name: '<CredentialSlotForm', pattern: /<CredentialSlotForm\b/ },
  { name: '<ConnectorOAuthConnect', pattern: /<ConnectorOAuthConnect\b/ },
  { name: 'useOAuthPopup(', pattern: /\buseOAuthPopup\s*\(/ },
  { name: '<ApiKeyField', pattern: /<ApiKeyField\b/ },
  { name: '.attachConnector(', pattern: /\.attachConnector\s*\(/ },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

interface Scanned {
  rel: string;
  triggers: string[];
  rendersNotice: boolean;
}

function scan(): Scanned[] {
  const found: Scanned[] = [];
  // `components/` only: `lib/credentials.ts` DEFINES `setDestinationCredential`
  // and would match its own declaration. Nothing outside `components/` renders JSX.
  for (const file of sourceFiles(join(SRC, 'components'))) {
    const body = withoutComments(readFileSync(file, 'utf8'));
    const triggers = TRIGGERS.filter((t) => t.pattern.test(body)).map((t) => t.name);
    if (triggers.length === 0) continue;
    found.push({
      rel: relative(SRC, file).split('\\').join('/'),
      triggers,
      rendersNotice: /<ConnectorAccessNotice\b/.test(body),
    });
  }
  return found;
}

describe('connector access disclosure: coverage (TASK-700)', () => {
  const scanned = scan();

  it('finds the surfaces it is meant to guard (a scan that matches nothing guards nothing)', () => {
    const rels = scanned.map((s) => s.rel);
    for (const expected of [
      'components/settings/LegacyConnectorEditDialog.tsx',
      'components/settings/RemoteMcpConnectorForm.tsx',
      'components/workspace/GrantRow.tsx',
      'components/workspace/AddConnector.tsx',
      // Slice 3 — the per-agent key form whose save is the Add (and a row's
      // Add key).
      'components/workspace/AddKeyDialog.tsx',
      // TASK-799 — AgentForm no longer attaches connectors or signs a team agent
      // in; that moved to the workspace rail.
      'components/workspace/AgentConnectors.tsx',
      'components/credentials/CredentialSlotForm.tsx',
    ]) {
      expect(rels, `the scan no longer sees ${expected}`).toContain(expected);
    }
  });

  it('every file that takes a key or a sign-in renders the notice, or is exempt for a stated reason', () => {
    const missing = scanned
      .filter((s) => !s.rendersNotice && EXEMPT[s.rel] === undefined)
      .map((s) => `${s.rel}  (uses ${s.triggers.join(', ')})`);
    expect(
      missing,
      'These files hand an agent a key or sign-in without <ConnectorAccessNotice />. Render it ' +
        '(kind key / sign-in / attach / author) or, if no service access is being granted, add the ' +
        'file to EXEMPT in this test with the reason.',
    ).toEqual([]);
  });

  it('the exemptions are live: each names a file that exists and still touches a credential', () => {
    for (const rel of Object.keys(EXEMPT)) {
      expect(existsSync(join(SRC, rel)), `${rel} no longer exists; drop it from EXEMPT`).toBe(true);
      expect(
        scanned.some((s) => s.rel === rel),
        `${rel} no longer touches a credential; drop it from EXEMPT`,
      ).toBe(true);
    }
  });

  it('an exempt file does not ALSO render the notice (that would be a stale exemption)', () => {
    for (const rel of Object.keys(EXEMPT)) {
      const s = scanned.find((x) => x.rel === rel);
      expect(s?.rendersNotice, `${rel} renders the notice now; drop it from EXEMPT`).toBe(false);
    }
  });
});
