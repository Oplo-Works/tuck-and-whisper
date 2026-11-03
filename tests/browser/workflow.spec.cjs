const { test, expect } = require('@playwright/test');
const memo = '아이가 강아지를 좋아했어요. 들판에서 만나 들이라고 이름 지었어요. 엄마가 들이는 들이 엄마와 지내고 싶어 할 거라고 말했어요.';
const passages = memo.split(/(?<=\.) /);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGNomLAAiBggFAAuzgbBPIwuuwAAAABJRU5ErkJggg==';
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
async function boot(page, hooks = {}) {
  const requests = [];
  await page.addInitScript(() => localStorage.setItem('taw-lang', 'ko'));
  await page.route('https://taw-meta-proxy.minkyuthebuilder.workers.dev/**', async route => {
    const req = route.request(), body = req.postDataJSON(); requests.push({ url: req.url(), body });
    if (req.url().endsWith('/api/image')) {
      if (hooks.image) await hooks.image.promise;
      return route.fulfill({ json: { data: [{ b64_json: png }] } });
    }
    const system = body.messages[0].content;
    let result;
    if (system.startsWith('Extract')) {
      if (hooks.extract) await hooks.extract.promise;
      result = { candidates: passages.map(text => ({ text, quote: text, source: 'memo', grade: 'B' })).concat({ text: '사진에 작은 강아지가 보여요.', source: 'photo', grade: 'C' }), unknowns: ['기분은 어떨까?'] };
    } else {
      if (system.includes('bedtime') && hooks.story) await hooks.story.promise;
      if (system.includes('briefing') && hooks.briefing) await hooks.briefing.promise;
      const facts = JSON.parse(body.messages[1].content);
      if (hooks.invalid) result = { ids: ['FORBIDDEN'] }; else result = { ids: facts.map(f => f.id) };
    }
    await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(result) } }] } });
  });
  await page.goto('/'); await page.waitForFunction(() => window.TAW_READY);
  return requests;
}
async function review(page, withPhoto = false) {
  await page.locator('#memo-input').fill(memo);
  if (withPhoto) await page.locator('#photo-input').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.locator('#extract-btn').click(); await expect(page.locator('#screen-review')).toBeVisible();
  for (let i = 0; i < 3; i++) await page.locator('#memo-candidates').getByRole('button', { name: '맞아요', exact: true }).nth(i).click();
}
async function stored(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('taw-v2'); open.onsuccess = () => { const db = open.result, tx = db.transaction('current'), r = tx.objectStore('current').get('day'); tx.oncomplete = () => { resolve(r.result.record); db.close(); }; }; open.onerror = () => reject(open.error);
  }));
}
test('T01/T02/T19 real UI skips photos, unuses a confirmed fact and displays exact passages', async ({ page }) => {
  const requests = await boot(page); await review(page);
  await page.locator('#memo-candidates input[type=checkbox]').first().uncheck();
  await expect(page.locator('#photo-details')).not.toHaveAttribute('open');
  await page.locator('#prepare-btn').click(); await expect(page.locator('#briefing')).toContainText(passages[1]);
  await page.locator('#open-bedtime').click(); await expect(page.locator('#story')).toContainText(passages[2]);
  await expect(page.locator('#story')).not.toContainText(passages[0]);
  const generation = requests.filter(r => r.body.messages?.[0].content.startsWith('Choose'));
  expect(generation.length).toBe(2); for (const r of generation) expect(r.body.messages[1].content).not.toContain(passages[0]);
  await page.locator('#screen-bedtime .audit summary').click(); await expect(page.locator('#bedtime-audit')).toContainText(passages[0]);
  const record = await stored(page); expect(record.candidates[0].decision).toBe('confirmed'); expect(record.candidates[0].included).toBe(false);
  expect(record.candidates[3].decision).toBe('undecided');
  await page.screenshot({ path: 'test-results/reviewed-reading.png', fullPage: true });
});
test('DS1-1: testimony save cannot discard a pending story', async ({ page }) => {
  const story = deferred(); await boot(page, { story }); await review(page); await page.locator('#prepare-btn').click();
  await page.locator('#open-bedtime').click(); await page.locator('#testimony-input').fill('[테스트] 실제 아이 답변 아님'); await page.locator('#save-testimony').click();
  story.resolve(); await expect(page.locator('#story')).toContainText(passages[0]);
  const r = await stored(page); expect(r.testimony[0].text).toContain('[테스트]'); expect(r.story.lines).toHaveLength(3);
});
test('DS1-2: illustration and story both complete; partial identity and unapproved art stay hidden', async ({ page }) => {
  const story = deferred(), image = deferred(); await boot(page, { story, image }); await review(page, true);
  await page.locator('#identity-details summary').click(); await page.locator('#identity-people').selectOption('same');
  await page.locator('#prepare-btn').click(); await page.locator('#open-bedtime').click();
  await page.getByText('부모 도구', { exact: true }).click(); await expect(page.locator('#style-btn')).toBeDisabled();
  await page.locator('#nav-review').click(); await page.locator('#identity-animals').selectOption('same');
  await page.locator('#prepare-btn').click(); await page.locator('#open-bedtime').click();
  await page.locator('#style-btn').click(); image.resolve(); await expect(page.locator('#art-preview img')).toBeVisible();
  await expect(page.locator('#reading-art img')).toHaveCount(0);
  await page.locator('#accept-art').click(); story.resolve();
  await expect(page.locator('#story')).toContainText(passages[0]); await expect(page.locator('#reading-art img')).toBeVisible();
});
test('DS1-3: inclusion change discards a late story and late failure status', async ({ page }) => {
  const story = deferred(); await boot(page, { story }); await review(page); await page.locator('#prepare-btn').click(); await page.locator('#open-bedtime').click();
  await page.locator('#nav-review').click(); await page.locator('#memo-candidates input').first().uncheck(); story.resolve();
  await expect.poll(async () => (await stored(page)).candidates[0].included).toBe(false);
  expect((await stored(page)).story).toBeNull(); await expect(page.locator('#story')).not.toContainText(passages[0]);
});
test('DS1-4: replacing a photo during first extraction kills old work even with no candidates', async ({ page }) => {
  const extract = deferred(); await boot(page, { extract }); await page.locator('#memo-input').fill(memo);
  await page.locator('#photo-input').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.locator('#extract-btn').click(); await expect(page.locator('#extract-btn')).toBeDisabled();
  await page.locator('#photo-input').setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }); extract.resolve();
  await expect(page.locator('#extract-btn')).toBeEnabled(); expect((await stored(page)).candidates).toHaveLength(0);
});
test('DS1-5: question edit while briefing runs survives briefing completion', async ({ page }) => {
  const briefing = deferred(); await boot(page, { briefing }); await review(page); await page.locator('#prepare-btn').click();
  await page.locator('#question-text').fill('부모가 직접 고친 질문'); briefing.resolve();
  await expect(page.locator('#briefing')).toContainText(passages[0]); await expect(page.locator('#question-text')).toHaveValue('부모가 직접 고친 질문');
  expect((await stored(page)).question.edited).toBe(true);
});
test('T14 invalid selector falls back without accepting generated assertions', async ({ page }) => {
  await boot(page, { invalid: true }); await review(page); await page.locator('#prepare-btn').click();
  await expect(page.locator('#briefing')).toContainText('원문 그대로'); await expect(page.locator('#briefing')).not.toContainText('FORBIDDEN');
  await page.locator('#open-bedtime').click(); await expect(page.locator('#story')).toContainText(passages[0]);
});
test('T35 alternatives exhaust without deleting the question; keyboard works', async ({ page }) => {
  await boot(page); await review(page); await page.locator('#prepare-btn').click();
  await page.locator('#another-question').click(); await page.locator('#another-question').click();
  const last = await page.locator('#question-text').inputValue(); await page.locator('#another-question').click();
  await expect(page.locator('#question-text')).toHaveValue(last); await expect(page.locator('#message')).toContainText('모두 살펴봤어요');
  await page.locator('#screen-preview .audit summary').focus(); await page.keyboard.press('Enter'); await expect(page.locator('#preview-audit')).toBeVisible();
});
test('T07/T33 v1 decisions migrate unused; source localStorage is untouched', async ({ page }) => {
  const old = { mode: 'live', memoText: passages[0], candidates: [{ id: 'F1', text: passages[0], source: 'memo', grade: 'B', decision: 'confirmed' }], unknowns: [] };
  await page.addInitScript(value => localStorage.setItem('taw-day-v1', JSON.stringify(value)), old);
  await boot(page); await page.locator('#nav-review').click(); await expect(page.locator('#memo-candidates input')).not.toBeChecked();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('taw-day-v1')))).toEqual(old);
});
test('T32 stale tab cannot overwrite newer record and offers recovery', async ({ page, context }) => {
  await boot(page); const other = await context.newPage(); await boot(other);
  await other.locator('#memo-input').fill('다른 탭에서 먼저 저장');
  await expect(other.locator('#save-status')).toContainText('저장됨');
  await page.locator('#memo-input').fill('오래된 탭의 미저장 내용');
  await expect(page.locator('#storage-warning')).toBeVisible(); await expect(page.locator('#download-draft')).toBeVisible();
  await expect(other.locator('#memo-input')).toHaveValue('다른 탭에서 먼저 저장');
  await page.locator('#reload-record').click(); await expect(page.locator('#memo-input')).toHaveValue('다른 탭에서 먼저 저장');
});

