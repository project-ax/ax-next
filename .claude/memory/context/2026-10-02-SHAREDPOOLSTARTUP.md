# Shared-pool first-message latency

- Production revision 32 acquired ten warm sandboxes in 1.1–1.7 seconds. The
  latest Claude session `req-67d99bf9f265` acquired its sandbox in 1.03 seconds,
  recorded its SDK user message at +6.045 seconds, first SDK assistant record at
  +9.604 seconds, and stored the assistant turn at +10.978 seconds. These are
  server/transcript timings, not browser first-token measurements. The first
  provider tunnel (+4.951 seconds) can be an auxiliary SDK request.
- `Getting set up…` in production stays until content because only
  `sandbox-starting` is emitted. Candidate emits `sandbox-ready` after successful
  provisioning and extends the phase buffer allowlist so late SSE clients also
  switch to Thinking. Phase values remain backend-agnostic; no IPC action added.
- Candidate standby startup copies the baked Python template at fixed
  `/ephemeral` before reading an assignment. Offline-only mode cannot spawn uv or
  access a proxy; ordinary startup retains the existing bounded fallback. Copies
  are staged and atomically renamed so copy failures cannot leave a ready marker.
- GKE gVisor component probe of the compiled candidate helper in isolated scratch:
  offline preparation 1370.67 ms, ready venv reuse 0.198 ms, Python imported pip
  successfully. Scratch removed; no assignment or tenant data touched. This
  supports moving ~1.3 seconds off prepared-standby activation, not a claim that
  end-to-end chats are now subsecond. Remaining SDK/model time is still present.
- Full affected package suites passed: runner-core 494, sandbox-k8s 368 + 1 skip,
  channel-web 3894, Claude SDK runner 304, AI SDK runner 402. ESLint rule suite
  22 and script suite 1100 + 3 skips passed. Scoped TypeScript and ESLint passed.
  Evidence: `deploy/gke/shared-pool-startup-latency-2026-10-02.json`.
  Production remained deployed at revision 32 throughout diagnosis.
- Root `pnpm build` and the channel-web TypeScript/Vite production build passed.
