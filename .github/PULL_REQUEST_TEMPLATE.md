<!--
  AX v2 PR template. The "Boundary review" section is required for any PR that
  adds or changes a service-hook signature, or adds a subscriber with a non-
  trivial payload. If your PR only changes a plugin's internal implementation,
  delete the Boundary review section.
-->

## Summary

<!-- One or two sentences on what this PR does and why. -->

## Changes

<!-- Bullet list of the concrete changes. -->

-
-

## Boundary review

<!-- REQUIRED when adding/changing a service hook, or adding a subscriber hook
     with a non-trivial payload. If this PR is internal-only, delete this
     section with a one-line note: "Internal change — no hook surface touched." -->

- **Alternate impl this hook could have:**
  <!-- Name one. If you can't, consider whether this needs to be a hook at all. -->

- **Payload field names that might leak:**
  <!-- List any backend-specific names (sha, branch, pod_name, bucket,
       socket_path, etc.), or say "none". If present, justify or rename. -->

- **Subscriber risk:**
  <!-- Could a subscriber key off a backend-specific field and break when the
       alternate impl ships? yes / no / explain. -->

- **Wire surface:**
  <!-- If this hook is also an IPC action, confirm the Zod schema lives in this
       plugin's directory (not a central file). -->

## Test plan

- [ ]
- [ ]

## Canary status

<!-- If this PR adds a plugin, confirm the canary acceptance test reaches it.
     If it doesn't, explain the plan (or remove the plugin — no half-wired code). -->
