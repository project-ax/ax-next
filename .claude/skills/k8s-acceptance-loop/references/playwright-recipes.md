# Playwright-MCP recipes for the acceptance loop

Concrete call sequences for the patterns that recur across acceptance scenarios. Read the recipe that matches your scenario, not the whole file.

The MCP tools referenced here are the standard Playwright-MCP set:

- `browser_navigate(url)` — open / change page; lazily starts the browser.
- `browser_snapshot()` — accessibility tree of the current page (preferred over screenshots for assertions because it's text + structure, not pixels).
- `browser_take_screenshot()` — pixel snapshot; useful when describing the failure to the user, not for assertions.
- `browser_click(ref)`, `browser_type(ref, text)`, `browser_fill_form(fields)` — interaction.
- `browser_wait_for({ text | textGone | time })` — wait for a real condition; never use `time` as a substitute for the real signal.
- `browser_console_messages()` — every console line since the last clear; capture after each step.
- `browser_network_requests()` — every request since page load; filter to the API paths you care about.
- `browser_evaluate(fn)` — run JS in the page context. Useful for setting cookies, reading `document.cookie`, or inspecting state the DOM doesn't expose.
- `browser_press_key(key)` — Enter to submit, Escape to dismiss, etc.
- `browser_close()` — only at the very end of a session; not between iterations (you'll lose cookies + cache state that helps reproduce).

Capture pattern: after every meaningful interaction step, run `browser_snapshot` + `browser_console_messages` + `browser_network_requests` and stash the results in your loop scratchpad. Don't try to remember; the data is cheap.

---

## Recipe 1 — Sign in via dev-bootstrap

The kind canary uses `auth.devBootstrap.token` as a pre-shared bearer. The token mints a session cookie at `POST /auth/dev-bootstrap`. Two ways to drive it:

### 1a. Mint the cookie before navigating (faster, no UI flow)

```
# 1. POST the token from the host shell. The cookie comes back in Set-Cookie.
TOKEN=$(kubectl -n ax-next get secret ax-next-secrets \
  -o jsonpath='{.data.dev-bootstrap-token}' | base64 -d)
curl -i -X POST http://localhost:9090/auth/dev-bootstrap \
  -H 'Content-Type: application/json' \
  -H 'X-Requested-With: ax-admin' \
  -d "{\"token\":\"$TOKEN\"}" | tee /tmp/auth.headers

# 2. Extract the cookie value (look for ax-session= in /tmp/auth.headers).
# 3. Plant it in the browser before navigating to a protected page:
browser_navigate('http://localhost:9090/')          # land on something same-origin
browser_evaluate(() => {
  document.cookie = 'ax-session=<value>; Path=/; SameSite=Lax';
})
browser_navigate('http://localhost:9090/<protected route>')
```

The cookie is `HttpOnly` from the server, but `document.cookie =` from the page works for setting (the browser doesn't enforce HttpOnly on writes from JS — only reads). This is dev-only; production deploys never see this path.

### 1b. Drive the sign-in surface in the UI

If the scenario uses the channel-web Vite dev server, there's usually a sign-in button somewhere. Find it via `browser_snapshot`, click it, and let the standard flow set the cookie. Slower but exercises the actual UI path — preferred when the scenario is about auth itself.

### Verification

```
browser_network_requests()
# expect: POST /auth/dev-bootstrap → 200, with `set-cookie: ax-session=...` in response headers
browser_evaluate(() => document.cookie)
# expect: a string containing ax-session= (HttpOnly cookies don't show here, but if it does show
#         it means the server didn't mark it HttpOnly — which is a bug worth flagging)
```

---

## Recipe 2 — Send a chat message and wait for a tool-using response

Used by the kind canary acceptance: send a prompt, the assistant runs a bash tool, the response references the tool output.

```
# 1. Land on the chat surface
browser_navigate('http://localhost:9090/')           # or the channel-web Vite URL
browser_snapshot()                                   # confirm the composer is rendered

# 2. Type and submit the prompt
browser_type(<composer-textarea-ref>, 'list the files in /workspace')
browser_press_key('Enter')                           # or browser_click(<send-button-ref>)

# 3. Wait for the assistant turn to appear and complete
browser_wait_for({ text: 'list the files in /workspace' })  # echo of user message in transcript
browser_wait_for({ text: '<expected substring of assistant reply>' })
# If you don't know the exact text, wait on a structural cue instead:
# browser_wait_for({ textGone: 'Generating' })   # streaming indicator clears
# browser_wait_for({ text: 'tool_use' })         # tool block in DOM (depends on chat surface)

# 4. Capture
browser_snapshot()                                   # the assistant's full reply structure
browser_console_messages()
browser_network_requests()                           # look for POST /api/chat or POST /chat
```

What to assert on:

- The user message is in the transcript (proves submit worked).
- The assistant message exists AND contains a tool-use block AND that block's output matches the scenario's expectation (e.g., empty listing, a file name, an error string).
- `POST /chat` returned 200 with a body shaped `{ sessionId, outcome }`.
- No console errors.

Common failure modes specific to this recipe:

- Assistant message stays empty / spinner never resolves → runner pod didn't spawn or didn't connect back. Check `kubectl get pods -n ax-next-runners` and the host's `[ax/ipc-http]` log lines.
- Tool block missing entirely → the assistant chose not to use a tool. Either the prompt was too vague or the tool wasn't registered. Check host logs for `tool:execute` entries.
- Tool output present but wrong → real bug; this is the case the loop exists for.

---

## Recipe 3 — Stream a long response and verify partial states

Some scenarios care about what the UI shows mid-stream, not just the final state. Use `browser_wait_for` on intermediate cues:

```
browser_type(<composer>, '<long-output-prompting message>')
browser_press_key('Enter')

# A. The streaming indicator appears
browser_wait_for({ text: 'Generating' })             # or whatever the chat surface uses

# B. First chunk lands
browser_wait_for({ text: '<early-token-substring>' })
browser_snapshot()                                   # capture the partial state
browser_console_messages()                           # streaming errors show up here

# C. Stream completes
browser_wait_for({ textGone: 'Generating' })
browser_snapshot()
```

If the partial state is wrong but the final state is right, the bug is in the chat-surface streaming code, not the orchestrator. If the partial state never appears at all, the streaming protocol is dropping chunks — check `browser_network_requests` for the SSE / chunked response and `kubectl logs deploy/ax-next-host` for `chat:stream` entries.

---

## Recipe 4 — Multi-turn conversation, persistent session

Acceptance scenarios that test session persistence (DB row landed, second turn references first turn) need to keep `sessionId` stable across turns.

```
# Turn 1
browser_type(<composer>, 'remember the number 47')
browser_press_key('Enter')
browser_wait_for({ textGone: 'Generating' })
SESSION_ID=$(browser_evaluate(() => /* read from URL or app state */))

# Turn 2 — same composer, new message
browser_type(<composer>, 'what number did I tell you?')
browser_press_key('Enter')
browser_wait_for({ text: '47' })

# Cross-check server state
kubectl exec -n ax-next deploy/ax-next-host -- \
  psql -U ax_next -d ax_next \
  -c "SELECT count(*) FROM session_postgres_v1_sessions WHERE id = '$SESSION_ID';"
```

If the sessionId resets between turns, the chat surface isn't keeping it — that's a chat-surface bug, not an orchestrator bug. If the row count is 0, the session plugin isn't persisting; check host logs for `session_postgres` entries.

---

## Recipe 5 — Pure failure capture (the scenario already failed; you're just gathering evidence)

When the page is in a known-broken state and you want a complete record before triaging:

```
browser_take_screenshot()                            # for the scratchpad / user
browser_snapshot()                                   # for assertion / diff against last good
browser_console_messages()                           # all errors + warnings
browser_network_requests()                           # full request log

# Then jump to cluster-side
kubectl -n ax-next logs deploy/ax-next-host --tail=300 > /tmp/host.log
kubectl -n ax-next-runners logs -l app.kubernetes.io/component=ax-next-runner \
  --tail=300 --all-containers --prefix > /tmp/runner.log
kubectl -n ax-next describe pod -l app.kubernetes.io/component=ax-next-host \
  | tail -80 > /tmp/host-describe.log
```

Now compare side by side: a console error with a stack trace usually has a matching line in `/tmp/host.log` (same exception class, same message). When they match, the fix is in the host. When they don't — the browser-side error is one layer away from the server error — there's a translation step (an API client, a streaming parser) between them, and that's where the bug lives.

---

## Notes on driver hygiene

- **Don't `browser_close` between iterations.** Cookies, cache, and the open dev-tools state are useful context. Close only at the very end.
- **Re-navigate after a fast-loop redeploy.** The cached JS bundle masks fixes. `browser_navigate` to the same URL forces a reload.
- **`browser_wait_for({ time: N })` is a code smell.** If you can't name the condition you're waiting on, you don't know what passing looks like. Stop and re-derive the criteria before continuing.
- **`browser_evaluate` for state inspection only.** Don't drive the app from inside `browser_evaluate` (e.g., calling React handlers directly) — that exercises a path real users never hit. The point of using a browser is to test the same path users take.
