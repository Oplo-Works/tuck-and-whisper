const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const out = path.resolve('local-media/voice-recording-v42');
function wav() {
  const b = Buffer.alloc(4844); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(4800, 40); return b;
}
async function boot(page, mode = 'allow') {
  await page.addInitScript(({ mode, bytes }) => {
    localStorage.setItem('taw-lang', 'en'); window.micCalls = 0; window.trackStops = 0;
    const send = window.fetch;
    window.fetch = async (url, options) => {
      if (String(url).endsWith('/api/voice')) {
        const audio = options.body.get('audio');
        window.voicePayload = { name: audio.name, header: Array.from(new Uint8Array(await audio.arrayBuffer()).slice(0, 4)) };
      }
      return send(url, options);
    };
    const tracks = [{ onended: null, stop() { window.trackStops++; } }], stream = { getTracks: () => tracks };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
      window.micCalls++;
      if (mode === 'denied') throw new DOMException('Synthetic denied', 'NotAllowedError');
      if (mode === 'missing') throw new DOMException('Synthetic missing', 'NotFoundError');
      if (mode === 'busy') throw new DOMException('Synthetic busy', 'NotReadableError');
      if (mode === 'pending') await new Promise(r => { window.allowMic = r; });
      return stream;
    } } });
    class FakeRecorder {
      static isTypeSupported(type) { return mode === 'webm' ? type === 'audio/webm;codecs=opus' : type === 'audio/mp4'; }
      constructor(s, options) { this.mimeType = options?.mimeType || 'audio/mp4'; this.state = 'inactive'; window.fakeRecorder = this; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob([new Uint8Array(mode === 'empty' ? [] : bytes)], { type: this.mimeType }) }); this.onstop?.(); }); }
    }
    window.MediaRecorder = mode === 'unsupported' ? undefined : FakeRecorder;
    // Windows Playwright WebKit has no audio engine. These cases verify UI and
    // transport with a synthetic decoder, not Safari AAC compatibility.
    if (!window.AudioContext && !window.webkitAudioContext) {
      window.AudioContext = class { decodeAudioData() { return Promise.resolve({ duration: 0.1 }); } close() {} };
      window.OfflineAudioContext = class {
        createBufferSource() { return { connect() {}, start() {} }; }
        startRendering() { return Promise.resolve({ getChannelData: () => new Float32Array(2400) }); }
      };
    }
  }, { mode, bytes: Array.from(wav()) });
  const calls = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/voice') { calls.push(route.request().postDataBuffer()); return route.fulfill({ json: { transcript: 'SYNTHETIC_PARENT_NOTE' } }); }
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto('/'); await page.waitForFunction(() => window.TAW_READY);
  await page.locator('#voice-tools summary').click(); return calls;
}
async function shot(page, name) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  fs.mkdirSync(out, { recursive: true }); await page.locator('#voice-tools').screenshot({ path: path.join(out, name + '.png'), scale: 'css' });
}

