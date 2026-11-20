// Serve the repository on localhost:4173, then run with playwright-core and three installed.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright-core');

async function inspectTerrain(page, label) {
  const samples = await page.evaluate(() => {
    window.LOOK.render();
    const sample = document.createElement('canvas');
    sample.width = sample.height = 100;
    const ctx = sample.getContext('2d');
    ctx.drawImage(document.querySelector('#cv'), 0, 0, 100, 100);
    const pixels = ctx.getImageData(0, 60, 100, 40).data;
    let sand = 0, lawn = 0, black = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = pixels.subarray(i, i + 3);
      if (r > 120 && r > g * 1.12 && g > b * 1.16) sand++;
      if (g > 80 && g > r * 1.1 && g > b * 1.5) lawn++;
      if (Math.max(r, g, b) < 16) black++;
    }
    return { sand, lawn, black };
  });
  console.log(label, samples);
  await page.screenshot({path: 'render-check-' + label + '.png', timeout:20000});
  assert(samples.sand > 350 && samples.lawn > 380 && samples.black < 600,
    'The lower scene should show the sandy path and the green lawn');
}

async function run() {
  const browser = await chromium.launch({
    channel:'chrome', headless:true, args:['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  try {
    const context = await browser.newContext({viewport:{width:390, height:640}, hasTouch:true});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && /shader|webgl/i.test(message.text())) errors.push(message.text());
    });
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    const moduleFile = path.join(path.dirname(require.resolve('three')), 'three.module.js');
    let releaseModule, moduleRequested;
    const gate = new Promise(resolve => { releaseModule = resolve; });
    const request = new Promise(resolve => { moduleRequested = resolve; });
    await page.route('https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js', async route => {
      moduleRequested();
      await gate;
      await route.fulfill({path:moduleFile, contentType:'text/javascript', headers:{'Access-Control-Allow-Origin':'*'}});
    });
    await page.goto('http://127.0.0.1:4173/index.html?dev', {waitUntil:'commit'});
    await request;
    await page.locator('.pad').first().waitFor({state:'attached'});
    async function hiddenBeforeStart() {
      return page.evaluate(() => ['#dist', '#threatrow', '.pad', '#bubble', '#dot1', '#dot2'].every(selector => {
        const el = document.querySelector(selector);
        if (getComputedStyle(el).visibility === 'hidden') return true;
        for (let p = el; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.display === 'none' || Number(s.opacity) === 0) return true;
        }
        return false;
      }));
    }
    assert(await hiddenBeforeStart(), 'HUD leaked before the first render');
    releaseModule();
    await page.getByRole('button', {name:'시작'}).waitFor({timeout:45000});
    assert(await hiddenBeforeStart(), 'HUD leaked onto the title');
    await inspectTerrain(page, 'portrait-title');
    await page.reload({waitUntil:'domcontentloaded'});
    await page.getByRole('button', {name:'시작'}).waitFor();
    assert(await hiddenBeforeStart(), 'HUD leaked on reload');
    const other = await context.newPage();
    await other.bringToFront();
    await page.bringToFront();
    await other.close();
    await inspectTerrain(page, 'returned-title');
    // Static capture mode allows a precise state comparison across a full GPU reset.
    await page.goto('http://127.0.0.1:4173/index.html?capture&seq=full');
    await page.evaluate(() => window.LOOK.render());
    await page.evaluate(async () => {
      const cv = document.querySelector('#cv'), gl = cv.getContext('webgl2');
      const ext = gl.getExtension('WEBGL_lose_context');
      if (!ext) throw new Error('Missing WebGL context-loss test extension');
      const lost = new Promise(resolve => cv.addEventListener('webglcontextlost', resolve, {once:true}));
      const restored = new Promise(resolve => cv.addEventListener('webglcontextrestored', resolve, {once:true}));
      ext.loseContext();
      await lost;
      if (getComputedStyle(document.querySelector('#go')).visibility !== 'hidden') throw new Error('Stale controls during GPU reset');
      await new Promise(resolve => setTimeout(resolve, 250));
      ext.restoreContext();
      await Promise.race([restored, new Promise((_,reject) => setTimeout(() => reject(new Error('GPU restore timed out')), 15000))]);
    });
    await inspectTerrain(page, 'restored-title');
    await page.setViewportSize({width:820,height:420});
    await page.waitForFunction(() => document.querySelector('#cv').width === innerWidth);
    await inspectTerrain(page, 'landscape-title');
    await page.getByRole('button', {name:'시작'}).click();
    assert.equal(await page.evaluate(() => window.LOOK.state().phase),'intro');
    await page.evaluate(() => {
      for (let i = 0; i < (window.LOOK.IT.open + 2) * 30; i++) window.LOOK.sim(1 / 30);
      window.LOOK.render();
    });
    assert.equal(await page.evaluate(() => window.LOOK.state().phase),'play');
    assert(await page.locator('.pad').first().isVisible());
    assert.equal(await page.locator('#top').evaluate(el => getComputedStyle(el).opacity),'1');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
