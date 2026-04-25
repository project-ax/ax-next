import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { mockMiddleware } from './mock/server';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'channel-web-mock-api',
      configureServer(server) {
        server.middlewares.use(mockMiddleware(resolve(process.cwd(), '.mock-data')));
      },
    },
  ],
  server: { port: 5173 },
});