test('v42 recorder mobile allowed recording stops locally and converts only on explicit action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const calls = await boot(page);
  await page.locator('#memo-input').fill('SYNTHETIC_EXISTING_NOTE'); await shot(page, 'voice-controls');
  await page.locator('#record-btn').click(); await expect(page.locator('#recording-status')).toContainText('Recording.');
  await expect(page.locator('#stop-recording')).toBeVisible(); await expect(page.locator('#voice-input')).toBeDisabled();
  await expect(page.locator('#transcribe-btn')).toBeDisabled(); await shot(page, 'recording');
  await page.locator('#stop-recording').click(); await expect(page.locator('#recording-status')).toContainText('Recording ready'); await shot(page, 'recording-ready');
  expect(calls).toHaveLength(0); await expect(page.locator('#memo-input')).toHaveValue('SYNTHETIC_EXISTING_NOTE');
  await expect(page.locator('#voice-warning')).toBeVisible();
  expect(await page.evaluate(() => TawRecorder.getFile().type)).toBe('audio/mp4');
  expect(await page.evaluate(() => window.trackStops)).toBeGreaterThan(0);
  await page.locator('#transcribe-btn').click(); await expect(page.locator('#memo-input')).toHaveValue('SYNTHETIC_PARENT_NOTE');
  await expect(page.locator('#voice-check')).toBeVisible(); await expect(page.locator('#voice-warning')).toBeHidden(); expect(calls).toHaveLength(1);
  // WebKit's intercepted request body can omit Blob bytes; inspect FormData before fetch instead.
  expect(await page.evaluate(() => window.voicePayload)).toEqual({ name: 'audio.wav', header: [82, 73, 70, 70] });
});
for (const [mode, text] of [['denied', 'not allowed'], ['unsupported', 'unavailable in this browser'], ['missing', 'No microphone'], ['busy', 'microphone is unavailable']]) test('v42 recorder mobile ' + mode + ' provides reason and working file fallback', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); const calls = await boot(page, mode);
  if (mode === 'unsupported') await expect(page.locator('#record-btn')).toBeDisabled(); else await page.locator('#record-btn').click();
  await expect(page.locator('#recording-status')).toContainText(text); await expect(page.locator('#voice-input')).toBeEnabled();
  if (mode === 'denied') await shot(page, 'permission-denied');
  await page.locator('#voice-input').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.locator('#transcribe-btn').click(); await expect(page.locator('#memo-input')).toHaveValue('SYNTHETIC_PARENT_NOTE'); expect(calls).toHaveLength(1);
});
test('v42 recorder mobile ten minutes stops automatically and does not transcribe', async ({ page }) => {
  const calls = await boot(page); await page.clock.install(); await page.locator('#record-btn').click();
  await expect(page.locator('#recording-status')).toContainText('Recording.'); await page.clock.fastForward(600000);
  await expect(page.locator('#recording-status')).toContainText('stopped automatically at 10 minutes');
  await expect(page.locator('#transcribe-btn')).toBeEnabled(); expect(calls).toHaveLength(0);
  expect(await page.evaluate(() => window.fakeRecorder.state)).toBe('inactive'); expect(await page.evaluate(() => window.trackStops)).toBeGreaterThan(0);
});
for (const finalChunk of [false, true]) test('v42 recorder rejects more than 32 MB including final chunk: ' + finalChunk, async ({ page }) => {
  const calls = await boot(page); await page.locator('#record-btn').click(); await expect(page.locator('#recording-status')).toContainText('Recording.');
  await page.evaluate(finalChunk => {
    const emit = () => window.fakeRecorder.ondataavailable({ data: new Blob([new Uint8Array(32 * 1024 * 1024 + 1)], { type: 'audio/mp4' }) });
    if (finalChunk) window.fakeRecorder.stop = function () { this.state = 'inactive'; queueMicrotask(() => { emit(); this.onstop(); }); }; else emit();
  }, finalChunk);
  if (finalChunk) await page.locator('#stop-recording').click();
  await expect(page.locator('#recording-status')).toContainText('exceeded 32 MB');
  await expect(page.locator('#transcribe-btn')).toBeDisabled(); await expect(page.locator('#voice-input')).toBeEnabled(); expect(calls).toHaveLength(0);
});
test('v42 uploaded audio retains 32 MB guard and visible decode errors', async ({ page }) => {
  const calls = await boot(page);
  await page.locator('#voice-input').setInputFiles({ name: 'large.m4a', mimeType: 'audio/mp4', buffer: Buffer.alloc(32 * 1024 * 1024 + 1) });
  await page.locator('#transcribe-btn').click(); await expect(page.locator('#message')).toContainText('32 MB maximum');
  await page.locator('#voice-input').setInputFiles({ name: 'invalid.m4a', mimeType: 'audio/mp4', buffer: Buffer.from('Synthetic invalid audio') });
  await page.locator('#transcribe-btn').click(); await expect(page.locator('#message')).toContainText('could not be decoded');
  await expect(page.locator('#voice-input')).toBeEnabled(); expect(calls).toHaveLength(0);
});
test('v42 existing decode pipeline rejects audio duration over ten minutes', async ({ page }) => {
  const calls = await boot(page);
  await page.evaluate(() => { window.AudioContext = class { decodeAudioData() { return Promise.resolve({ duration: 601 }); } close() {} }; });
  await page.locator('#voice-input').setInputFiles({ name: 'long.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.locator('#transcribe-btn').click(); await expect(page.locator('#message')).toContainText('10 minutes maximum'); expect(calls).toHaveLength(0);
});
for (const mode of ['empty', 'error']) test('v42 recorder ' + mode + ' releases microphone and permits retry', async ({ page }) => {
  const calls = await boot(page, mode); await page.locator('#record-btn').click();
  if (mode === 'error') await page.evaluate(() => window.fakeRecorder.onerror()); else await page.locator('#stop-recording').click();
  await expect(page.locator('#recording-status')).toContainText('Recording failed');
  await expect(page.locator('#record-btn')).toBeEnabled(); await expect(page.locator('#voice-input')).toBeEnabled();
  expect(await page.evaluate(() => window.trackStops)).toBeGreaterThan(0); expect(calls).toHaveLength(0);
});
test('v42 canceled permission request cannot start a late microphone session', async ({ page }) => {
  await boot(page, 'pending'); await page.locator('#record-btn').click();
  await expect(page.locator('#recording-status')).toContainText('Waiting for microphone'); await page.locator('#stop-recording').click();
  await page.evaluate(() => window.allowMic()); await expect(page.locator('#record-btn')).toBeEnabled();
  expect(await page.evaluate(() => window.fakeRecorder)).toBeUndefined(); expect(await page.evaluate(() => window.trackStops)).toBeGreaterThan(0);
});
test('v42 leaving Capture stops recording and retains the captured file', async ({ page }) => {
  const calls = await boot(page); await page.locator('#record-btn').click(); await page.locator('#nav-library').click();
  await page.locator('#nav-capture').click(); await expect(page.locator('#transcribe-btn')).toBeEnabled();
  expect(await page.evaluate(() => window.fakeRecorder.state)).toBe('inactive'); expect(calls).toHaveLength(0);
});
test('v42 reset releases microphone and removes captured audio', async ({ page }) => {
  await boot(page); await page.locator('#record-btn').click(); page.on('dialog', dialog => dialog.accept());
  await page.locator('#new-day-btn').click(); await expect(page.locator('#transcribe-btn')).toBeDisabled();
  expect(await page.evaluate(() => TawRecorder.getFile())).toBeNull(); expect(await page.evaluate(() => window.trackStops)).toBeGreaterThan(0);
});
for (const leave of ['collapse', 'background']) test('v42 recorder stops on ' + leave + ' without automatic conversion', async ({ page }) => {
  const calls = await boot(page); await page.locator('#record-btn').click();
  if (leave === 'collapse') await page.locator('#voice-tools summary').click();
  else await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => page.evaluate(() => TawRecorder.busy())).toBe(false);
  expect(await page.evaluate(() => TawRecorder.getFile().size)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.trackStops)).toBeGreaterThan(0); expect(calls).toHaveLength(0);
});
test('v42 unavailable media API keeps file upload reachable', async ({ page }) => {
  await boot(page); await page.evaluate(() => { Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined }); TawRecorder.render(); });
  await expect(page.locator('#record-btn')).toBeDisabled(); await expect(page.locator('#recording-status')).toContainText('unavailable');
  await expect(page.locator('#voice-input')).toBeEnabled();
});
test('v42 recorder chooses supported WebM and keeps ko/en and fallback copy', async ({ page }) => {
  await boot(page, 'webm'); await page.locator('#lang-select').selectOption('ko');
  await expect(page.locator('#record-btn')).toHaveText('녹음 시작'); await page.locator('#record-btn').click();
  await expect(page.locator('#recording-status')).toContainText('녹음 중'); await page.locator('#stop-recording').click();
  expect(await page.evaluate(() => TawRecorder.getFile().type)).toBe('audio/webm;codecs=opus');
  await page.locator('#lang-select').selectOption('es'); await expect(page.locator('#record-btn')).toHaveText('Start recording');
  await expect(page.locator('#recording-status')).toContainText('Recording ready');
});
test('v42 real Chrome MediaRecorder and decode pipeline use synthetic microphone audio', async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  try {
    const page = await browser.newPage(); let calls = 0;
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/voice') { calls++; return route.fulfill({ json: { transcript: 'SYNTHETIC_MICROPHONE_RESULT' } }); }
      return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
    });
    await page.goto('http://127.0.0.1:4173/'); await page.waitForFunction(() => window.TAW_READY);
    await page.locator('#voice-tools summary').click(); await page.locator('#record-btn').click();
    await expect(page.locator('#recording-timer')).toContainText('00:01'); await page.locator('#stop-recording').click();
    await expect(page.locator('#transcribe-btn')).toBeEnabled(); expect(calls).toBe(0);
    console.log('Synthetic Chrome recording format:', await page.evaluate(() => TawRecorder.getFile().type));
    await page.locator('#transcribe-btn').click(); await expect(page.locator('#memo-input')).toHaveValue('SYNTHETIC_MICROPHONE_RESULT'); expect(calls).toBe(1);
  } finally { await browser.close(); }
});
test('v43 recorder mobile stopping a recording highlights Convert to Text, shows saved badge, and reveals off-screen CTA', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 420 }); const calls = await boot(page);
  await expect(page.locator('#recording-saved')).toBeHidden();
  const disabledStyle = await page.locator('#transcribe-btn').evaluate(el => { const s = getComputedStyle(el); return { opacity: s.opacity, borderStyle: s.borderStyle, boxShadow: s.boxShadow, bg: s.backgroundImage }; });
  expect(disabledStyle.opacity).toBe('0.38'); expect(disabledStyle.borderStyle).toBe('dashed'); expect(disabledStyle.boxShadow).toBe('none');
  await page.locator('#record-btn').click(); await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.locator('#transcribe-btn').evaluate(el => el.getBoundingClientRect().bottom > window.innerHeight)).toBe(true);
  await page.locator('#stop-recording').evaluate(el => el.click());
  await expect(page.locator('#recording-saved')).toBeVisible();
  await expect(page.locator('#recording-saved')).toContainText('Recording saved · 00:01');
  await expect(page.locator('#recording-status')).toHaveClass(/is-ready/);
  await expect(page.locator('#recording-status')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#recording-status')).toContainText('↓ Recording ready. Choose Convert to Text below.');
  await expect(page.locator('#transcribe-btn')).toBeEnabled();
  await expect(page.locator('#transcribe-btn')).toBeFocused();
  await expect(page.locator('#transcribe-btn')).toBeInViewport();
  for (const theme of ['dusk', 'paper']) {
    if (theme === 'paper') await page.locator('#theme-toggle').click();
    const styles = await page.evaluate(() => {
      const t = getComputedStyle(document.getElementById('transcribe-btn')), e = getComputedStyle(document.getElementById('extract-btn'));
      return { opacity: t.opacity, borderStyle: t.borderStyle, boxShadow: t.boxShadow, bg: t.backgroundImage, extractBg: e.backgroundImage };
    });
    expect(styles.opacity).toBe('1'); expect(styles.borderStyle).toBe('solid');
    expect(styles.boxShadow).not.toBe('none'); expect(styles.bg).toContain('linear-gradient');
    expect(styles.bg).not.toBe(styles.extractBg);
  }
  await page.locator('#lang-select').selectOption('ko');
  await expect(page.locator('#recording-saved')).toContainText('녹음 저장됨 · 00:01');
  await expect(page.locator('#recording-status')).toContainText('↓ 녹음이 준비됐어요. 아래 ‘메모로 변환’을 눌러 주세요.');
  await page.locator('#lang-select').selectOption('fr');
  await expect(page.locator('#recording-saved')).toContainText('Recording saved · 00:01');
  expect(calls).toHaveLength(0);
  await expect(page.locator('#voice-warning')).toBeHidden(); await page.locator('#transcribe-btn').click(); await expect(page.locator('#memo-input')).toHaveValue('SYNTHETIC_PARENT_NOTE'); await expect(page.locator('#voice-warning')).toBeHidden(); expect(calls).toHaveLength(1);
});
