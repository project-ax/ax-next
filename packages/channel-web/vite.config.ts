import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'channel-web-mock-api',
      configureServer(server) {
        // Lazy import — keeps mock code out of production bundles. Vite only
        // loads this plugin in dev/preview, but the import itself is also
        // dynamic for belt-and-suspenders safety.
        import('./mock/server').then(({ mockMiddleware }) => {
          server.middlewares.use(mockMiddleware(resolve(process.cwd(), '.mock-data')));
        });
      },
    },
  ],
  server: { port: 5173 },
});
