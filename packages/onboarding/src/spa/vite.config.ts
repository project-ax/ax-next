import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: __dirname, // src/spa/
  build: {
    outDir: resolve(__dirname, '../../dist-spa'),
    emptyOutDir: true,
    // Fix asset paths to /setup/static/* so the static-route handler
    // serves them under the same scope as the SPA itself.
    assetsDir: 'static',
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
  },
  base: '/setup/', // critical: rewrites <script src=> and <link href= to /setup/static/...
});
