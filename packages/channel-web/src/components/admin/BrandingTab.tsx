/**
 * BrandingTab — admin-only surface to set the product name + logo.
 *
 * Reads the current config from `useBranding()` and writes via
 * `putBranding` (PUT /admin/branding). Logo files are read to base64 in the
 * browser; the server re-validates (allowlist + magic-byte sniff + size cap).
 * After a save we `refresh()` the provider so the header/title/favicon update
 * live.
 *
 * Layout mirrors ModelConfigTab: a header, the fields, a live preview, and a
 * save bar with the saving / ✓ Saved / error affordances.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useBranding } from '@/lib/branding-context';
import {
  putBranding,
  logoUrl,
  ALLOWED_LOGO_TYPES,
  type PutBrandingInput,
} from '@/lib/branding';

interface PendingLogo {
  contentType: string;
  dataBase64: string;
  /** data: URL — usable directly as an <img> src for the preview. */
  previewUrl: string;
  filename: string;
}

/** null = unchanged; 'clear' = remove on save; object = replace on save. */
type LogoChange = PendingLogo | 'clear' | null;

const ACCEPT = ALLOWED_LOGO_TYPES.join(',');

function statusText(change: LogoChange, hasCurrent: boolean): string {
  if (change !== null && change !== 'clear') return change.filename;
  if (change === 'clear') return 'Will be removed when you save';
  if (hasCurrent) return 'Current logo set';
  return 'No logo uploaded';
}

interface LogoFieldProps {
  label: string;
  hint?: string;
  testId: string;
  hasCurrent: boolean;
  change: LogoChange;
  onChoose: (file: File) => void;
  onRemove: () => void;
}

function LogoField({
  label,
  hint,
  testId,
  hasCurrent,
  change,
  onChoose,
  onRemove,
}: LogoFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const present =
    change !== null && change !== 'clear'
      ? true
      : change === 'clear'
        ? false
        : hasCurrent;
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {hint !== undefined && (
        <p className="text-[12px] text-muted-foreground">{hint}</p>
      )}
      <div className="flex items-center gap-2.5">
        <input
          ref={inputRef}
          data-testid={testId}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) onChoose(file);
            e.target.value = '';
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
        >
          {present ? 'Replace' : 'Choose file'}
        </Button>
        {present && (
          <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
            Remove
          </Button>
        )}
        <span className="text-[12.5px] text-muted-foreground truncate">
          {statusText(change, hasCurrent)}
        </span>
      </div>
    </div>
  );
}

// Fixed light/dark swatches for the preview — these are the *content* (we're
// showing how the logo reads on a light vs dark surface), not theme colors,
// so they intentionally don't track the active theme.
function PreviewTile({
  surface,
  src,
  invert,
  name,
  logoType,
}: {
  surface: 'light' | 'dark';
  src: string | null;
  invert: boolean;
  name: string;
  logoType: 'full' | 'icon';
}) {
  const display = name.length > 0 ? name : 'ax';
  const textClass = surface === 'light' ? 'text-zinc-900' : 'text-white';
  const imgStyle = invert
    ? { filter: 'invert(1) hue-rotate(180deg)' }
    : undefined;
  const word = (
    <span
      className={cn(
        'text-[19px] font-medium tracking-[-0.015em] leading-none',
        textClass,
      )}
    >
      {display}
    </span>
  );
  let mark: ReactNode;
  if (src === null) {
    mark = (
      <span className="flex items-center">
        <span
          aria-hidden="true"
          className="inline-block size-[5px] rounded-full bg-primary mr-2 -translate-y-[3px]"
        />
        {word}
      </span>
    );
  } else if (logoType === 'icon') {
    mark = (
      <span className="flex items-center">
        <img
          src={src}
          alt=""
          className="size-5 object-contain mr-2"
          style={imgStyle}
        />
        {word}
      </span>
    );
  } else {
    mark = (
      <img
        src={src}
        alt={display}
        className="h-[26px] object-contain"
        style={imgStyle}
      />
    );
  }
  return (
    <div
      className={cn(
        'flex items-center justify-center h-20 rounded-lg border border-border',
        surface === 'light' ? 'bg-white' : 'bg-zinc-900',
      )}
    >
      {mark}
    </div>
  );
}

