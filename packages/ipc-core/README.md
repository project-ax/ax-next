# @ax/ipc-core

Transport-agnostic IPC primitives shared by the runner-IPC listeners. This package owns the dispatcher, auth, body parsing, response writers, error mapping, and per-action handlers (`handlers/tool-list.ts`, etc.). Two listener packages sit on top of it: `@ax/ipc-server` (unix-socket transport, runner-on-host) and `@ax/ipc-http` (TCP transport, runner-in-pod).

Why this lives outside `@ax/core`: the dispatcher and the action handlers call the hook bus and encode protocol semantics — that's IPC material, not kernel material. Keeping it here lets `@ax/core` stay small (just the kernel) while still letting both transports share one well-tested implementation of the protocol logic. If you're adding a new transport, depend on `@ax/ipc-core`; if you're changing how an action behaves, the handler lives here.
