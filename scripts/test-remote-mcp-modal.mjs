/** Local browser regression for the remote connector editor. Starts Vite's mock
 * app, intercepts only test APIs, and removes its temporary entry points.
 * Playwright is a verification tool, not a production dependency. See the
 * connector-modal implementation note for setup and screenshot locations. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AX_PLAYWRIGHT_MODULE ?? 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const web = path.join(root, 'packages/channel-web');
const artifacts = path.join(root, '.playwright-mcp/remote-mcp-modal');
const entry = `connector-check-${randomUUID()}`;
const html = path.join(web, `${entry}.html`);
const source = path.join(web, `src/${entry}.tsx`);
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const origin = `http://127.0.0.1:${port}`;
let vite, browser;
try {
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    html,
    `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/src/${entry}.tsx"></script></body></html>`,
  );
  await writeFile(
    source,
    `import { createRoot } from 'react-dom/client';
import { AdminShell } from './components/admin/AdminShell';
import { UserProvider } from './lib/user-context';
import './index.css';
const admin = new URLSearchParams(location.search).has('admin');
createRoot(document.getElementById('root')!).render(<UserProvider value={{id:'u1',name:'Test user',email:'test@example.com',role:admin?'admin':'user'}}><AdminShell isAdmin={admin} onClose={()=>{}} initialTab="connectors-user" /></UserProvider>);`,
  );
  const viteEnv = { ...process.env };
  delete viteEnv.AX_BACKEND_URL;
  vite = spawn(
    'pnpm',
    [
      '--filter',
      '@ax/channel-web',
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: root, env: viteEnv, stdio: 'ignore', detached: true },
  );
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      if ((await fetch(origin)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* Vite is starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, 'Vite did not start');
  const macChrome =
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath =
    process.env.AX_BROWSER_EXECUTABLE ??
    (existsSync(macChrome) ? macChrome : undefined);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
  });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let connector = {
    id: 'linear',
    name: 'Linear',
    description: 'Preserved description',
    usageNote: 'Preserved instructions',
    keyMode: 'personal',
    visibility: 'private',
    defaultAttached: false,
    createdAt: '',
    updatedAt: '',
    capabilities: {
      allowedHosts: ['mcp.linear.app', 'auth.linear.app', 'api.linear.app'],
      credentials: [
        {
          kind: 'oauth',
          slot: 'TOKEN',
          server: 'linear',
          clientRegistration: 'auto',
        },
      ],
      mcpServers: [
        {
          name: 'linear',
          transport: 'http',
          url: 'https://mcp.linear.app/mcp',
          allowedHosts: [],
          credentials: [],
        },
      ],
      packages: { npm: [], pypi: [] },
    },
  };
  const writes = [];
  await page.route('**/settings/connectors**', (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON();
      writes.push({ kind: 'connector', body });
      connector = { ...connector, ...body };
      return route.fulfill({ json: { connector } });
    }
    if (url.pathname === '/settings/connectors')
      return route.fulfill({ json: { connectors: [connector] } });
    if (url.pathname === '/settings/connectors/linear')
      return route.fulfill({ json: { connector } });
    return route.fulfill({ json: { drafts: [] } });
  });
  await page.route('**/settings/destinations/account/credential', (route) => {
    writes.push({ kind: 'secret', body: route.request().postDataJSON() });
    return route.fulfill({ json: {} });
  });
  await page.route('**/settings/credentials', (route) =>
    route.fulfill({ json: { credentials: [] } }),
  );
  await page.route('**/api/chat/allowed-sites', (route) =>
    route.fulfill({ json: { grants: [] } }),
  );
  await page.route('**/api/chat/remembered-sites', (route) =>
    route.fulfill({ json: { sites: [] } }),
  );
  const redirect = 'https://ax.example.com/api/connectors/oauth/callback';
  await page.route('**/api/connectors/oauth/client-metadata', (route) =>
    route.fulfill({
      json: {
        client_id:
          'https://ax.example.com/api/connectors/oauth/client-metadata',
        redirect_uris: [redirect],
      },
    }),
  );
  await page.route('**/api/connectors/oauth/discover-hosts', (route) =>
    route.fulfill({ json: { hosts: ['auth.linear.app', 'api.linear.app'] } }),
  );
  const edit = () => page.getByRole('button', { name: 'Edit', exact: true });
  const save = () =>
    page.getByRole('button', { name: 'Save changes', exact: true });
  const dialog = () => page.getByRole('dialog');
  async function screenshot(name) {
    await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
  }
  async function viewportFits() {
    const bounds = await dialog().boundingBox(),
      footer = await save().boundingBox();
    assert(
      bounds.x >= 15 && bounds.y >= 15,
      'The modal must keep a viewport margin',
    );
    assert(
      bounds.x + bounds.width <= page.viewportSize().width - 15,
      'The modal must fit horizontally',
    );
    assert(
      bounds.y + bounds.height <= page.viewportSize().height - 15,
      'The modal must fit vertically',
    );
    assert(
      footer.y >= bounds.y &&
        footer.y + footer.height < bounds.y + bounds.height,
      'Save must remain visible outside the scrolling body',
    );
    assert(
      await dialog().evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
      'The modal must not scroll horizontally',
    );
  }
  await page.goto(`${origin}/${entry}.html`);
  await edit().click();
  await page.getByLabel('Name', { exact: true }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('button[type="submit"]')?.disabled,
  );
  assert.equal(
    await page
      .getByRole('button', { name: /OAuth client Automatic/ })
      .getAttribute('aria-expanded'),
    'false',
  );
  await viewportFits();
  await screenshot('desktop-default');
  await page.getByRole('button', { name: /OAuth client Automatic/ }).click();
  for (const name of [
    'AX’s published identity (CIMD)',
    'Register automatically (DCR)',
  ]) {
    await page.getByRole('radio', { name, exact: true }).click();
    assert.equal(
      await page
        .getByRole('radio', { name, exact: true })
        .getAttribute('aria-checked'),
      'true',
    );
  }
  await page
    .getByRole('radio', { name: 'Use my own client', exact: true })
    .click();
  assert.equal(
    await page.getByRole('radiogroup', { name: 'OAuth client method' }).count(),
    0,
  );
  await page.getByLabel('Client ID', { exact: true }).fill('custom-client');
  await page
    .getByLabel('Client secret (optional)', { exact: true })
    .fill('test-client-secret');
  assert(await page.getByText(redirect, { exact: true }).isVisible());
  await screenshot('desktop-custom-client');
  await page.getByRole('button', { name: /Request headers/ }).click();
  await page.getByRole('button', { name: 'Add header', exact: true }).click();
  await page.getByLabel('Header name', { exact: true }).fill('X-API-Key');
  await page.getByLabel('Value', { exact: true }).fill('test-header-secret');
  await page.setViewportSize({ width: 390, height: 844 });
  await viewportFits();
  await screenshot('mobile-headers');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  // Existing buttons animate token changes; capture the settled theme.
  await page.waitForTimeout(250);
  await viewportFits();
  await screenshot('mobile-dark');
  await page.setViewportSize({ width: 640, height: 500 });
  await viewportFits();
  await screenshot('short-viewport');
  await save().click();
  await edit().waitFor();
  assert.equal(writes.filter((write) => write.kind === 'secret').length, 2);
  const saved = writes.find((write) => write.kind === 'connector').body;
  assert.equal(saved.capabilities.credentials[0].clientRegistration, 'custom');
  assert.equal(
    saved.capabilities.credentials[0].clientSecretRef,
    'account:linear:oauth-client-secret',
  );
  assert.equal(saved.capabilities.credentials[1].headerName, 'X-API-Key');
  assert(
    !JSON.stringify(saved).includes('test-client-secret') &&
      !JSON.stringify(saved).includes('test-header-secret'),
    'Secrets must never enter connector configuration',
  );
  assert(
    !('visibility' in saved) && !('defaultAttached' in saved),
    'User writes must not carry admin permissions',
  );
  assert.equal(connector.description, 'Preserved description');
  assert.equal(connector.usageNote, 'Preserved instructions');
  // Reopen: drafts and raw secrets must be gone; an existing header stays bound.
  await edit().click();
  await page.getByLabel('Name', { exact: true }).waitFor();
  await page
    .getByRole('button', { name: /OAuth client Custom client/ })
    .click();
  assert(await page.getByText('Saved securely', { exact: true }).isVisible());
  await page.getByRole('radio', { name: 'No sign-in', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: /OAuth client/ }).count(),
    0,
  );
  await save().click();
  await edit().waitFor();
  assert.equal(connector.capabilities.credentials.length, 1);
  assert.equal(connector.capabilities.credentials[0].headerName, 'X-API-Key');
  await edit().click();
  await page.getByLabel('Name', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await dialog().count(), 0);
  await page.keyboard.press('Tab');
  assert.equal(await dialog().count(), 0);
  assert.deepEqual(pageErrors, []);
  console.log(
    `Remote MCP modal browser checks passed. Screenshots: ${artifacts}`,
  );
} finally {
  await browser?.close();
  if (vite?.pid) {
    try {
      process.kill(-vite.pid, 'SIGTERM');
    } catch {
      /* Already exited. */
    }
  }
  await Promise.all([html, source].map((file) => unlink(file).catch(() => {})));
}