export function BrandingTab() {
  const { branding, loaded, refresh } = useBranding();
  const [name, setName] = useState('');
  const [logoType, setLogoType] = useState<'full' | 'icon'>('full');
  const [light, setLight] = useState<LogoChange>(null);
  const [dark, setDark] = useState<LogoChange>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const initedRef = useRef(false);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (loaded && !initedRef.current) {
      initedRef.current = true;
      setName(branding.name);
      setLogoType(branding.logoType);
    }
  }, [loaded, branding]);

  useEffect(
    () => () => {
      if (savedTimeoutRef.current !== null) clearTimeout(savedTimeoutRef.current);
    },
    [],
  );

  const onChoose = (variant: 'light' | 'dark', file: File) => {
    if (!(ALLOWED_LOGO_TYPES as readonly string[]).includes(file.type)) {
      setFileError(
        `That file type isn't supported${file.type.length > 0 ? ` (${file.type})` : ''}. Use a PNG, WebP, JPEG, or SVG.`,
      );
      return;
    }
    setFileError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      const dataBase64 = comma >= 0 ? result.slice(comma + 1) : '';
      const pending: PendingLogo = {
        contentType: file.type,
        dataBase64,
        previewUrl: result,
        filename: file.name,
      };
      if (variant === 'light') setLight(pending);
      else setDark(pending);
    };
    reader.readAsDataURL(file);
  };

  const flashSaved = () => {
    setSavedOk(true);
    if (savedTimeoutRef.current !== null) clearTimeout(savedTimeoutRef.current);
    savedTimeoutRef.current = setTimeout(() => {
      setSavedOk(false);
      savedTimeoutRef.current = null;
    }, 2000);
  };

  const runSave = async (input: PutBrandingInput, after: () => void) => {
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      await putBranding(input);
      after();
      flashSaved();
      refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    const input: PutBrandingInput = { name, logoType };
    if (light !== null) {
      input.light =
        light === 'clear'
          ? null
          : { contentType: light.contentType, dataBase64: light.dataBase64 };
    }
    if (dark !== null) {
      input.dark =
        dark === 'clear'
          ? null
          : { contentType: dark.contentType, dataBase64: dark.dataBase64 };
    }
    void runSave(input, () => {
      setLight(null);
      setDark(null);
    });
  };

  const handleClear = () => {
    void runSave(
      { name: '', logoType: 'full', light: null, dark: null },
      () => {
        setName('');
        setLogoType('full');
        setLight(null);
        setDark(null);
        setFileError(null);
      },
    );
  };

  // Resolve the preview sources.
  const lightSrc =
    light === 'clear'
      ? null
      : light !== null
        ? light.previewUrl
        : loaded && branding.light
          ? logoUrl('light', branding.version)
          : null;
  const darkChosen =
    dark === 'clear'
      ? null
      : dark !== null
        ? dark.previewUrl
        : loaded && branding.dark
          ? logoUrl('dark', branding.version)
          : null;
  const darkSrc = darkChosen ?? lightSrc;
  const darkInvert = darkChosen === null && lightSrc !== null;

  return (
    <div className="max-w-[640px] mx-auto font-sans">
      <div className="mb-5">
        <h2 className="text-2xl font-medium tracking-[-0.018em] mb-1.5">
          Branding
        </h2>
        <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
          Set the product name and logo your team sees in the header, sign-in
          page, and browser tab. Reads are public so the login page shows your
          branding before anyone signs in.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="branding-name">Product name</Label>
          <Input
            id="branding-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ax"
            maxLength={200}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Logo style</Label>
          <ToggleGroup
            type="single"
            value={logoType}
            onValueChange={(v) => {
              if (v === 'full' || v === 'icon') setLogoType(v);
            }}
            className="justify-start"
            aria-label="Logo style"
          >
            <ToggleGroupItem value="full">
              Full logo (includes the name)
            </ToggleGroupItem>
            <ToggleGroupItem value="icon">
              Icon only (show the name beside it)
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        <LogoField
          label="Light logo"
          testId="light-logo-input"
          hasCurrent={loaded && branding.light}
          change={light}
          onChoose={(f) => onChoose('light', f)}
          onRemove={() => setLight('clear')}
        />

        <LogoField
          label="Dark logo"
          hint="Optional — leave empty and we'll auto-invert the light logo for dark mode."
          testId="dark-logo-input"
          hasCurrent={loaded && branding.dark}
          change={dark}
          onChoose={(f) => onChoose('dark', f)}
          onRemove={() => setDark('clear')}
        />

        {fileError !== null && (
          <div
            role="alert"
            className="px-2.5 py-1.5 bg-destructive-soft border border-destructive/25 rounded-md text-[12.5px] text-destructive"
          >
            {fileError}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label>Preview</Label>
          <div className="grid grid-cols-2 gap-3">
            <PreviewTile
              surface="light"
              src={lightSrc}
              invert={false}
              name={name}
              logoType={logoType}
            />
            <PreviewTile
              surface="dark"
              src={darkSrc}
              invert={darkInvert}
              name={name}
              logoType={logoType}
            />
          </div>
        </div>
      </div>

      <div className="mt-6 pt-4 border-t border-rule-soft flex items-center gap-3">
        <Button type="button" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : savedOk ? '✓ Saved' : 'Save changes'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleClear}
          disabled={saving}
        >
          Clear branding
        </Button>
        {savedOk && (
          <span className="text-[12.5px] text-muted-foreground">
            Saved — your branding is live.
          </span>
        )}
        {saveError !== null && (
          <div
            role="alert"
            className="px-2.5 py-1.5 bg-destructive-soft border border-destructive/25 rounded-md text-[12.5px] text-destructive"
          >
            {saveError}
          </div>
        )}
      </div>
    </div>
  );
}