async function reading(page, art = false) {
  await review(page, art);
  if (art) { await page.locator('#identity-details summary').click(); await page.locator('#identity-people').selectOption('same'); await page.locator('#identity-animals').selectOption('same'); }
  await page.locator('#prepare-btn').click(); await page.locator('#open-bedtime').click(); await expect(page.locator('#story')).toContainText(passages[0]);
  if (art) { await page.getByText('부모 도구', { exact: true }).click(); await page.locator('#style-btn').click(); await expect(page.locator('#art-preview img')).toBeVisible(); await page.locator('#accept-art').click(); }
}
test('T22 saved artwork survives reload, while original photo stays session-only', async ({ page }) => {
  await boot(page); await reading(page, true); await page.locator('#save-book').click(); await expect(page.locator('#message')).toContainText('보관했어요');
  await page.reload(); await page.waitForFunction(() => window.TAW_READY);
  await expect(page.locator('#photo-status')).toHaveText(''); await page.locator('#library-btn').click();
  await page.locator('#books .card button').first().click(); await expect(page.locator('#book-dialog')).toBeVisible();
  await expect(page.locator('#book-content img')).toBeVisible(); await expect(page.locator('#book-content')).toContainText(passages[0]); await expect(page.locator('#book-note')).toContainText('보관 당시');
});
test('T23 unsaved artwork is not restored but prepared text is', async ({ page }) => {
  await boot(page); await reading(page, true); await page.reload(); await page.waitForFunction(() => window.TAW_READY);
  await page.locator('#nav-preview').click(); await page.locator('#open-bedtime').click(); await expect(page.locator('#story')).toContainText(passages[0]);
  await expect(page.locator('#reading-art img')).toHaveCount(0);
});
test('T24 storage failure cannot display saved-book success', async ({ page }) => {
  await boot(page); await reading(page);
  await page.evaluate(() => { window.TawStorage.saveBook = async () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
  await page.locator('#save-book').click(); await expect(page.locator('#message')).toContainText('완료하지 못했어요'); await expect(page.locator('#message')).not.toContainText('보관했어요');
});
test('T25 individual deletion preserves current record; delete-all clears legacy and books', async ({ page }) => {
  await boot(page); await reading(page); await page.locator('#save-book').click(); await expect(page.locator('#message')).toContainText('보관했어요');
  await page.locator('#nav-capture').click(); await page.locator('#library-btn').click(); page.on('dialog', d => d.accept());
  await page.getByRole('button', { name: '이 보관본 삭제', exact: true }).click(); await expect(page.locator('#books')).toContainText('아직 내용이 없어요');
  expect((await stored(page)).memoText).toBe(memo);
  await page.evaluate(() => localStorage.setItem('taw-day-v1', 'legacy-private'));
  await page.locator('#delete-all').click(); await expect(page.locator('#memo-input')).toHaveValue('');
  expect(await page.evaluate(() => localStorage.getItem('taw-day-v1'))).toBeNull(); expect((await stored(page)).candidates).toHaveLength(0);
});
test('T26/T27 export is self-contained, private fields excluded, and opens in a fresh browser context', async ({ page, browser }, testInfo) => {
  await boot(page); await reading(page, true);
  await page.locator('#testimony-input').fill('PRIVATE_CHILD_RESPONSE'); await page.locator('#save-testimony').click();
  await page.locator('#export-book').click(); await expect(page.locator('#book-note')).toContainText('전체 검증 기록은 아니에요');
  const download = page.waitForEvent('download'); await page.locator('#download-book').click(); const result = await download;
  const file = testInfo.outputPath(result.suggestedFilename()); await result.saveAs(file);
  const fs = require('node:fs'); const html = fs.readFileSync(file, 'utf8');
  expect(html).not.toMatch(/PRIVATE_CHILD_RESPONSE|<script|https?:\/\//); expect(html).toContain('data:image/png;base64,');
  const fresh = await browser.newContext(); const opened = await fresh.newPage(); const external = [];
  opened.on('request', r => { if (/^https?:/.test(r.url())) external.push(r.url()); });
  await opened.goto(require('node:url').pathToFileURL(file).href); await expect(opened.locator('body')).toContainText(passages[0]);
  await expect(opened.locator('img')).toBeVisible(); expect(external).toHaveLength(0); await fresh.close();
});
test('T37 actual service-worker shell reloads offline without caching user media', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'allow' }); const page = await context.newPage();
  await page.goto('http://127.0.0.1:4173'); await page.waitForFunction(() => window.TAW_READY);
  const cached = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const names = await caches.keys(); const cache = await caches.open(names.find(n => n.startsWith('taw-shell-')));
    return (await cache.keys()).map(r => r.url);
  });
  expect(cached.some(url => url.endsWith('/books.js'))).toBe(true);
  expect(cached.some(url => /\.(png|jpe?g|webp)$/.test(url))).toBe(false);
  await context.setOffline(true); await page.reload(); await page.waitForFunction(() => window.TAW_READY);
  await expect(page.locator('footer')).toContainText('shell v18'); await context.close();
});
test('voice conversion failure recovers, and a late transcript cannot overwrite edited input', async ({ page }) => {
  await boot(page);
  await page.locator('summary[data-copy=voice]').click();
  await page.locator('#voice-input').setInputFiles({ name: 'invalid.m4a', mimeType: 'audio/mp4', buffer: Buffer.from('not audio') });
  await page.locator('#transcribe-btn').click(); await expect(page.locator('#message')).toContainText('완료하지 못했어요'); await expect(page.locator('#transcribe-btn')).toBeEnabled();
  const wav = Buffer.alloc(44 + 4800); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4800, 40);
  const pending = deferred(), started = deferred();
  await page.route('**/api/voice', async route => { expect(route.request().headers()['content-type']).toContain('multipart/form-data'); started.resolve(); await pending.promise; await route.fulfill({ json: { transcript: '오래된 음성 결과' } }); });
  await page.locator('#voice-input').setInputFiles({ name: 'silence.wav', mimeType: 'audio/wav', buffer: wav }); await page.locator('#transcribe-btn').click(); await started.promise;
  await page.locator('#memo-input').fill('부모가 새로 입력한 메모'); pending.resolve();
  await expect(page.locator('#memo-input')).toHaveValue('부모가 새로 입력한 메모'); await expect(page.locator('#transcribe-btn')).toBeEnabled();
});
test('unsupported translations use readable English and preserve the chosen locale', async ({ page }) => {
  await boot(page); await page.locator('#lang-select').selectOption('ja');
  await expect(page.locator('#extract-btn')).toHaveText('Start preparing'); await expect(page.locator('#language-note')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
});
test('photo replacement removes approved old artwork and old identity decisions', async ({ page }) => {
  await boot(page); await reading(page, true); await expect(page.locator('#reading-art img')).toBeVisible();
  await page.locator('#nav-capture').click(); await page.locator('#photo-input').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  expect((await stored(page)).identity).toEqual({ people: 'unconfirmed', animals: 'unconfirmed' });
  await expect(page.locator('#art-preview img')).toHaveCount(0);
});

// v18: diagnostics and unsaved-only retry. These do not reproduce or fix the field report's root cause.
function failNextSave(page) {
  return page.evaluate(() => {
    const S = window.TawStorage, original = S.save; let pending = true; window.tawSaveCalls = 0;
    S.save = (...args) => {
      window.tawSaveCalls++;
      if (!pending) return original(...args); pending = false;
      const e = Error('Storage failed'); e.name = 'StorageError'; e.cause = new DOMException('Quota exceeded', 'QuotaExceededError');
      return Promise.reject(e);
    };
  });
}
async function failFirstOpen(page) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('taw-fail-open')) return;
    sessionStorage.removeItem('taw-fail-open');
    const original = IDBFactory.prototype.open; let first = true;
    IDBFactory.prototype.open = function (...args) {
      if (first && args[0] === 'taw-v2') { first = false; throw new DOMException('Simulated open failure', 'UnknownError'); }
      return original.apply(this, args);
    };
  });
}
const unsavedText = '저장하지 못했어요. 이 탭을 닫기 전에 내용을 내려받으세요.', conflictText = '다른 탭에서 기록이 바뀌었어요';
test('v18 unsaved failure keeps its cause, shows a code, and Retry save stores the current record', async ({ page }) => {
  const logs = []; page.on('console', m => logs.push(m.text()));
  await boot(page); await failNextSave(page);
  await page.locator('#memo-input').fill('저장 실패 후 남은 메모');
  await expect(page.locator('#storage-text')).toHaveText(unsavedText);
  await expect(page.locator('#storage-code')).toHaveText('save-failed: StorageError / QuotaExceededError');
  await expect(page.locator('#retry-save')).toBeVisible(); await expect(page.locator('#download-draft')).toBeVisible(); await expect(page.locator('#reload-record')).toBeVisible();
  await page.locator('#memo-input').fill('재시도 전에 고친 메모');
  expect((await stored(page)).memoText).toBe('');
  await page.locator('#retry-save').click();
  await expect(page.locator('#storage-warning')).toBeHidden(); await expect(page.locator('#save-status')).toContainText('저장됨');
  expect((await stored(page)).memoText).toBe('재시도 전에 고친 메모');
  expect(logs.some(l => l.startsWith('[taw] storage save failed'))).toBe(true);
  expect(logs.join('\n')).not.toMatch(/저장 실패 후 남은 메모|재시도 전에 고친 메모/);
});
test('v18 Retry save switches to the conflict flow when another tab saved meanwhile', async ({ page, context }) => {
  const logs = []; page.on('console', m => logs.push(m.text()));
  await boot(page); await failNextSave(page);
  await page.locator('#memo-input').fill('이 탭의 미저장 내용');
  await expect(page.locator('#retry-save')).toBeVisible();
  const other = await context.newPage(); await boot(other);
  await other.locator('#memo-input').fill('다른 탭이 나중에 저장'); await expect(other.locator('#save-status')).toContainText('저장됨');
  const before = await page.evaluate(() => window.tawSaveCalls);
  await page.locator('#retry-save').click();
  await expect(page.locator('#storage-text')).toContainText(conflictText);
  // Boundary: the version check stops the retry before any write is attempted (not merely CAS rejecting it).
  expect(await page.evaluate(() => window.tawSaveCalls)).toBe(before);
  expect(logs.some(l => l.startsWith('[taw] retry stopped: stored version changed'))).toBe(true);
  await expect(page.locator('#retry-save')).toBeHidden(); await expect(page.locator('#storage-code')).toBeHidden();
  await expect(page.locator('#download-draft')).toBeVisible();
  expect((await stored(page)).memoText).toBe('다른 탭이 나중에 저장');
  await page.locator('#reload-record').click(); await expect(page.locator('#memo-input')).toHaveValue('다른 탭이 나중에 저장');
  await expect(page.locator('#storage-warning')).toBeHidden();
});
test('v18 conflict banner offers only Download and Load latest, never Retry save', async ({ page, context }) => {
  await boot(page); const other = await context.newPage(); await boot(other);
  await other.locator('#memo-input').fill('다른 탭에서 먼저 저장'); await expect(other.locator('#save-status')).toContainText('저장됨');
  await page.locator('#memo-input').fill('오래된 탭의 내용');
  await expect(page.locator('#storage-text')).toContainText(conflictText);
  await expect(page.locator('#retry-save')).toBeHidden(); await expect(page.locator('#storage-code')).toBeHidden();
  await expect(page.locator('#download-draft')).toBeVisible(); await expect(page.locator('#reload-record')).toBeVisible();
  expect((await stored(page)).memoText).toBe('다른 탭에서 먼저 저장');
});
test('v18 open failure shows the open code; Retry save opens storage and saves into an empty store', async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('taw-seen')) { sessionStorage.setItem('taw-seen', '1'); sessionStorage.setItem('taw-fail-open', '1'); } });
  await failFirstOpen(page); await boot(page);
  await expect(page.locator('#storage-text')).toHaveText(unsavedText); await expect(page.locator('#storage-code')).toHaveText('open');
  await page.locator('#memo-input').fill('열기 실패 중 입력');
  await page.locator('#retry-save').click();
  await expect(page.locator('#storage-warning')).toBeHidden();
  expect((await stored(page)).memoText).toBe('열기 실패 중 입력');
});
test('v18 after an open failure, Retry save never overwrites an existing stored record', async ({ page }) => {
  await failFirstOpen(page); await boot(page);
  await page.locator('#memo-input').fill('이미 저장된 기록'); await expect(page.locator('#save-status')).toContainText('저장됨');
  await page.evaluate(() => sessionStorage.setItem('taw-fail-open', '1'));
  await page.reload(); await page.waitForFunction(() => window.TAW_READY);
  await expect(page.locator('#storage-code')).toHaveText('open');
  await page.locator('#memo-input').fill('열기 실패 중 새 입력');
  await page.evaluate(() => { const S = window.TawStorage, original = S.save; window.tawSaveCalls = 0; S.save = (...a) => { window.tawSaveCalls++; return original(...a); }; });
  await page.locator('#retry-save').click();
  await expect(page.locator('#storage-text')).toContainText(conflictText); await expect(page.locator('#retry-save')).toBeHidden();
  expect(await page.evaluate(() => window.tawSaveCalls)).toBe(0);
  expect((await stored(page)).memoText).toBe('이미 저장된 기록');
  await page.locator('#reload-record').click(); await expect(page.locator('#memo-input')).toHaveValue('이미 저장된 기록');
});
