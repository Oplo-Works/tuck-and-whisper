const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/browser', grep: /v33 mobile|v37 mobile/, timeout: 30000, workers: 1,
  outputDir: './test-results/mobile',
  use: { baseURL: 'http://127.0.0.1:4173', headless: true, serviceWorkers: 'block', isMobile: true, hasTouch: true },
  projects: [
    { name: 'android-chromium', use: { browserName: 'chromium', channel: 'chrome', deviceScaleFactor: 2 } },
    { name: 'ios-webkit', use: { browserName: 'webkit', deviceScaleFactor: 3 } }
  ],
  webServer: { command: 'node tests/serve.mjs', url: 'http://127.0.0.1:4173', reuseExistingServer: true }
});
