# TASK-458 — make the pgvector bootstrap prove itself

## The question the card asked first

**Does `bitnamilegacy/postgresql:17.6.0-debian-12-r4` ship pgvector?** Yes.
`MEASURED-BY-PROBE` 2026-09-26 against digest
`sha256:926356130b77d5742d8ce605b258d35db9b62f2f8fd1601f9dbaef0c8a710a8d`:

- `/opt/bitnami/postgresql/share/extension/` has `vector.control` and `vector--0.8.0.sql`.
- On a running container, `CREATE EXTENSION IF NOT EXISTS vector;` succeeds, `pg_extension`
  reports `extversion = 0.8.0`, and `'[1,2,3]'::vector <-> '[1,2,4]'::vector` returns `1`.
- `psql -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS nosuchext;"` exits 1, so a
  missing extension *is* observable to the Job once the `||` stops eating it.

So the embedded deployment has a dense channel available. The decision is **required, fail
loudly** — not "optional with a flag": nothing in the default image needs an escape hatch, and an
opt-out value would be a knob with no user.

## Tasks

1. **Chart test first** (`deploy/charts/ax-next/__tests__/pgvector-bootstrap.test.ts`).
   - Render (helm-gated): the Job renders by default, not in external mode; its image is exactly
     `postgresql.image.*`; its script runs under `set -euo pipefail`, carries no `||`, runs
     `CREATE EXTENSION` with `ON_ERROR_STOP=1`, and verifies `pg_extension` afterwards.
   - Behaviour (helm + Docker gated): run the *rendered* script, in the chart's image, against
     (a) a server from the chart's image — must exit 0 and leave `vector` installed; and (b) a
     server with no pgvector (`postgres:16-alpine`) — must exit non-zero. (b) is the
     anti-swallow proof: the old script exits 0 there.
2. **Fix the template**: drop the `||`, fail with a message naming the image, verify the
   extension row exists.
3. **Wire CI**: the `helm-render` lane is the only one with helm *and* Docker, so it gets
   `DOCKER_HOST` + `AX_REQUIRE_DOCKER=1` (a missing daemon fails, never skips).
4. **Docs**: template comment, values.yaml image comment, MANUAL-ACCEPTANCE step, and a
   resolution note on the spike §4 / handoff §3.3 lines that generated the card.

YAGNI: no opt-out value (no user); no testcontainers dependency in `@ax/chart-tests` (it would
force a workspace build into the helm-render lane for one test — the Docker CLI, bound to an
explicit `DOCKER_HOST`, is enough).
