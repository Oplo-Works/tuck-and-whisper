const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

test('v36 cached v32 upgrade boots direct theme controls on the first navigation and preserves the draft offline', async ({ browser }) => {
  const oldFiles = new Map(fs.readdirSync('web').map(file => [file, execFileSync('git', ['show', 'f361d5b:web/' + file])]));
  let currentHTML = false, currentWorker = false;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!oldFiles.has(file)) { res.writeHead(404).end(); return; }
    const live = currentHTML && (file !== 'sw.js' || currentWorker);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', ({ js: 'application/javascript', css: 'text/css', html: 'text/html', json: 'application/json', svg: 'image/svg+xml' })[file.split('.').pop()]);
    res.end(live ? fs.readFileSync('web/' + file) : oldFiles.get(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  try {
    const page = await context.newPage(), base = 'http://127.0.0.1:' + server.address().port;
    await page.goto(base); await page.waitForFunction(() => window.TAW_READY);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload(); await page.waitForFunction(() => window.TAW_READY);
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    expect(await page.evaluate(() => caches.keys())).toContain('taw-shell-v32');
    await page.locator('#memo-input').fill('업데이트 후에도 남아야 하는 메모');
    await expect(page.locator('#save-status')).toContainText(/Saved|저장됨/);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    currentHTML = true; // Deliberately retain the v32 worker during this navigation.
    await page.reload(); await page.waitForFunction(() => window.TAW_READY);
    await expect(page.locator('footer')).toHaveText('build: direct-theme (shell v36)');
    await expect(page.locator('#memo-input')).toHaveValue('업데이트 후에도 남아야 하는 메모');
    await expect(page.locator('#nav-library')).toBeEnabled();
    await expect(page.locator('header #lang-select')).toBeVisible();
    await expect(page.locator('#lang-select option')).not.toHaveCount(0);
    await page.locator('#lang-select').selectOption('en');
    await expect(page.locator('#nav-capture')).toHaveText('Capture');
    await page.locator('#theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
    expect(await page.evaluate(() => caches.keys())).toContain('taw-shell-v32');
    expect(errors).toEqual([]);
    currentWorker = true;
    await page.evaluate(async () => {
      const previous = navigator.serviceWorker.controller;
      const controlled = new Promise(resolve => {
        navigator.serviceWorker.addEventListener('controllerchange', function changed() {
          if (navigator.serviceWorker.controller !== previous) {
            navigator.serviceWorker.removeEventListener('controllerchange', changed); resolve();
          }
        });
      });
      const reg = await navigator.serviceWorker.getRegistration();
      await reg.update(); await controlled;
    });
    await page.waitForFunction(async () => (await caches.keys()).includes('taw-shell-v36') && !(await caches.keys()).includes('taw-shell-v32'));
    await context.setOffline(true); await page.reload(); await page.waitForFunction(() => window.TAW_READY);
    await expect(page.locator('#lang-select')).toHaveValue('en');
    await expect(page.locator('header #lang-select')).toBeVisible();
    await expect(page.locator('#memo-input')).toHaveValue('업데이트 후에도 남아야 하는 메모');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
    await page.locator('#theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dusk');
    expect(errors).toEqual([]);
  } finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
});
