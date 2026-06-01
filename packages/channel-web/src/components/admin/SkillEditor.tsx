import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Check, ChevronsUpDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
// `@ax/skills/manifest` is a pure-function SKILL.md (de)serializer (yaml + shape
// validation) exported via a subpath so the heavy bits of @ax/skills (kysely db,
// http routes, node:crypto via @ax/core) stay out of the browser bundle. The
// parser/build pair IS the single round-trip authority (TASK-133): the form
// edits typed fields; toggling to raw serializes them; toggling back re-parses.
// Disable applies to THIS LINE ONLY; component-level eslint posture is unchanged.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import {
  parseSkillManifest,
  buildSkillManifestYaml,
  splitSkillMd,
} from '@ax/skills/manifest';
import { getSkill, upsertSkill, updateSkill } from '@/lib/skills';
import { listConnectors } from '@/lib/connectors';
import type { BundleFile, SkillDetail } from '@ax/skills';

/** Minimal API surface the editor needs — injectable for user vs admin routes. */
export interface SkillEditorApi {
  getSkill: (skillId: string) => Promise<SkillDetail>;
  upsertSkill: (
    skillMd: string,
    opts?: { defaultAttached?: boolean; files?: BundleFile[] },
  ) => Promise<{ skillId: string; created: boolean }>;
  updateSkill: (
    skillId: string,
    skillMd: string,
    opts?: { defaultAttached?: boolean; files?: BundleFile[] },
  ) => Promise<{ skillId: string; created: boolean }>;
}

// Client-side bundle-file path hints — a UX mirror of the server's
// validateBundleFiles rules (path-safety + reserved-name veto). The SERVER
// stays the source of truth; this only gives instant feedback and gates the
// Save button so we don't round-trip an obviously-bad path. Keep these in sync
// with `bundle-files.ts` in @ax/skills — the reserved set is matched EXACTLY
// (case-sensitive) just like the server's `RESERVED_NAMES`, so a legitimate
// lowercase `skill.md` extra file (which the server permits — only the exact
// uppercase `SKILL.md`, the generated manifest file, is reserved) isn't blocked.
const BUNDLE_PATH_RE = /^[a-z0-9._-]+(\/[a-z0-9._-]+)*$/;
const RESERVED_BUNDLE_NAMES = ['SKILL.md', '.mcp.json', '.claude', '.git'];

/**
 * Returns a human hint string when `path` is invalid for a bundle file, or
 * null when it's acceptable. Mirrors `validateBundleFiles` exactly so the
 * client never blocks a path the server would accept (nor accepts one it would
 * reject for the rules a flat string can check; bytes/total-size/collision
 * checks remain server-only and surface as a 400 on save).
 */
function bundlePathHint(path: string): string | null {
  const p = path.trim();
  if (p.length === 0) return 'Path is required.';
  if (p.length > 256) return 'Path is too long (max 256 chars).';
  if (p.startsWith('/')) return 'Path must be relative (no leading "/").';
  if (p.includes('..')) return 'Path may not contain "..".';
  if (p.split('/').some((seg) => seg === '.' || seg === '..')) {
    return 'Path may not contain "." or ".." segments.';
  }
  if (!BUNDLE_PATH_RE.test(p)) {
    return 'Use lowercase letters, digits, dot, dash, underscore, and "/" only.';
  }
  // Case-sensitive, matching the server's exact-name veto.
  if (RESERVED_BUNDLE_NAMES.some((r) => p === r || p.startsWith(r + '/'))) {
    return 'Reserved path (SKILL.md / .mcp.json / .claude / .git are generated).';
  }
  return null;
}

const defaultApi: SkillEditorApi = { getSkill, upsertSkill, updateSkill };

