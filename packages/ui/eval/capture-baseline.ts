/**
 * Baseline capture: full-page screenshots + axe counts of channel-web.
 * Re-run for the "after" set, through the identical path, so only CSS differs.
 *
 * Two modes:
 *
 *  --kind (the real baseline): channel-web's Vite dev server in proxy mode in front of a
 *    backend, signed in as an existing admin. Read-only: it only navigates and GETs.
 *      kubectl --context kind-ax-next-dev -n ax-next port-forward svc/ax-next-host 19090:9090
 *      pnpm --filter @ax/channel-web exec vite build && \
 *        AX_BACKEND_URL=http://localhost:19090 pnpm --filter @ax/channel-web exec vite preview --port 5173 --strictPort
 *    (A production build behind `vite preview`, not `vite dev`: dev's dependency optimizer cannot
 *    serve the chat-visuals `ax-vendor/*?raw` imports, so the agent page crashes under `dev`.
 *    Preview reuses the same proxy config, so the browser still talks to http://localhost:5173.)
 *      AX_SESSION_TOKEN=<live session token> AX_HTTP_COOKIE_KEY=<64 hex> \
 *        pnpm --filter @project-ax/ui exec tsx eval/capture-baseline.ts <outDir> --kind
 *    The token and key come from the environment only; the cookie is signed in memory with
 *    the real `signCookieValue` and is never written or logged.
 *
 *  default (mock): the dev server's mock backend (AX_BACKEND_URL unset); reaches only the
 *    sign-in page and error states. Kept for offline use.
 *
 * Output: <outDir>/<route>-<width>-<theme>.png, <outDir>/axe.json (raw, local only) and
 * <outDir>/axe-summary.json (sanitized: rule, impact, node count; safe to commit) (serious+critical
 * violation nodes per route, light theme at 1440 only).
 *
 * Never use waitUntil 'networkidle': the app holds an SSE stream open.
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const kind = args.includes('--kind');
const positional = args.filter((a) => !a.startsWith('--'));
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
// Kind captures hold real data from a dev cluster and must never be committed: by default they
// go outside the repo. Only axe-summary.json (rule ids, impacts, counts) is safe to commit.
const outDir = resolve(positional[0] ?? (kind ? join(homedir(), 'ax-ui-eval', 'capture') : 'eval/results/baseline'));
const baseUrl = positional[1] ?? 'http://localhost:5173';

interface Route {
  name: string;
  /** Put the page in the state to shoot (navigate, click). Must be read-only. */
  go: (page: Page, ctx: BrowserContext) => Promise<unknown>;
  /** Visible text that proves the state is ready. */
  expect: string | RegExp;
  signedIn: boolean;
}

const SETTLE_MS = 1200;
const nav = (page: Page, path: string) => page.goto(`${baseUrl}${path}`, { waitUntil: 'load' });

async function getJson(ctx: BrowserContext, path: string): Promise<any> {
  const r = await ctx.request.get(`${baseUrl}${path}`);
  if (!r.ok()) throw new Error(`GET ${path} -> ${r.status()}`);
  return r.json();
}

const openSettings = async (page: Page) => {
  await nav(page, '/workspace');
  await page.getByRole('button', { name: /Open navigation|Admin/ }).first().waitFor();
  // On a narrow screen the sidebar (and the user menu in it) sits behind a button.
  const burger = page.getByRole('button', { name: 'Open navigation' });
  if (await burger.isVisible()) await burger.click();
  await page.getByRole('button', { name: /Admin/ }).last().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Back to workspace' }).waitFor();
};
const settingsTab = (label: string, admin: boolean): Route['go'] => async (page) => {
  await openSettings(page);
  // On a narrow screen the settings list sits behind a button.
  const opener = page.getByRole('button', { name: 'Open settings navigation' });
  if (await opener.isVisible()) await opener.click();
  const nav_ = page.getByRole('navigation', { name: 'Settings' });
  if (admin) {
    const trigger = nav_.getByRole('button', { name: 'Administration' });
    // Collapsible: only expand when its items are hidden.
    if (!(await nav_.getByRole('button', { name: label, exact: true }).isVisible())) await trigger.click();
  }
  await nav_.getByRole('button', { name: label, exact: true }).click();
};

