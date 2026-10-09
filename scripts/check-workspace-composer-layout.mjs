#!/usr/bin/env node
// Browser regression for usable composers and reachable welcome content in the
// redesigned frame. Uses the existing preset-k8s Playwright dependency.
// AX_BROWSER_EXECUTABLE_PATH=/path/to/chrome node scripts/check-workspace-composer-layout.mjs http://127.0.0.1:5173
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../presets/k8s/package.json', import.meta.url))('playwright');
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:5173').origin;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.AX_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.AX_BROWSER_EXECUTABLE_PATH } : {}),
});
const agent = { id: 'layout-agent', name: 'Quill', state: 'resting', now: null, counter: null, startedAt: null, stoppedReason: null };
const detail = { agent, conversationId: 'c1', thread: [], decisions: { status: 'ok' }, past: [], memory: { rules: { status: 'unavailable', doc: null }, factsAvailable: false } };
const failures=[];
try {
 for (const [width,theme,height] of [[320,'light',960],[390,'dark',844],[768,'light',960],[768,'light',400],[900,'dark',400],[1024,'light',400],[1440,'light',960],[1440,'dark',960]]) {
  const context=await browser.newContext({viewport:{width,height},colorScheme:theme});
  await context.addCookies([{name:'mock-session',value:'u2',url:origin}]);
  await context.addInitScript(theme=>localStorage.setItem('ax-theme',theme),theme);
  const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/admin/bootstrap-status', (r) => r.fulfill({ json: { status: 'completed' } }));
      await page.route('**/api/workspace/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        const json = path.endsWith('/state') ? { agents: [agent] }
          : path.endsWith('/decisions') ? { decisions: [] }
          : path.endsWith('/grants') ? { grants: [] }
          : path.endsWith('/activity') ? { events: [], hasMore: false }
          : path.endsWith('/rail') ? { activity: { status: 'ok', items: [] }, permissions: { status: 'ok', rows: [], incomplete: false, unrestrictedTools: false }, grants: { status: 'ok', rows: [], incomplete: false }, counters: { status: 'ok', rows: [], windowDays: 7 } }
          : path.endsWith('/abilities') ? { abilities: { webSearch: true, readPages: true, runCode: true } }
          : path.endsWith('/connectors') ? { connectors: [], shared: false, manageable: true, connectorsSupported: true, sharedCredentials: false }
          : detail;
        return r.fulfill({ json });
      });


  await page.goto(`${origin}/workspace/agents/layout-agent/chat`);
  await page.getByText('Nothing here yet',{exact:true}).waitFor();
  await page.evaluate(()=>document.fonts.ready);
  const composer=page.getByRole('group',{name:'Message Quill',exact:true});
  const geometry=await composer.evaluate(el=>{
    const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};};
    return {composer:box(el),input:box(el.querySelector('input[data-slot=input-group-control]')),send:box(el.querySelector('button[aria-label=Send]')),attach:box(el.querySelector('button[aria-label="Attach a file"]'))};
  });
  const label=`${width}x${height} ${theme}`;
  if(geometry.input.width<100) failures.push(`${label}: textbox squeezed to ${geometry.input.width}px`);
  for(const [name,box] of Object.entries(geometry)){
    if(name==='composer')continue;
    if(box.left<geometry.composer.left || box.right>geometry.composer.right || box.top<geometry.composer.top || box.bottom>geometry.composer.bottom)failures.push(`${label}: ${name} outside composer: ${JSON.stringify(geometry)}`);
  }
  const welcome=await page.locator('.group\\/thread').evaluate(el=>{
    el.scrollTop=-10000;
    return {scrollTop:el.scrollTop,titleTop:el.querySelector('[data-slot=empty-title]').getBoundingClientRect().top,top:el.getBoundingClientRect().top};
  });
  if(welcome.titleTop<welcome.top) failures.push(`${label}: welcome title above scroll origin: ${JSON.stringify(welcome)}`);
  await composer.getByRole('textbox').fill('Retained draft');
  const send=composer.getByRole('button',{name:'Send',exact:true});
  assert(await send.isEnabled(),`${label}: draft cannot be sent`);
  await send.scrollIntoViewIfNeeded();
  const bounds=await send.boundingBox();
  if(bounds.y<0 || bounds.y+bounds.height>height) failures.push(`${label}: Send is unreachable in the viewport`);
  if(await page.getByRole('button',{name:/Agent details/}).count()) await page.getByRole('button',{name:/Agent details/}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  if(width<768) await page.getByRole('button',{name:/^Instructions Rules/}).click();
  await page.getByRole('heading',{name:'Instructions',exact:true}).waitFor();
  if(width<768){await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Chat',exact:true}).click();}
  else await page.getByRole('button',{name:'Back to chat',exact:true}).click();
  assert.equal(await page.getByRole('textbox').inputValue(),'Retained draft',`${label}: draft lost after settings`);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(`${label}: textbox ${geometry.input.width}px, welcome ${JSON.stringify(welcome)}`);
  await context.close();
 }
 assert.deepEqual(failures,[],failures.join('\n'));
}finally{await browser.close();}
