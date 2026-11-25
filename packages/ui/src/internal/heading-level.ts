import { createContext } from 'react';

// Internal: section-like components provide the next level; Heading reads it (default 2). Not exported from index.ts.
export const HeadingLevelContext = createContext<number>(2);