const SETTINGS_USER_TABS = ['Skills', 'Sites', 'Agents', 'Routines', 'Storage'];
const SETTINGS_ADMIN_TABS = [
  'Connectors', 'AI model keys', 'Models', 'Helper model', 'Sign-in methods', 'Teams', 'Slack', 'Branding', 'Usage',
];
const AGENT_SETTINGS = ['instructions', 'model', 'connectors', 'slack', 'apps', 'memory', 'skills', 'routines'];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function kindRoutes(): Route[] {
  const r: Route[] = [
    { name: 'sign-in', signedIn: false, expect: 'Sign in with Google', go: (p) => nav(p, '/') },
    { name: 'today', signedIn: true, expect: 'Today', go: (p) => nav(p, '/workspace') },
    {
      // The agent's page opens on its most recent existing conversation. Nothing is sent.
      name: 'agent-conversation', signedIn: true, expect: 'Conversation',
      go: async (p, c) => {
        const [a] = await getJson(c, '/api/chat/agents');
        await nav(p, `/workspace/agents/${encodeURIComponent(a.agentId)}`);
      },
    },
    {
      name: 'agent-files', signedIn: true, expect: 'Files',
      go: async (p, c) => {
        const [a] = await getJson(c, '/api/chat/agents');
        await nav(p, `/workspace/agents/${encodeURIComponent(a.agentId)}`);
        await p.getByRole('radio', { name: 'Files' }).click();
      },
    },
    { name: 'tasks', signedIn: true, expect: 'Tasks', go: (p) => nav(p, '/workspace/tasks') },
    {
      name: 'task', signedIn: true, expect: /./,
      go: async (p, c) => {
        const { tasks } = await getJson(c, '/api/workspace/tasks');
        const t = tasks[0];
        if (!t) throw new Error('no tasks on this backend');
        await nav(p, `/workspace/tasks/${encodeURIComponent(t.agentId)}/${encodeURIComponent(t.routineId)}`);
      },
    },
  ];
  for (const s of AGENT_SETTINGS) {
    r.push({
      name: `agent-settings-${s}`, signedIn: true, expect: /./,
      go: async (p, c) => {
        const [a] = await getJson(c, '/api/chat/agents');
        await nav(p, `/workspace/agents/${encodeURIComponent(a.agentId)}/settings/${s}`);
      },
    });
  }
  for (const t of SETTINGS_USER_TABS) r.push({ name: `settings-${slug(t)}`, signedIn: true, expect: t, go: settingsTab(t, false) });
  for (const t of SETTINGS_ADMIN_TABS) r.push({ name: `admin-${slug(t)}`, signedIn: true, expect: t, go: settingsTab(t, true) });
  return r;
}

const SHARE_CODE = 'A'.repeat(32);
const mockRoutes: Route[] = [
  { name: 'sign-in', path: '/', signedIn: false, expect: 'Sign in with Google' },
  { name: 'workspace-load-error', path: '/', signedIn: true, expect: 'We could not load your workspace' },
  { name: 'shared-artifact-load-error', path: `/a/${SHARE_CODE}`, signedIn: true, expect: 'We couldn’t open this' },
  { name: 'apps-approve-load-error', path: '/apps/approve/slack/app1/c0123456789', signedIn: true, expect: "We couldn't load this" },
].map((m) => ({
  name: m.name, signedIn: m.signedIn, expect: m.expect,
  go: async (p: Page, c: BrowserContext) => {
    if (m.signedIn) {
      await nav(p, '/auth/sign-in/google');
      await p.waitForTimeout(1500);
    }
    await nav(p, m.path);
  },
}));

const ROUTES: Route[] = (kind ? kindRoutes() : mockRoutes).filter((r) => !only || only.has(r.name));
const VIEWPORTS = [{ w: 1440, h: 900 }, { w: 390, h: 844 }];
const THEMES = ['light', 'dark'] as const;

async function signedContext(browser: import('playwright').Browser, vp: { w: number; h: number }) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
  return ctx;
}

async function addSession(ctx: BrowserContext) {
  const token = process.env.AX_SESSION_TOKEN;
  const keyHex = process.env.AX_HTTP_COOKIE_KEY;
  if (!token || !keyHex) throw new Error('--kind needs AX_SESSION_TOKEN and AX_HTTP_COOKIE_KEY in the environment');
  // The real signer, from the built http-server package (pnpm --filter @ax/http-server build).
  const { signCookieValue } = (await import('../../http-server/dist/cookies.js')) as {
    signCookieValue: (k: Buffer, v: string) => string;
  };
  await ctx.addCookies([{
    name: 'ax_auth_session', value: signCookieValue(Buffer.from(keyHex, 'hex'), token),
    domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax',
  }]);
}

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const axe: Record<string, { serious: number; critical: number; rules: string[] }> = {};
const failed: string[] = [];
for (const route of ROUTES) {
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const ctx = await signedContext(browser, vp);
      try {
        if (kind && route.signedIn) await addSession(ctx);
        const page = await ctx.newPage();
        await route.go(page, ctx);
        await page.getByText(route.expect).first().waitFor({ timeout: 20_000 });
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        await page.waitForTimeout(SETTLE_MS);
        await page.screenshot({ path: `${outDir}/${route.name}-${vp.w}-${theme}.png`, fullPage: true });
        if (vp.w === 1440 && theme === 'light') {
          const res = await new AxeBuilder({ page }).analyze();
          const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
          const n = (imp: string) => bad.filter((v) => v.impact === imp).reduce((a, v) => a + v.nodes.length, 0);
          axe[route.name] = { serious: n('serious'), critical: n('critical'), rules: bad.map((v) => `${v.id} (${v.impact}, ${v.nodes.length})`) };
        }
        console.log(`ok   ${route.name}-${vp.w}-${theme}`);
      } catch (e) {
        failed.push(`${route.name}-${vp.w}-${theme}`);
        console.log(`FAIL ${route.name}-${vp.w}-${theme}: ${(e as Error).message.split("\n").slice(0, 4).join(" ")}`);
      } finally {
        await ctx.close();
      }
    }
  }
}
await browser.close();
writeFileSync(`${outDir}/axe.json`, JSON.stringify(axe, null, 2) + '\n');
const summary = Object.fromEntries(
  Object.entries(axe).map(([k, v]) => [
    k,
    {
      serious: v.serious,
      critical: v.critical,
      rules: v.rules.map((r) => {
        const m = /^(.+) \((\w+), (\d+)\)$/.exec(r)!;
        return { rule: m[1], impact: m[2], nodes: Number(m[3]) };
      }),
    },
  ]),
);
writeFileSync(`${outDir}/axe-summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
if (failed.length > 0) console.log(`failed: ${failed.join(', ')}`);
