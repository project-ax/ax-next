/**
 * BrandingProvider — fetches the public branding config once at app load and
 * exposes it via `useBranding()`. Wraps the whole app (including the pre-auth
 * login page + setup wizard) so the header/title/favicon reflect the operator's
 * branding everywhere.
 *
 * Branding is cosmetic and public: on any fetch failure we fall back to the
 * default ("ax", no logo) and still mark `loaded`, so the UI never hangs on a
 * blank header waiting for a config that may not exist yet.
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_BRANDING,
  fetchBranding,
  logoUrl,
  type Branding,
} from './branding';
import { applyFaviconFromImage, resetFaviconToDefault } from './favicon';
import { useResolvedTheme } from './theme';

export interface BrandingContextValue {
  branding: Branding;
  /** False until the first fetch settles (success OR fallback). */
  loaded: boolean;
  /** Re-fetch — used by the admin Branding tab after a save. */
  refresh: () => void;
}

const BrandingContext = createContext<BrandingContextValue>({
  branding: DEFAULT_BRANDING,
  loaded: false,
  refresh: () => {},
});

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const [loaded, setLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const resolved = useResolvedTheme();

  // Tab title + favicon track the branding (and the resolved theme, so the
  // favicon reflects the dark/inverted logo). Title is always set; the favicon
  // is generated from the current-variant logo when one exists, else reset to
  // the browser default.
  useEffect(() => {
    document.title = branding.name.length > 0 ? branding.name : 'ax';
    if (!loaded || !branding.light) {
      resetFaviconToDefault();
      return;
    }
    const dark = resolved === 'dark';
    const variant: 'light' | 'dark' = dark && branding.dark ? 'dark' : 'light';
    const invert = dark && !branding.dark;
    const image = new Image();
    let cancelled = false;
    image.onload = () => {
      if (!cancelled) applyFaviconFromImage(image, { invert });
    };
    image.src = logoUrl(variant, branding.version);
    return () => {
      cancelled = true;
    };
  }, [branding, loaded, resolved]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchBranding();
        if (!cancelled) {
          setBranding(next);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setBranding(DEFAULT_BRANDING);
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const value: BrandingContextValue = {
    branding,
    loaded,
    refresh: () => setReloadKey((k) => k + 1),
  };
  return (
    <BrandingContext.Provider value={value}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding(): BrandingContextValue {
  return useContext(BrandingContext);
}
