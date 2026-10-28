/** Local browser regression: real task setup components, fixture HTTP answers, no cluster.
 * Run from any directory: node deploy/kind/walks/2026-10-27-TASK-984/browser.mjs
 * Needs pnpm install and Playwright Chromium (the existing preset dev dependency).
 * Writes proof/screenshots to a new temporary directory and removes only its own preview files.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs/promises';
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(join(repo, 'presets/k8s/package.json'));
const { chromium } = require('playwright');
const dir = await fs.mkdtemp(join(tmpdir(), 'ax-task984-browser-'));
const owned = [];
let server, browser;
try {
  await fs.writeFile(join(repo, 'packages/channel-web/task984-preview.html'), "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/task984-preview.tsx\"></script></body></html>\n", { flag: 'wx' });
  owned.push(join(repo, 'packages/channel-web/task984-preview.html'));
  await fs.writeFile(join(repo, 'packages/channel-web/task984-preview.tsx'), "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport './src/index.css';\nimport { TaskAppUpdates } from './src/components/workspace/TaskAppUpdates';\ncreateRoot(document.getElementById('root')!).render(<main className=\"mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-8\"><h1 className=\"text-2xl font-semibold\">Keep support moving</h1><TaskAppUpdates agentId=\"a\" routineId=\"opaque-r1\" onEdit={() => {}} /></main>);\n", { flag: 'wx' });
  owned.push(join(repo, 'packages/channel-web/task984-preview.tsx'));
  server = spawn('pnpm', ['--filter', '@ax/channel-web', 'exec', 'vite', '--host', '127.0.0.1', '--port', '5194', '--strictPort'], { cwd: repo, detached: true, stdio: 'ignore' });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (server.exitCode !== null) throw new Error('Preview server did not start; check port5194 is free.');
    try { ready = (await fetch('http://127.0.0.1:5194/task984-preview.html')).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Preview server did not become ready.');
browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:1280,height:960}});
const page = await context.newPage();
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
let connected=false,fail=false,rotated=false;
const row={agentId:'a',routineId:'opaque-r1',revision:'v',ownedByCaller:true,origin:'authored',defaultRoutineId:null,name:'Keep support moving',description:'',promptBody:'Check tickets',enabled:true,schedule:{kind:'interval',every:'1h'},webhook:{kind:'webhook',path:'/updates',hmac:{app:'zendesk'},respondWithin:'5m'},activeHours:null,silenceToken:null,silenceMaxChars:300,conversation:'per-fire',kind:'stay-on-top',goodWhen:'No open tickets',nextRunAt:null,lastRunAt:null,lastStatus:null,lastError:null,lastWarning:null,permissions:{edit:true,stop:true,fire:true,manageSecret:true},task:null,noRecentUpdate:null,steps:[],finishBy:null,finishByTimeZone:null,done:null};
await page.route('**/settings/routines/**',async route=>{
 const path=new URL(route.request().url()).pathname;
 if(path.endsWith('/receiver/status')){
  if(fail) return route.fulfill({status:503,json:{error:'PRIVATE response'}});
  return route.fulfill({json:{agentId:'a',routineId:'opaque-r1',setupReady:true,app:'zendesk',lastAcceptedAt:connected?'2026-10-27T20:14:00.000Z':null,signatureChecked:connected,verifiedAt:null,windowStart:'2026-10-27T19:15:00.000Z',refusals:connected?[{reason:'signature',count:4},{reason:'capacity',count:2}]:[]}});
 }
 if(path.endsWith('/receiver/replace')){rotated=true;connected=false;return route.fulfill({json:{url:'/webhooks/fixture-replaced',version:'b'.repeat(64),legacyActive:false}});}
 if(path.endsWith('/receiver'))return route.fulfill({json:{url:'/webhooks/fixture-private-address',version:'a'.repeat(64),legacyActive:false}});
 return route.fulfill({json:{routine:row}});
});
await page.route('**/settings/destinations/routine-hmac/credential?**',route=>route.fulfill({json:{configured:true}}));
await page.route('**/admin/credentials/**',route=>route.fulfill({json:{configured:true}}));
await page.goto('http://127.0.0.1:5194/task984-preview.html');
await page.getByText('Waiting for the first update',{exact:true}).waitFor();
await page.getByLabel('Webhook URL',{exact:true}).waitFor();

await page.screenshot({path:dir+'/desktop-waiting.png',fullPage:true});
connected=true;
await page.getByRole('button',{name:'Check connection',exact:true}).click();
await page.getByText(/Zendesk connected/).waitFor();
if(!await page.getByText(/4 because the signature/).isVisible())throw Error('No counted signature refusal');
await page.screenshot({path:dir+'/desktop-connected.png',fullPage:true});
await page.setViewportSize({width:390,height:844});
await page.screenshot({path:dir+'/mobile-connected.png',fullPage:true});
const actionFits=await page.getByRole('button',{name:'Replace key',exact:true}).evaluate(button=>button.scrollWidth<=button.clientWidth);
if(!actionFits)throw Error('Signing-secret action text is squeezed on mobile');
const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
if(overflow)throw Error('Mobile overflow');
fail=true;await page.getByRole('button',{name:'Check connection',exact:true}).click();
await page.getByRole('alert').waitFor();
if(await page.getByText(/Zendesk connected/).count())throw Error('Stale connection after failure');
if((await page.locator('body').textContent()).includes('PRIVATE'))throw Error('Provider error leaked');
await page.screenshot({path:dir+'/mobile-error.png',fullPage:true});
fail=false;await page.getByRole('button',{name:'Check connection',exact:true}).click();await page.getByText(/Zendesk connected/).waitFor();
await page.getByRole('button',{name:'Replace address',exact:true}).click();
await page.getByRole('dialog').getByRole('button',{name:'Replace address',exact:true}).click();
await page.getByText('Waiting for the first update',{exact:true}).waitFor();
if(!rotated)throw Error('No rotation');
await fs.writeFile(dir+'/browser-proof.json',JSON.stringify({desktop:true,mobile:true,noOverflow:!overflow,statusRefresh:true,retry:true,rotationClearedStatus:true,actionFits,errors},null,2));
await browser.close();
if(errors.length)throw Error(errors.join('\n'));
console.log('PASS desktop/mobile waiting, signed connection, refusal counts, retry, rotation, no overflow or page errors');

  console.log(`Browser proof: ${dir}`);
} finally {
  if (browser?.isConnected()) await browser.close();
  if (server?.pid) { try { process.kill(-server.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  for (const path of owned) await fs.unlink(path);
}
