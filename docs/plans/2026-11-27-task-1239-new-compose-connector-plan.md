# TASK-1239: "New connector" asks what kind first — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From Admin › Connectors, an admin can create a connector, paste a compose file, pick a profile, pin, set on-demand and save, without the API.

**Architecture:** "New connector" opens a small two-option chooser owned by `ConnectorsTab`. The answer reaches the existing dispatcher `ConnectorEditDialog` as an opt-in `kind` prop. `'remote'` (the default, unchanged) opens `RemoteMcpConnectorForm`. `'general'` opens the existing general editor `LegacyConnectorEditDialog` from a memoized blank draft. That editor already has the whole compose import (paste, profile, pinning, on-demand) and already creates on Save. This is UI-only: `POST /admin/connectors` already validates and stores `services` and `servicesMode`.

**Tech Stack:** React and Radix through the shadcn primitives in `packages/channel-web`; Vitest and Testing Library (jsdom).

**Spec:** the TASK-1239 card, plus `docs/plans/2026-11-12-sandbox-service-reach-design.md` §1 (decision 7) and §4. Decisions: `.claude/memory/decisions/2026-11-27-TASK-1239.md`.

> Card, Done when: (1) From Admin › Connectors, an admin can create a connector, paste a compose file, pick a profile, pin, set on-demand and save, without the API. (2) A UI test covers the path.

## What we found (premise check, at cbf1d68ef)

