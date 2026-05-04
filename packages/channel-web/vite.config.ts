import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { mockMiddleware } from './mock/server';

// Two dev modes, picked by env:
//
//   AX_BACKEND_URL unset       — Vite mock backend (`mock/server.ts`).
//                                Mocks /admin/me, /auth/sign-in/google,
//                                /auth/mock/google-callback, etc. No real
//                                Google login; clicking the CTA simulates
//                                a successful sign-in as user u2.
//
//   AX_BACKEND_URL=http://...  — Proxy /auth/* and /admin/* to a real
//                                ax-next serve. Real Google OAuth, real
//                                cookies. Browser still sees :5173 so
//                                cookies stay same-origin.
//
// Use the proxy mode once you've got Google OAuth creds in place; use
// the mock for offline UI work.
const backendUrl = process.env.AX_BACKEND_URL;

export default defineConfig({
  // SPA bundle goes to `dist-web/` so it's isolated from the TypeScript
  // server-side output that lands in `dist/`. The agent image's static-files
  // plugin serves only `dist-web/` — pointing it at `dist/` would also expose
  // `dist/src/server/...` (compiled TS, including source maps) to anyone
  // who can hit /. Both directories ship via the package's `files` field.
  build: {
    outDir: 'dist-web',
  },
  plugins: [
    react(),
    ...(backendUrl
      ? []
      : [
          {
            name: 'channel-web-mock-api',
            configureServer(server: { middlewares: { use: (mw: unknown) => void } }) {
              server.middlewares.use(
                mockMiddleware(resolve(process.cwd(), '.mock-data')) as never,
              );
            },
          },
        ]),
  ],
  server: {
    port: 5173,
    ...(backendUrl
      ? {
          proxy: {
            '/auth': { target: backendUrl, changeOrigin: false, ws: false },
            '/admin': { target: backendUrl, changeOrigin: false, ws: false },
            '/api': { target: backendUrl, changeOrigin: false, ws: false },
          },
        }
      : {}),
  },
});
