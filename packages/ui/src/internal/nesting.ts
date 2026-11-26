import { createContext, useContext, useEffect, useRef } from 'react';

// One boolean context per surface kind. Card-in-Card and InsetBlock-in-InsetBlock still render (a crash would be worse
// than a double border) but say so once per mount in development.
export const CardContext = createContext(false);
export const InsetContext = createContext(false);

// Dev-only, SSR-safe (effects never run on the server). The ref keeps StrictMode's double-invoked effect to one report.
export function useNestingGuard(context: typeof CardContext, message: string): void {
  const nested = useContext(context);
  const reported = useRef(false);
  useEffect(() => {
    if (!nested || reported.current || process.env.NODE_ENV === 'production') return;
    reported.current = true;
    console.error(message);
  }, [nested, message]);
}
