# Mock backend — for development only

The `mock/` directory in this package is **dev plumbing**. It exists to let the chat UI work end-to-end before `@ax/auth`, `@ax/http-server`, `@ax/agents`, and `@ax/conversations` ship in Week 9.5 / Week 10–12.

Things this mock is NOT:

- **Not authenticated.** The `mock-session` cookie isn't HttpOnly, isn't signed, and accepts any value the server has previously issued. There is no CSRF protection.
- **Not encrypted.** Passwords aren't a concept here, but if you add data to `.mock-data/`, it's stored as plaintext JSON.
- **Not concurrency-safe** beyond a single Vite dev process. There's no locking, no transactions, no isolation across replicas.
- **Not validated.** Request bodies are cast to expected shapes without schema enforcement. Sending malformed JSON gets you `{}` and a shrug.

Things this mock IS:

- A wire-shape commitment. The endpoints under `/api/*` and `/api/admin/*` define the contract that `@ax/http-server` will honor when it ships. If you change the routes here, change them in the plan first.
- A way to develop the UI in isolation. No backend dependency, no Postgres, no k8s.
- Disposable. The `mock/` directory is deleted in Week 10–12 along with the `configureServer` plugin in `vite.config.ts`. The React tree survives.

## Don't

- Don't deploy this. The Vite dev server isn't a production server, and the mock backend isn't a real backend.
- Don't store secrets in `.mock-data/`. Treat the JSON files as fixtures.
- Don't bypass the mock and call into `mock/` from `src/`. The boundary is `/api/*` HTTP — keep it that way so the real-backend swap is mechanical.

When in doubt, ask. We've all been there.
