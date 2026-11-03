const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: './tests/browser', timeout: 30000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173', channel: 'chrome', headless: true, serviceWorkers: 'block', viewport: { width: 418, height: 900 } },
  webServer: { command: 'node tests/serve.mjs', url: 'http://127.0.0.1:4173', reuseExistingServer: true } });
