declare module '*.css';

/**
 * Vite injects `import.meta.env` at build/runtime. The repo's tsconfig
 * pins `"types": ["node"]`, so `vite/client` isn't pulled in implicitly —
 * we declare the slice we actually use here. Add fields as the need
 * arises; keep narrow so we don't shadow real Node `import.meta` types.
 */
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
