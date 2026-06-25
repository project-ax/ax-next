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
import { DEFAULT_BRANDING, fetchBranding, type Branding } from './branding';

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