- **Server: ready.** `POST /admin/connectors` (`packages/connectors/src/admin-routes.ts:677-756`) goes through `connectors:upsert`, which checks `services` and `servicesMode` with `validateCapabilitiesForWrite` (`store.ts:156-166`; schema `types.ts:233-247`). `POST /admin/connectors/pin-images` exists.
- **Editor: ready.** `LegacyConnectorEditDialog` creates on Save when `target === 'new'` (`:838-871`). Its Services section does paste, profile, pin and on-demand (`:207-642`). `ConnectorEditDialog.test.tsx:425-731` covers that standalone (that file imports the Legacy editor under the dispatcher's name).
- **The gap:** the dispatcher sends every blank new connector to the remote MCP form (`ConnectorEditDialog.tsx:98`, since #833). The general editor opens only to edit a connector with no MCP server, or for "Set it up" on a request with none. The TASK-1223 walk had to `POST` an empty connector and then edit it.
- **Test constraint:** 20 call sites in `RemoteMcpConnectorForm.test.tsx` (`openNew()` ×18, `:233`, `:664`) render the dispatcher with a blank `'new'` and expect the remote form. Keeping the dispatcher's default unchanged keeps them green untouched.

## Design

Approaches considered (rationale in the decisions shard):

- **Chosen: chooser owned by `ConnectorsTab`, opt-in `kind` on the dispatcher.** One "New connector" everywhere (header and the directory's by-hand buttons), a plain explanation of both kinds before any field, and neither editor changes. Cost: one more click for an MCP server added by hand. The directory is the main MCP path since TASK-1101.
- *Choice inside both forms (the card's example).* Edits both large forms, shows "MCP server" twice in the general editor (its "How it connects" offers it too), and loses typed input on a switch.
- *A "New connector ▾" menu.* The directory's by-hand buttons are `EmptyState` actions and can't be menus, so one label would mean two things.
- *A third header button.* No focus work, but "New connector" would stay MCP-only while sounding generic, and the header grows for a rare action.
- *Chooser inside the dispatcher.* Churns the 20 test call sites above, and routing is the dispatcher's only job.

**Focus.** `components/ui/use-opener-restore.ts` records a dialog's opener when it opens. If the chooser unmounts and the editor mounts in one commit, the editor records `<body>`, because the focused Continue button just left the document. Closing the editor then drops a keyboard user at the top of the page. Today's direct path returns focus to "New connector", so the chooser must not regress it. It opens the editor from its own `onCloseAutoFocus`, after it has finished closing, one task later (`setTimeout(…, 0)`). By then the primitive has put focus back on the opener, and the editor records that. This is the `MemoryActions` shape from TASK-949 (`components/workspace/TaskSteps.tsx:766-775`).

## Global Constraints

- channel-web lint (`eslint.config.mjs:325-337`): no raw `div`/`span`/`p`/`h2`–`h6`, no `className` on intrinsic elements, no arbitrary Tailwind values, no `style` prop, no `@/components/ui/{alert,skeleton,empty}`. `NewConnectorChooser.tsx` and `ConnectorEditDialog.tsx` stay at zero suppressions. `ConnectorsTab.tsx`'s frozen counts (`no-classname` 11, `no-raw-elements` 11) must not rise. If lint reports an unused suppression, run `pnpm lint:ui:prune`.
- Compose installed primitives only (invariant 6): `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `FieldSet`, `FieldLegend`, `Field`, `FieldContent`, `FieldLabel`, `FieldDescription`, `RadioGroup`, `RadioGroupItem` and `Button` from `@/components/ui/*`. The lint-clean `components/workspace/AddOwnerDialog.tsx` is the model. No shadcn installs, no new dependencies. Invoke the `shadcn` skill before Task 2 (CLAUDE.md invariant 6).
- `RemoteMcpConnectorForm.tsx` is untouched. `LegacyConnectorEditDialog.tsx` gets a comment edit only.
- No server, hook, route or IPC change.
- Copy is exact (Task 2), with the codebase's typographic apostrophe ’.
- Filter before the script: `pnpm --filter @ax/channel-web <script>`. channel-web's `tsc` type-checks test files, so `pnpm --filter @ax/channel-web build` must pass too (`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` apply to tests).

## Review Focus

1. **Focus after the hand-off.** Closing an editor opened through the chooser puts focus back on the button that opened the chooser, not `<body>`. Test: Task 2, `focus returns to New connector…`. **Reviewer:** the hand-off must hang off the chooser's `onCloseAutoFocus`, never a count of timers. jsdom has no exit animation, so a timer chain passes here. In a browser, `DialogContent` has a 200 ms exit animation, and a timer chain opens the editor while the chooser is still closing.
2. **A late parent re-render keeps the admin's input.** The requests list and the directory check resolve after mount and re-render the tab, and the blank general editor must not reset. Test: Task 1, `keeps what the admin typed when the parent re-renders`.
3. **A leftover kind never hijacks "Set it up".** After choosing services and cancelling, "Set it up" on an MCP request still opens the remote form. Test: Task 1, `a prefill wins over kind`. Also, `ConnectorsTab` passes `kind` only for a blank new connector.
4. **The directory's by-hand "New connector" asks the same question,** and Cancel leaves the directory as it was. Test: Task 2, `the directory’s New connector…`.
5. **Save sends only the picked profile's services, pinned, in start order, on demand, with no MCP server.** Test: Task 2, the Done-when test.

## Files

| File | Task | Change |
|---|---|---|
| `packages/channel-web/src/components/settings/ConnectorEditDialog.tsx` | 1 | `NewConnectorKind`, `kind` prop, `blankGeneralDraft()`, memo, routing comment |
| `packages/channel-web/src/components/settings/LegacyConnectorEditDialog.tsx:1-5` | 1 | header comment (rule-5 stale line) |
| `packages/channel-web/src/components/settings/__tests__/ConnectorEditDialog.kind.test.tsx` | 1 | new |
| `packages/channel-web/src/components/settings/NewConnectorChooser.tsx` | 2 | new |
| `packages/channel-web/src/components/settings/ConnectorsTab.tsx` | 2 | chooser state, both entry points, `kind`, header comment |
| `packages/channel-web/src/components/settings/__tests__/ConnectorsTab.test.tsx:548-553` | 2 | the one existing test whose flow changes |
| `packages/channel-web/src/components/settings/__tests__/ConnectorsTab.new-connector.test.tsx` | 2 | new |
| `docs/plans/2026-10-01-remote-mcp-connector-modal.md:11` | 2 | dated note (rule-5 stale line) |

New tests go in new files, following the TASK-758 precedent: sibling cards may be editing the large suites.

---

### Task 1: The dispatcher can open the general editor for a blank new connector `[tier: mechanical]`

**Files:**
- Modify: `packages/channel-web/src/components/settings/ConnectorEditDialog.tsx`
- Modify: `packages/channel-web/src/components/settings/LegacyConnectorEditDialog.tsx:1-5` (comment only)
- Test: `packages/channel-web/src/components/settings/__tests__/ConnectorEditDialog.kind.test.tsx` (new)

**Interfaces:**
- Produces, in `ConnectorEditDialog.tsx`: `export type NewConnectorKind = 'remote' | 'general';` and `export function ConnectorEditDialog({ kind = 'remote', ...props }: ConnectorEditDialogProps & { kind?: NewConnectorKind })`.

- [ ] **Step 1: Write the failing tests**

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ConnectorEditDialog } from '../ConnectorEditDialog';
import * as oauthLib from '@/lib/connectors-oauth';
import { emptyCapabilities, type ConnectorPrefill } from '@/lib/connectors';

const props = () => ({ target: 'new' as const, open: true, onOpenChange: vi.fn(), onSaved: vi.fn() });
const MCP_REQUEST: ConnectorPrefill = {
  connectorId: 'notion',
  name: 'Notion',
  usageNote: '',
  keyMode: 'personal',
  capabilities: {
    ...emptyCapabilities(),
    mcpServers: [{ name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp', allowedHosts: [], credentials: [] }],
  },
};

describe('ConnectorEditDialog kind (TASK-1239)', () => {
  // The remote form reads AX's OAuth client details on mount; keep it offline.
  beforeEach(() => {
    vi.spyOn(oauthLib, 'getOAuthClientMetadata').mockRejectedValue(new Error('offline'));
  });
  afterEach(() => vi.restoreAllMocks());

  it('a blank new connector opens the remote MCP form by default', () => {
    render(<ConnectorEditDialog {...props()} />);
    expect(screen.getByLabelText('Server URL')).toBeInTheDocument();
    expect(screen.queryByLabelText(/paste a docker-compose/i)).toBeNull();
  });

  it('kind "general" opens the general editor blank, on Direct API, with the compose paste', async () => {
    render(<ConnectorEditDialog {...props()} kind="general" />);
    const dialog = await screen.findByRole('dialog', { name: 'New connector' });
    expect(within(dialog).getByRole('radio', { name: /direct api/i })).toHaveAttribute('data-state', 'on');
    expect(within(dialog).queryByLabelText(/^url$/i)).toBeNull();
    expect(within(dialog).getByLabelText(/service name/i)).toHaveValue('');
    expect(within(dialog).getByLabelText(/paste a docker-compose/i)).toBeInTheDocument();
  });

  it('a prefill wins over kind', () => {
    render(<ConnectorEditDialog {...props()} prefill={MCP_REQUEST} kind="general" />);
    expect(screen.getByLabelText('Server URL')).toHaveValue('https://mcp.notion.com/mcp');
  });

  it('keeps what the admin typed when the parent re-renders', async () => {
    const { rerender } = render(<ConnectorEditDialog {...props()} kind="general" />);
    fireEvent.change(await screen.findByLabelText(/service name/i), { target: { value: 'Dev stack' } });
    rerender(<ConnectorEditDialog {...props()} kind="general" />);
    expect(screen.getByLabelText(/service name/i)).toHaveValue('Dev stack');
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `pnpm --filter @ax/channel-web exec vitest run src/components/settings/__tests__/ConnectorEditDialog.kind.test.tsx`
Expected: `kind "general" …` and `keeps what the admin typed …` FAIL (the remote form opens, so there is no dialog named "New connector" and no "Service name"). The default test and `a prefill wins over kind` pass already. They are guards that must stay green.

- [ ] **Step 3: Implement in `ConnectorEditDialog.tsx`**

- `export type NewConnectorKind = 'remote' | 'general';`
- `function blankGeneralDraft(): Connector` returns `{ id: '', name: '', description: '', usageNote: '', keyMode: 'personal', createdAt: '', updatedAt: '', capabilities: emptyCapabilities() }` (import `emptyCapabilities` from `@/lib/connectors`). Empty capabilities make `formFromConnector` open on Direct API. The empty id makes Save derive the id from the name. Doc comment: `TASK-1239: the general editor's blank start. Not saved: the target stays 'new'.`
- The signature from Interfaces. Doc comment on `kind`: `TASK-1239: which editor a BLANK new connector opens (target 'new', no prefill). 'remote' (default) is the remote MCP server form; 'general' is the general editor, started from an empty draft. Ignored for an edit, and a prefill always decides by what it carries.`
- `const [blankGeneral] = useState(blankGeneralDraft);` (state, not `useMemo`: React treats `useMemo` as a hint, `useState` guarantees the identity) goes with the other hooks, before `if (!open) return null`. Comment: `Stable across renders: the general editor re-seeds its form whenever its starting connector changes.`
- In the `target === 'new'` branch, after the two `routed` returns: `if (kind === 'general') return <LegacyConnectorEditDialog {...props} connector={blankGeneral} />;`, then the existing `return <RemoteMcpConnectorForm {...props} />;`. `props` no longer holds `kind`, so neither form receives it.
- Replace the branch comment at `:86-87` with: `"Set it up": the request or listing decides (an MCP server opens the remote-server form, which reads the prefill itself; anything else the general editor). A blank one opens what "New connector" asked for (TASK-1239).`

Rule-5 stale line: in `LegacyConnectorEditDialog.tsx`, replace header lines 2-5 (`ConnectorEditDialog — the mechanism-first connector create/edit form … writes through /admin/connectors.`) with:

```
 * LegacyConnectorEditDialog: the general connector editor, for a connector
 * with no MCP server (allowed hosts, keys, a package, services). TASK-128,
 * settings-unified epic. Admin-only since slice 2a. Admin › Connectors opens
 * it for a new connector ("New connector" → "Services, APIs or command-line
 * tools", TASK-1239; or "Set it up" on a request with no MCP server, slice
 * 2c) and to edit one. MCP servers use `RemoteMcpConnectorForm` (#833). It
 * reads and writes through `/admin/connectors`.
```

- [ ] **Step 4: Run the tests and see them pass, defaults included**

Run: `pnpm --filter @ax/channel-web exec vitest run src/components/settings/__tests__/ConnectorEditDialog.kind.test.tsx src/components/settings/__tests__/RemoteMcpConnectorForm.test.tsx src/components/settings/__tests__/RemoteMcpConnectorForm.retarget.test.tsx src/components/settings/__tests__/RemoteMcpConnectorForm.endpoint-reset.test.tsx src/components/settings/__tests__/ConnectorsTab.test.tsx`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/settings/ConnectorEditDialog.tsx packages/channel-web/src/components/settings/LegacyConnectorEditDialog.tsx packages/channel-web/src/components/settings/__tests__/ConnectorEditDialog.kind.test.tsx
git commit -m "[TASK-1239] Connector editor: a blank new connector can open the general editor"
```

---

### Task 2: "New connector" asks what kind first `[tier: sensitive]`

Sensitive because the hand-off races Radix's deferred focus restore, and jsdom can't see the browser's exit animation (Review Focus 1).

**Files:**
- Create: `packages/channel-web/src/components/settings/NewConnectorChooser.tsx`
- Modify: `packages/channel-web/src/components/settings/ConnectorsTab.tsx`
- Modify: `packages/channel-web/src/components/settings/__tests__/ConnectorsTab.test.tsx:548-553`
- Create: `packages/channel-web/src/components/settings/__tests__/ConnectorsTab.new-connector.test.tsx`
- Modify: `docs/plans/2026-10-01-remote-mcp-connector-modal.md` (a note after line 11)

**Interfaces:**
- Consumes: `NewConnectorKind` (type-only import) and `ConnectorEditDialog`'s `kind` prop, from Task 1.
- Produces: `export function NewConnectorChooser({ onCancel, onChosen }: { onCancel: () => void; onChosen: (kind: NewConnectorKind) => void })` in `NewConnectorChooser.tsx`.

- [ ] **Step 1: Update the one existing test whose flow changes** (`ConnectorsTab.test.tsx:548-553`; `within` is already imported)

```tsx
  it('admin "New connector" asks what kind first; MCP server opens the remote-server form', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    fireEvent.click(screen.getByRole('button', { name: /new connector/i }));
    const chooser = await screen.findByRole('dialog', { name: 'New connector' });
    expect(within(chooser).getByText('What are you adding? You’ll fill in the details next.')).toBeInTheDocument();
    expect(within(chooser).getByRole('radio', { name: 'MCP server' })).toBeChecked();
    expect(within(chooser).getByRole('radio', { name: 'Services, APIs or command-line tools' })).not.toBeChecked();
    expect(within(chooser).getByText('Tools from a remote server, like Linear or Notion.')).toBeInTheDocument();
    expect(
      within(chooser).getByText('A database or cache from a Compose file, an API that takes a key, or a tool from npm or PyPI.'),
    ).toBeInTheDocument();
    fireEvent.click(within(chooser).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByLabelText('Server URL')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Write the new tests** in `ConnectorsTab.new-connector.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { ConnectorsTab } from '../ConnectorsTab';
import * as connectorsLib from '@/lib/connectors';
import * as directoryLib from '@/lib/connector-directory';
import { directoryPage } from '@/lib/__tests__/directory-fixtures';
import type { ConnectorSummary } from '@/lib/connectors';

const EXISTING: ConnectorSummary = {
  id: 'my-notion', name: 'My Notion', description: '', usageNote: '', keyMode: 'personal',
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
};
const SERVICES = 'Services, APIs or command-line tools';
// Two groups ("profiles"), every service in one, tag-only images (so the editor pins them).
const COMPOSE = [
  'services:',
  '  redis:', '    image: redis:7', '    profiles: [e2e]',
  '  postgres:', '    image: postgres:16', '    profiles: [e2e]', '    depends_on: [redis]',
  '  nginx:', '    image: nginx:1.27', '    profiles: [dev]',
  '',
].join('\n');
const PINNED: Record<string, string> = {
  'redis:7': `docker.io/library/redis@sha256:${'a'.repeat(64)}`,
  'postgres:16': `docker.io/library/postgres@sha256:${'b'.repeat(64)}`,
};

describe('New connector asks what kind (TASK-1239)', () => {
  beforeEach(() => {
    vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([EXISTING]);
    vi.spyOn(connectorsLib, 'listAuthoredProposals').mockResolvedValue([]);
    vi.spyOn(directoryLib, 'searchDirectory').mockResolvedValue(directoryPage());
  });
  afterEach(() => vi.restoreAllMocks());

  it('an admin adds a services connector from a compose file: picks a group, pins, turns on on-demand, saves', async () => {
    const pin = vi.spyOn(connectorsLib, 'pinImages').mockImplementation(async (images) =>
      images.map((image) => {
        const ref = PINNED[image];
        return ref ? { image, pinned: ref } : { image, error: 'not found' };
      }),
    );
    const create = vi.spyOn(connectorsLib, 'createConnector').mockResolvedValue({
      ...EXISTING, id: 'dev-stack', name: 'Dev stack', capabilities: connectorsLib.emptyCapabilities(),
    });
    render(<ConnectorsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'New connector' }));
    const chooser = await screen.findByRole('dialog', { name: 'New connector' });
    fireEvent.click(within(chooser).getByRole('radio', { name: SERVICES }));
    fireEvent.click(within(chooser).getByRole('button', { name: 'Continue' }));

    const name = await screen.findByLabelText(/service name/i);
    const editor = name.closest('[role="dialog"]') as HTMLElement;
    fireEvent.change(name, { target: { value: 'Dev stack' } });
    fireEvent.change(within(editor).getByLabelText(/paste a docker-compose/i), { target: { value: COMPOSE } });
    fireEvent.click(within(editor).getByRole('button', { name: /add services from this file/i }));
    await within(editor).findByText(/pick a group to bring in services/i);
    fireEvent.click(document.getElementById('connector-compose-profile')!);
    fireEvent.click(await screen.findByRole('option', { name: 'e2e' }));
    await within(editor).findByText(/we locked these to exact versions/i);
    expect([...pin.mock.calls.at(-1)![0]].sort()).toEqual(['postgres:16', 'redis:7']);
    fireEvent.click(within(editor).getByRole('switch', { name: /start only when needed/i }));
    fireEvent.click(within(editor).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [body, base] = create.mock.calls[0]!;
    expect(base).toBe('/admin/connectors');
    expect(body).toMatchObject({ connectorId: 'dev-stack', name: 'Dev stack' });
    expect(body.capabilities.mcpServers).toEqual([]);
    expect(body.capabilities.servicesMode).toBe('on-demand');
    expect(body.capabilities.services?.map((s) => [s.name, s.image])).toEqual([
      ['redis', PINNED['redis:7']],
      ['postgres', PINNED['postgres:16']],
    ]);
    // Saved: the editor closes and the list is read again.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(connectorsLib.listConnectors).toHaveBeenCalledTimes(2));
  });

  it('focus returns to New connector whether the admin cancels the question or the editor after it', async () => {
    render(<ConnectorsTab />);
    const opener = await screen.findByRole('button', { name: 'New connector' });
    // Arrive the way a keyboard user does, then activate.
    opener.focus();
    fireEvent.click(opener);
    const first = await screen.findByRole('dialog', { name: 'New connector' });
    fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(opener));

    fireEvent.click(opener);
    const chooser = await screen.findByRole('dialog', { name: 'New connector' });
    fireEvent.click(within(chooser).getByRole('radio', { name: SERVICES }));
    fireEvent.click(within(chooser).getByRole('button', { name: 'Continue' }));
    const editor = (await screen.findByLabelText(/service name/i)).closest('[role="dialog"]') as HTMLElement;
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('the directory’s New connector asks the same question, and Cancel leaves the directory as it was', async () => {
    vi.spyOn(directoryLib, 'searchDirectory').mockResolvedValue(directoryPage({ syncedAt: null }));
    render(<ConnectorsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Find in directory' }));
    fireEvent.click(await screen.findByRole('button', { name: 'New connector' }));
    const chooser = await screen.findByRole('dialog', { name: 'New connector' });
    fireEvent.click(within(chooser).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('The directory isn’t available yet')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the tests and see them fail**

Run: `pnpm --filter @ax/channel-web exec vitest run src/components/settings/__tests__/ConnectorsTab.new-connector.test.tsx src/components/settings/__tests__/ConnectorsTab.test.tsx`
Expected: the four tests above FAIL, with no dialog named "New connector" (the remote form, "Add connector", opens instead). The rest of `ConnectorsTab.test.tsx` passes.

- [ ] **Step 4: Create `NewConnectorChooser.tsx`.** The copy is fixed, and the close-then-open hand-off is the algorithm. Use this body as written:

```tsx
/**
 * NewConnectorChooser: "New connector" asks what kind first (TASK-1239).
 *
 * An MCP server opens the remote-server form. Services, an API or a
 * command-line tool open the general editor, the one with the compose paste.
 * The parent opens that editor from `onChosen`.
 *
 * FOCUS. `onChosen` runs only after this dialog has finished closing (its
 * `onCloseAutoFocus`, after the exit animation), one task later. By then the
 * dialog primitive (`use-opener-restore`) has put focus back on the button
 * that opened us, so the editor records that button as its own opener and
 * returns focus there when it closes. Opening the editor in the same commit
 * that removes this dialog would record `<body>` instead. Never swap this for
 * a count of timers: jsdom has no exit animation, so that passes the tests and
 * breaks in a browser. Same shape as MemoryActions (TASK-949).
 *
 * Fixed copy only. shadcn primitives and semantic tokens (invariant 6).
 */
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { NewConnectorKind } from './ConnectorEditDialog';

const KINDS: ReadonlyArray<{ value: NewConnectorKind; label: string; description: string }> = [
  { value: 'remote', label: 'MCP server', description: 'Tools from a remote server, like Linear or Notion.' },
  {
    value: 'general',
    label: 'Services, APIs or command-line tools',
    description: 'A database or cache from a Compose file, an API that takes a key, or a tool from npm or PyPI.',
  },
];

export function NewConnectorChooser({
  onCancel,
  onChosen,
}: {
  onCancel: () => void;
  onChosen: (kind: NewConnectorKind) => void;
}) {
  const id = useId();
  const [choice, setChoice] = useState<NewConnectorKind>('remote');
  const [open, setOpen] = useState(true);
  // Set by Continue; read once, when the dialog has finished closing.
  const chosen = useRef<NewConnectorKind | null>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent
        onCloseAutoFocus={() => {
          const kind = chosen.current;
          chosen.current = null;
          if (kind !== null) setTimeout(() => onChosen(kind), 0);
        }}
      >
        <DialogHeader>
          <DialogTitle>New connector</DialogTitle>
          <DialogDescription>What are you adding? You’ll fill in the details next.</DialogDescription>
        </DialogHeader>
        <FieldSet>
          <FieldLegend className="sr-only">Kind of connector</FieldLegend>
          <RadioGroup value={choice} onValueChange={(v) => setChoice(v === 'general' ? 'general' : 'remote')}>
            {KINDS.map((k) => (
              <Field key={k.value} orientation="horizontal">
                <RadioGroupItem value={k.value} id={`${id}-${k.value}`} />
                <FieldContent>
                  <FieldLabel htmlFor={`${id}-${k.value}`}>{k.label}</FieldLabel>
                  <FieldDescription>{k.description}</FieldDescription>
                </FieldContent>
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="button" onClick={() => { chosen.current = choice; setOpen(false); }}>Continue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

Cancel, Escape, the close button and an outside click all call `onCancel`, and the parent unmounts the chooser. `chosen` is then null, so nothing opens, and the primitive returns focus to the opener as usual. Do not `preventDefault()` in `onCloseAutoFocus`. The restore after it is what puts focus back on the opener.

- [ ] **Step 5: Wire it into `ConnectorsTab.tsx`**

- Imports: `import { ConnectorEditDialog, type NewConnectorKind } from './ConnectorEditDialog';` (replaces `:63`) and `import { NewConnectorChooser } from './NewConnectorChooser';`.
- State, after `prefill` (`:140`): `const [choosing, setChoosing] = useState(false);` (comment: `"New connector" asks what kind first (TASK-1239): the chooser is open.`) and `const [newKind, setNewKind] = useState<NewConnectorKind>('remote');` (comment: `What the chooser picked: the blank editor a new connector opens.`).
- Both entry points become `() => setChoosing(true)`: the header button (`:304`, keep `data-return-focus="admin-connectors"`) and `ConnectorDirectory`'s `onNewConnector` (`:291-294`).
- Render the chooser just before `{editing !== null && (` (`:413`): `{choosing && <NewConnectorChooser onCancel={() => setChoosing(false)} onChosen={(kind) => { setChoosing(false); setPrefill(null); setNewKind(kind); setEditing('new'); }} />}`.
- On `ConnectorEditDialog`, beside the prefill spread: `{...(editing === 'new' && !prefill ? { kind: newKind } : {})}`.
- Header comment: add this paragraph after FIND IN DIRECTORY (`:28-36`):

```
 * NEW CONNECTOR (TASK-1239): "New connector" (here, and the directory's
 * by-hand buttons) first asks what kind (`NewConnectorChooser`). An MCP
 * server opens the remote-server form. Services, an API or a command-line
 * tool open the general editor blank, the only editor with the compose
 * paste. The editor opens once the chooser has closed, so it hands focus
 * back to the button that started it. "Set it up" skips the question: a
 * request or a listing already says what it is.
```

- [ ] **Step 6: Run the tests and see them pass, then prove the focus test bites**

Run: `pnpm --filter @ax/channel-web exec vitest run src/components/settings`
Expected: all PASS.
Mutation check (do not commit it): make Continue call `onChosen(choice)` directly, with no close and no timer. Run `ConnectorsTab.new-connector.test.tsx` again. Expected: `focus returns to New connector…` FAILS. Revert and re-run until it passes.

- [ ] **Step 7: Rule-5 stale line.** In `docs/plans/2026-10-01-remote-mcp-connector-modal.md`, add this after the paragraph ending at line 11:

```
> **Update 2026-11-27 (TASK-1239):** "New connector" now asks what kind first. "MCP server" opens this form. "Services, APIs or command-line tools" opens the general editor (`LegacyConnectorEditDialog`), which is where an admin pastes a compose file. The paragraph above describes what #833 shipped.
```

- [ ] **Step 8: Lint and type-check**

Run: `pnpm lint`, then `pnpm --filter @ax/channel-web build`.
Expected: no errors. No new suppression entries, so `eslint-suppressions.json` is unchanged. If lint reports unused suppressions, run `pnpm lint:ui:prune` and commit the result.

- [ ] **Step 9: Commit**

```bash
git add packages/channel-web/src/components/settings/NewConnectorChooser.tsx packages/channel-web/src/components/settings/ConnectorsTab.tsx packages/channel-web/src/components/settings/__tests__/ConnectorsTab.test.tsx packages/channel-web/src/components/settings/__tests__/ConnectorsTab.new-connector.test.tsx docs/plans/2026-10-01-remote-mcp-connector-modal.md
git commit -m "[TASK-1239] New connector asks what kind first: an MCP server, or services, APIs and command-line tools"
```

---

## Verification (whole branch)

```bash
pnpm --filter @ax/channel-web test
pnpm --filter @ax/channel-web build
pnpm lint
git fetch origin main && node scripts/ui-suppressions-ratchet.mjs origin/main
pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
```

The last line is the full gate from CLAUDE.md. `@ax/auth-better` needs an explicit `DOCKER_HOST`, and CI runs only the affected packages.

**Browser check, recommended.** It's the only check that sees the real 200 ms exit animation. Run `pnpm --filter @ax/channel-web dev` with `AX_BACKEND_URL` unset (the Vite mock backend) and open `/?admin=slack`, then click Connectors. (The mock doesn't serve `/api/chat/agents` or `/api/workspace/*`, so the chat shell errors; the admin route doesn't need them.) Tab to New connector, press Enter, arrow down to the second option, Tab to Continue and press Enter. The general editor opens with focus inside it. Press Escape, and focus is back on New connector. The mock has no pin route, so paste images that already carry `@sha256:` digests if you try a compose file there.

## YAGNI pass

Kept, each load-bearing for the card: the dispatcher's `kind` and the blank draft (Task 1), the chooser and its two entry points (Task 2), one Done-when test, one focus test, one re-render guard, one precedence guard, one directory test, and two rule-5 comment and doc fixes.

Cut:
- **Hiding "MCP server" from the general editor's "How it connects".** The request path already shows it, and its legacy MCP sub-form still saves correctly. Revisit only if a walk shows confusion.
- **Leading the general editor with Services.** Walk check 1 passed with today's order.
- **A Back button from an editor to the chooser.** Cancel, then New connector, is two clicks.
- **Carrying typed values between kinds.** The question comes before any field.
- **Server, route or hook changes.** Verified unnecessary (premise check).
- **A `pin-images` route in the dev mock.** Tests don't use it. A browser check can paste pinned images.
- **A standalone unit test for the chooser.** The tab-level tests drive it with a real opener and a real editor, which is where its behavior matters.
- **The "Each agent adds its own key" caption on a keyless services connector.** It was already there, and it's outside this card.

## Invariants, boundary review, security

1. **Hook surface:** no hook change.
2. **Cross-plugin imports:** none. All files are in channel-web, and the chooser imports a type from its own package.
3. **Half-wired:** the chooser is reachable from both "New connector" entry points, with tests. `kind` has its caller in the same PR.
4. **One source of truth:** it reuses the one general editor and `lib/connector-form`. No second compose form.
5. **Capabilities:** no new reach. Admins could already create services connectors (the API, and "Set it up" on a request). The admin-only route and its server-side validation still decide.
6. **One UI language:** composes installed shadcn primitives. The new file has zero suppressions.

**Boundary review:** not required. No service-hook, subscriber, route or IPC signature changes. `kind` is a React prop.

**`security-checklist`:** not required. This is an entry-point change inside channel-web. It adds no route, hook, IPC action, dependency or process/file/network capability, and no new path for untrusted content. The compose parse (`js-yaml` safe schema in `@ax/skills-parser`), the admin-only `POST /admin/connectors` and `pin-images`, and the server-side capability validation are all unchanged. The chooser renders fixed copy only.

## Rule 5: what let this gap through

The card is true. What hid the gap until the walk was the general editor's own header, `LegacyConnectorEditDialog.tsx:2-5`. It calls itself "the mechanism-first connector create/edit form … opened from Admin › Connectors", which since #833 is true only for edits and requests. The #833 doc's "New connectors are remote HTTPS MCP servers." (`docs/plans/2026-10-01-remote-mcp-connector-modal.md:11`) sat in a dated plan nobody re-read. The dev-services plan's Task 1.6 (ruling R3) checked which editor was live for edits, not whether a new connector could reach it. Task 1 fixes the header, and Task 2 adds the dated note. The design doc's `connector-form.ts:631` citation is pinned to `f952512ad`, so its line drift isn't misleading, and it stays.