/** The structured form state — the single source of truth the editor edits. */
interface SkillFormState {
  name: string;
  description: string;
  /** Connector-id references → manifest `connectors: []`. */
  connectors: string[];
  /** The SKILL.md body (markdown after the frontmatter fence). */
  body: string;
  /**
   * Server-managed version + any unknown frontmatter keys the form doesn't
   * surface. Carried through so the form ⇄ raw round-trip preserves them
   * (TASK-133). `sourceUrl`, when present, is folded in here too.
   */
  version: number;
  extra: Record<string, unknown>;
}

const EMPTY_FORM: SkillFormState = {
  name: '',
  description: '',
  connectors: [],
  body: '\n# Body\n\nMarkdown body. This becomes the SKILL.md the SDK indexes.\n',
  version: 0,
  extra: {},
};

/**
 * Fold a parsed manifest into the editor's structured form state. `sourceUrl`
 * (a modeled parse field) is tucked back into `extra` so a later
 * `buildSkillManifestYaml({ ...extra })` re-emits it — the form has no control
 * for it, but it must survive the round-trip.
 */
function formFromParsed(
  parsed: { id: string; description: string; version: number; connectors: string[]; sourceUrl?: string; extra: Record<string, unknown> },
  body: string,
): SkillFormState {
  const extra: Record<string, unknown> = { ...parsed.extra };
  if (parsed.sourceUrl !== undefined) extra.sourceUrl = parsed.sourceUrl;
  return {
    name: parsed.id,
    description: parsed.description,
    connectors: parsed.connectors,
    body,
    version: parsed.version,
    extra,
  };
}

/** Serialize the structured form state into a full SKILL.md string. */
function assembleSkillMd(form: SkillFormState): string {
  const manifestYaml = buildSkillManifestYaml({
    id: form.name,
    description: form.description,
    version: form.version,
    connectors: form.connectors,
    extra: form.extra,
  });
  return (
    '---\n' +
    manifestYaml +
    (manifestYaml.endsWith('\n') ? '' : '\n') +
    '---\n' +
    form.body
  );
}

interface Props {
  skillId?: string;
  onSaved: () => void;
  onCancel: () => void;
  /** Override the API client (defaults to admin `/admin/skills*` functions). */
  api?: SkillEditorApi;
}

