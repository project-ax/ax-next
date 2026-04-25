# Manual acceptance — channel-web mock backend

12-step smoke. Each step assumes you've already run `pnpm install` and `pnpm --filter @ax/channel-web dev`. Open http://localhost:5173.

1. **LoginPage shows.** Title "tide", a single "Sign in with Google" button. Clicking it should authenticate as Alice.
2. **Sidebar populated.** After login: 240px left rail with brand "tide", agent chip showing the default agent, "+ new session" button, sessions list (initially empty), user row at the bottom showing "Alice".
3. **Send a message.** Pick "tide" from the agent chip. Type "hello, what can you do?" — observe streaming response (char-by-char), one status chip ("planning…"), and ~30% of turns surface a diagnostic banner. Final message appears in the assistant style.
4. **Reload survives.** F5. After auth re-resolves, the same session + history reappear.
5. **Sign out → sign in as Admin.** Click user row → Sign out. On the login page click sign-in to get u2 again. To get u1, hit `/api/auth/callback?user=u1`. The user row now shows "Admin".
6. **Admin entries visible.** Open user menu → see "Admin · Agents", "Admin · MCP Servers", "Admin · Teams" entries. (Alice does NOT see these.)
7. **Admin → Agents.** Modal opens, lists seeded agents (`tide`, `mercy`, `team-engineering`). Click "+ New agent", fill name + system prompt, Save. Modal refreshes with the new agent in the list.
8. **Admin → MCP Servers.** Modal opens, no servers yet. Click "+ New MCP server", fill name + url + transport, Save. New row appears with a Test button. Click Test — see "ok" badge.
9. **Theme toggle.** User menu → theme: dark. UI flips to dark mode. Reload — theme persists.
10. **Sidebar collapse.** Click the panel-with-rail toggle in the session header. Sidebar collapses to 56px. Reload — collapsed state persists.
11. **Edit user message.** Click pencil on a prior user message, change text, hit Update. The conversation truncates to that point and a new assistant turn streams.
12. **Switch agent mid-conversation.** With messages in the active session, click the agent chip and pick a different agent. Chat view goes blank. Send a message — a NEW session is created under the new agent. The old session is still in the sidebar.

If any step fails, file the symptom against `feat/chat-ui-pulled-forward` before merging. The mock isn't perfect but it should hit all 12 reliably.