export function SkillEditor({ skillId, onSaved, onCancel, api = defaultApi }: Props) {
  const [form, setForm] = useState<SkillFormState>(EMPTY_FORM);
  const [files, setFiles] = useState<BundleFile[]>([]);
  const [loading, setLoading] = useState<boolean>(skillId !== undefined);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [defaultAttached, setDefaultAttached] = useState<boolean>(false);

  // Advanced raw-markdown escape hatch. `advanced` toggles the raw textarea;
  // `rawText` is its buffer (authoritative only while advanced is on).
  const [advanced, setAdvanced] = useState(false);
  const [rawText, setRawText] = useState('');

  // Owned-connector suggestions for the multi-select. A soft surface: a load
  // failure (or zero connectors) must NOT block authoring — the field still
  // accepts free-entry of arbitrary connector-id slugs.
  const [connectorOptions, setConnectorOptions] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    listConnectors()
      .then((cs) => {
        if (!cancelled) setConnectorOptions(cs.map((c) => c.id));
      })
      .catch(() => {
        if (!cancelled) setConnectorOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Reset loading + serverError on every skillId change so the editor
    // doesn't show stale content (or a stale error) while the new skill's
    // fetch is in flight. Without this, an editor that was just open on
    // skill A can briefly be saved as skill B before A's bytes are replaced.
    setServerError(null);
    setAdvanced(false);
    setLoading(skillId !== undefined);
    if (skillId === undefined) {
      setForm(EMPTY_FORM);
      setFiles([]);
      setDefaultAttached(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const detail = await api.getSkill(skillId);
        if (cancelled) return;
        const parsed = parseSkillManifest(detail.manifestYaml);
        if (parsed.ok) {
          setForm(formFromParsed(parsed.value, detail.bodyMd));
        } else {
          // The stored manifest doesn't parse (shouldn't happen — the server
          // validated it on write — but be defensive): open straight into the
          // raw editor so the author can fix it, seeded from the stored bytes.
          setForm({ ...EMPTY_FORM, body: detail.bodyMd });
          setRawText(
            '---\n' +
              detail.manifestYaml +
              (detail.manifestYaml.endsWith('\n') ? '' : '\n') +
              '---\n' +
              detail.bodyMd,
          );
          setAdvanced(true);
        }
        // The editor OWNS the full file set it displays: on save it round-trips
        // exactly these files (a body-only edit therefore preserves them rather
        // than wiping the bundle, and a removed file is actually removed).
        setFiles(detail.files.map((f) => ({ path: f.path, contents: f.contents })));
        setDefaultAttached(detail.defaultAttached);
      } catch (err) {
        if (cancelled) return;
        setServerError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `api` is an object reference and is correctly listed as a dep below;
    // callers are expected to pass a stable (module-level) constant so this
    // effect doesn't re-run every render (the admin default and the user
    // panel's `userSkillsApi` are both module-level constants).
  }, [skillId, api]);

  // ── Live parse of whatever surface is active ─────────────────────────────
  // In form mode we assemble + parse the form; in raw mode we split + parse the
  // raw text. The parser is the single authority for both, so the validity gate
  // (and the Save payload) are computed the same way.
  const activeSkillMd = advanced ? rawText : assembleSkillMd(form);

  const parsedResult = useMemo(() => {
    const split = splitSkillMd(activeSkillMd);
    if (split === null) {
      return {
        ok: false as const,
        code: 'no-fence' as const,
        message: 'Missing frontmatter fence (--- yaml ---)',
      };
    }
    return parseSkillManifest(split.manifestYaml);
  }, [activeSkillMd]);

  // TASK-100 — a skill manifest declares no capabilities (its reach is the
  // connectors it references), so a skill is always instruction-only and can
  // always be default-attached once it parses.
  const canBeDefault = parsedResult.ok;

  // ── Connector multi-select helpers ───────────────────────────────────────
  const [connectorPickerOpen, setConnectorPickerOpen] = useState(false);
  const [connectorQuery, setConnectorQuery] = useState('');

  const addConnector = (id: string) => {
    const slug = id.trim();
    if (slug.length === 0) return;
    setForm((f) =>
      f.connectors.includes(slug) ? f : { ...f, connectors: [...f.connectors, slug] },
    );
    setConnectorQuery('');
  };
  const removeConnector = (id: string) =>
    setForm((f) => ({ ...f, connectors: f.connectors.filter((c) => c !== id) }));

  // Suggestions = owned connectors not already selected, filtered by the query.
  const connectorSuggestions = useMemo(() => {
    const q = connectorQuery.trim().toLowerCase();
    return connectorOptions
      .filter((id) => !form.connectors.includes(id))
      .filter((id) => q.length === 0 || id.toLowerCase().includes(q));
  }, [connectorOptions, form.connectors, connectorQuery]);

  // ── Bundle-file list helpers ─────────────────────────────────────────────
  const addFile = () => setFiles((prev) => [...prev, { path: '', contents: '' }]);
  const setFilePath = (idx: number, path: string) =>
    setFiles((prev) => prev.map((f, i) => (i === idx ? { ...f, path } : f)));
  const setFileContents = (idx: number, contents: string) =>
    setFiles((prev) => prev.map((f, i) => (i === idx ? { ...f, contents } : f)));
  const removeFile = (idx: number) =>
    setFiles((prev) => prev.filter((_, i) => i !== idx));

  // Per-file hint: invalid path OR a duplicate of an earlier file's path. A
  // duplicate is flagged on the LATER occurrence so the first stays "valid".
  const fileHints = useMemo(() => {
    const seen = new Set<string>();
    return files.map((f) => {
      const hint = bundlePathHint(f.path);
      if (hint !== null) return hint;
      const key = f.path.trim();
      if (seen.has(key)) return 'Duplicate path.';
      seen.add(key);
      return null;
    });
  }, [files]);
  const filesInvalid = fileHints.some((h) => h !== null);

  // ── Advanced toggle: form ⇄ raw, parser-mediated ─────────────────────────
  function enterAdvanced() {
    // Seed the raw buffer from the current form state.
    setRawText(assembleSkillMd(form));
    setAdvanced(true);
  }
  function exitAdvanced() {
    // Return to the form ONLY if the raw text parses — otherwise the form
    // fields can't be reconstructed, so stay in raw and surface the error.
    const split = splitSkillMd(rawText);
    if (split === null) return; // parsedResult already shows the no-fence error
    const parsed = parseSkillManifest(split.manifestYaml);
    if (!parsed.ok) return; // parsedResult already shows the manifest error
    setForm(formFromParsed(parsed.value, split.bodyMd));
    setAdvanced(false);
  }
  function toggleAdvanced(next: boolean) {
    if (next) enterAdvanced();
    else exitAdvanced();
  }

  async function handleSave() {
    setSaving(true);
    setServerError(null);
    // Always send the displayed file set (WYSIWYG): the server replaces the
    // bundle with exactly these files. Trim paths to match what the user sees.
    const filesPayload: BundleFile[] = files.map((f) => ({
      path: f.path.trim(),
      contents: f.contents,
    }));
    // Save from whichever surface is active. Both flow through the same parser
    // on the server, which re-validates the manifest + the bundle.
    const skillMd = activeSkillMd;
    try {
      if (skillId === undefined) {
        await api.upsertSkill(skillMd, { defaultAttached, files: filesPayload });
      } else {
        await api.updateSkill(skillId, skillMd, {
          defaultAttached,
          files: filesPayload,
        });
      }
      onSaved();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const liveError = !parsedResult.ok
    ? `${'code' in parsedResult ? parsedResult.code : ''}: ${parsedResult.message}`
    : null;

  const saveLabel = saving ? 'Saving…' : skillId === undefined ? 'Install' : 'Update';

  return (
    <div className="flex flex-col gap-4 max-h-[72vh] overflow-y-auto pr-1">
      {/* Advanced toggle — demotes the raw SKILL.md editor to an opt-in escape
          hatch (TASK-133). Form is the default surface. */}
      <div className="flex items-start gap-2">
        <Checkbox
          id="advanced-raw"
          checked={advanced}
          onCheckedChange={(v) => toggleAdvanced(v === true)}
        />
        <div className="space-y-0.5 leading-none">
          <label htmlFor="advanced-raw" className="text-sm font-medium">
            Advanced — edit raw <code className="font-mono text-xs">SKILL.md</code>
          </label>
          <p className="text-xs text-muted-foreground">
            Edit the underlying file directly. Changes stay in sync with the form.
          </p>
        </div>
      </div>

      {advanced ? (
        <RawEditor
          value={rawText}
          onChange={setRawText}
          parsed={parsedResult}
        />
      ) : (
        <FormFields
          form={form}
          setForm={setForm}
          connectorPickerOpen={connectorPickerOpen}
          setConnectorPickerOpen={setConnectorPickerOpen}
          connectorQuery={connectorQuery}
          setConnectorQuery={setConnectorQuery}
          connectorSuggestions={connectorSuggestions}
          addConnector={addConnector}
          removeConnector={removeConnector}
          liveError={liveError}
        />
      )}

      <div className="flex items-start gap-2">
        <Checkbox
          id="default-attached"
          checked={defaultAttached}
          disabled={!canBeDefault}
          onCheckedChange={(v) => setDefaultAttached(v === true)}
        />
        <div className="space-y-1 leading-none">
          <label htmlFor="default-attached" className="text-sm font-medium">
            Available to all my agents by default
          </label>
          <p className="text-xs text-muted-foreground">
            Adds this skill to every agent at session start, without per-agent
            setup.
          </p>
        </div>
      </div>

      <Separator />

      {/* Additional files — the extra (non-SKILL.md) files shipped alongside the
          manifest. Contents render in text-only controls (Input/Textarea);
          never via dangerouslySetInnerHTML. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <Label className="text-xs font-medium text-muted-foreground">
              Additional files
            </Label>
            <p className="text-xs text-muted-foreground">
              Extra files packaged with this skill (scripts, references). The
              skill instructions are authored above. Up to 16 files, 512 KiB total.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addFile}
            disabled={files.length >= 16}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add file
          </Button>
        </div>

        {files.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No extra files. This is a single-file (SKILL.md-only) skill.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {files.map((f, idx) => {
              const hint = fileHints[idx];
              return (
                <div
                  key={idx}
                  className="rounded-md border border-border p-3 flex flex-col gap-2 bg-muted/30"
                >
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label={`Bundle file path ${idx + 1}`}
                      className="h-8 text-xs font-mono"
                      placeholder="scripts/run.py"
                      value={f.path}
                      aria-invalid={hint !== null}
                      onChange={(e) => setFilePath(idx, e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeFile(idx)}
                      aria-label={`Remove bundle file ${f.path || idx + 1}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {hint !== null && (
                    <p className="text-xs text-destructive">{hint}</p>
                  )}
                  <Textarea
                    aria-label={`Bundle file contents ${idx + 1}`}
                    className="font-mono text-xs min-h-[120px]"
                    placeholder="File contents…"
                    value={f.contents}
                    onChange={(e) => setFileContents(idx, e.target.value)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {serverError && (
        <Alert variant="destructive">
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          onClick={() => void handleSave()}
          disabled={saving || liveError !== null || filesInvalid}
        >
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

// ── Form fields surface ────────────────────────────────────────────────────

interface FormFieldsProps {
  form: SkillFormState;
  setForm: React.Dispatch<React.SetStateAction<SkillFormState>>;
  connectorPickerOpen: boolean;
  setConnectorPickerOpen: (open: boolean) => void;
  connectorQuery: string;
  setConnectorQuery: (q: string) => void;
  connectorSuggestions: string[];
  addConnector: (id: string) => void;
  removeConnector: (id: string) => void;
  liveError: string | null;
}

function FormFields({
  form,
  setForm,
  connectorPickerOpen,
  setConnectorPickerOpen,
  connectorQuery,
  setConnectorQuery,
  connectorSuggestions,
  addConnector,
  removeConnector,
  liveError,
}: FormFieldsProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="skill-name" className="text-xs font-medium text-muted-foreground">
          Name
        </Label>
        <Input
          id="skill-name"
          className="font-mono text-sm"
          placeholder="my-skill"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
        <p className="text-xs text-muted-foreground">
          Lowercase slug — becomes the skill id. Letters, digits, and dashes.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor="skill-description"
          className="text-xs font-medium text-muted-foreground"
        >
          Description
        </Label>
        <Input
          id="skill-description"
          className="text-sm"
          placeholder="Short description of what this skill does."
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        />
        <p className="text-xs text-muted-foreground">
          One line (≤240 chars). The model reads this to decide when to use the skill.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-medium text-muted-foreground">Connectors</Label>
        <div className="flex flex-wrap items-center gap-1.5">
          {form.connectors.map((c) => (
            <Badge key={c} variant="secondary" className="text-xs gap-1 pr-1">
              {c}
              <button
                type="button"
                aria-label={`Remove connector ${c}`}
                className="rounded-sm opacity-70 hover:opacity-100"
                onClick={() => removeConnector(c)}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          <Popover open={connectorPickerOpen} onOpenChange={setConnectorPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                role="combobox"
                aria-expanded={connectorPickerOpen}
                aria-label="Add a connector"
                className="h-7 text-xs"
              >
                <Plus className="h-3 w-3 mr-1" />
                Add connector
                <ChevronsUpDown className="ml-1 h-3 w-3 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="p-0 w-[260px]" align="start">
              <Command shouldFilter={false}>
                <CommandInput
                  placeholder="Search or type a connector id…"
                  value={connectorQuery}
                  onValueChange={setConnectorQuery}
                />
                <CommandList>
                  <CommandEmpty>
                    {connectorQuery.trim().length > 0 ? (
                      <button
                        type="button"
                        className="w-full px-2 py-1.5 text-left text-xs hover:bg-accent rounded-sm"
                        onClick={() => {
                          addConnector(connectorQuery);
                          setConnectorPickerOpen(false);
                        }}
                      >
                        Add “{connectorQuery.trim()}”
                      </button>
                    ) : (
                      'No connectors found.'
                    )}
                  </CommandEmpty>
                  {connectorSuggestions.length > 0 && (
                    <CommandGroup heading="Your connectors">
                      {connectorSuggestions.map((id) => (
                        <CommandItem
                          key={id}
                          value={id}
                          onSelect={() => {
                            addConnector(id);
                            setConnectorPickerOpen(false);
                          }}
                          className="text-xs font-mono"
                        >
                          <span className="flex-1">{id}</span>
                          <Check
                            className={cn(
                              'h-3.5 w-3.5 text-primary',
                              form.connectors.includes(id) ? 'opacity-100' : 'opacity-0',
                            )}
                          />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {connectorQuery.trim().length > 0 &&
                    !connectorSuggestions.includes(connectorQuery.trim()) &&
                    !form.connectors.includes(connectorQuery.trim()) && (
                      <CommandGroup heading="Custom">
                        <CommandItem
                          value={`__add__${connectorQuery}`}
                          onSelect={() => {
                            addConnector(connectorQuery);
                            setConnectorPickerOpen(false);
                          }}
                          className="text-xs"
                        >
                          Add “{connectorQuery.trim()}”
                        </CommandItem>
                      </CommandGroup>
                    )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
        <p className="text-xs text-muted-foreground">
          Connectors this skill uses. Capabilities (hosts, keys) live on the
          connector — this is just a reference.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor="skill-instructions"
          className="text-xs font-medium text-muted-foreground"
        >
          Instructions
        </Label>
        <Textarea
          id="skill-instructions"
          className="font-mono text-xs min-h-[240px]"
          placeholder="Markdown instructions. This becomes the SKILL.md body the SDK indexes."
          value={form.body}
          onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
        />
      </div>

      {liveError !== null && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{liveError}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ── Raw editor surface (the opt-in escape hatch) ────────────────────────────

interface RawEditorProps {
  value: string;
  onChange: (v: string) => void;
  parsed:
    | { ok: true; value: { id: string; description: string; connectors: string[] } }
    | { ok: false; code: string; message: string };
}

function RawEditor({ value, onChange, parsed }: RawEditorProps) {
  const liveError = !parsed.ok ? `${parsed.code}: ${parsed.message}` : null;
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">SKILL.md</label>
        <Textarea
          aria-label="Raw SKILL.md"
          className="font-mono text-xs min-h-[400px]"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium text-muted-foreground">Parsed preview</label>
        {parsed.ok ? (
          <div className="rounded-md border border-border p-3 flex flex-col gap-3 bg-muted/30">
            <div>
              <div className="text-xs text-muted-foreground">Name</div>
              <div className="text-sm font-mono">{parsed.value.id}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Description</div>
              <div className="text-sm">{parsed.value.description}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Connectors</div>
              {parsed.value.connectors.length === 0 ? (
                <span className="text-xs text-muted-foreground">none</span>
              ) : (
                parsed.value.connectors.map((c) => (
                  <Badge key={c} variant="secondary" className="text-xs mr-1">
                    {c}
                  </Badge>
                ))
              )}
            </div>
          </div>
        ) : (
          <Alert variant="destructive">
            <AlertDescription className="text-xs">{liveError}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
