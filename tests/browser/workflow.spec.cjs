const { test, expect } = require('@playwright/test');
const memo = '아이가 강아지를 좋아했어요. 들판에서 만나 들이라고 이름 지었어요. 엄마가 들이는 들이 엄마와 지내고 싶어 할 거라고 말했어요.';
const passages = memo.split(/(?<=\.) /);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGNomLAAiBggFAAuzgbBPIwuuwAAAABJRU5ErkJggg==';
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
async function boot(page, hooks = {}) {
  const requests = [];
  await page.addInitScript(() => localStorage.setItem('taw-lang', 'ko'));
  // Fail closed: every non-local request must be handled by a mock registered below.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.route('https://taw-meta-proxy.minkyuthebuilder.workers.dev/**', async route => {
    const req = route.request(), body = req.postDataJSON(); requests.push({ url: req.url(), body });
    if (req.url().endsWith('/api/image')) {
      if (hooks.image) await hooks.image.promise;
      if (hooks.imageFail && (body.prompt || '').includes(hooks.imageFail)) return route.fulfill({ status: 500, json: { error: 'mock image failure' } });
      return route.fulfill({ json: { data: [{ b64_json: png }] } });
    }
    const system = body.messages[0].content;
    let result;
    if (system.startsWith('Extract')) {
      if (hooks.extract) await hooks.extract.promise;
      result = { candidates: (hooks.passages || passages).map(text => ({ text, quote: text, source: 'memo', grade: 'B' })).concat({ text: '사진에 작은 강아지가 보여요.', source: 'photo', grade: 'C' }), unknowns: ['기분은 어떨까?'] };
    } else {
      if (system.includes('bedtime') && hooks.story) await hooks.story.promise;
      if (system.includes('briefing') && hooks.briefing) await hooks.briefing.promise;
      const facts = JSON.parse(body.messages[1].content);
      if (hooks.invalid) result = { ids: ['FORBIDDEN'] }; else if (hooks.arrange) result = { ids: hooks.arrange(facts) }; else result = { ids: facts.map(f => f.id) };
    }
    await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(result) } }] } });
  });
  await page.goto('/'); await page.waitForFunction(() => window.TAW_READY);
  return requests;
}
async function setLanguage(page, language) {
  await page.locator('#settings-open').click();
  await page.locator('#lang-select').selectOption(language);
  await page.locator('#settings-close').click();
}
async function toggleTheme(page) {
  await page.locator('#settings-open').click();
  await page.locator('#theme-toggle').click();
  await page.locator('#settings-close').click();
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

test('v26 (a,c,g) capture DOM, visual and keyboard order; reset is outside the input card', async ({ page }) => {
  await boot(page);
  await page.locator('summary[data-copy=voice]').click();
  const ids = ['photo-input', 'memo-input', 'voice-input', 'transcribe-btn', 'preparation-notes', 'extract-btn'];
  const positions = await page.evaluate(ids => ids.map(id => {
    const el = document.getElementById(id);
    return { id, top: el.getBoundingClientRect().top, index: [...document.querySelectorAll('*')].indexOf(el) };
  }), ids);
  for (let i = 1; i < positions.length; i++) {
    expect(positions[i].index).toBeGreaterThan(positions[i - 1].index);
    expect(positions[i].top).toBeGreaterThan(positions[i - 1].top);
  }
  await expect(page.locator('#memo-section #memo-input')).toHaveCount(1);
  await expect(page.locator('#memo-section #voice-input')).toHaveCount(1);
  await expect(page.locator('#memo-section [data-copy=voiceReplace]')).toBeVisible();
  await page.locator('summary[data-copy=voice]').click();
  await expect(page.locator('[data-copy=voiceReplace]')).toBeVisible();
  await page.locator('#photo-input').focus(); await page.keyboard.press('Tab');
  await expect(page.locator('#memo-input')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.locator('summary[data-copy=voice]')).toBeFocused();
  expect(await page.locator('#extract-btn').evaluate(el => el === el.closest('.card').lastElementChild)).toBe(true);
  expect(await page.locator('#new-day-btn').evaluate(el => el.closest('.card'))).toBeNull();
  const gap = await page.evaluate(() => document.querySelector('.reset-actions').getBoundingClientRect().top - document.querySelector('#screen-capture .card').getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThanOrEqual(24);
  expect(await page.locator('.reset-actions').evaluate(el => getComputedStyle(el).borderTopStyle)).toBe('solid');
  await expect(page.locator('#screen-capture img, #screen-capture canvas, [id*=pulse], [class*=pulse]')).toHaveCount(0);
  await expect(page.locator('#screen-capture input[type=radio], #screen-capture [role=dialog]')).toHaveCount(0);
  await expect(page.locator('main > section')).toHaveCount(5);
  // Presentation may change; the five real workflow screens and reading controls remain.
  for (const id of ['story', 'reading-question', 'testimony-input', 'save-testimony', 'book-title', 'event-date', 'save-book']) {
    await expect(page.locator('#screen-bedtime #' + id)).toHaveCount(1);
  }
  await expect(page.locator('#settings-open')).toBeVisible();
});

for (const lang of ['ko', 'en']) test('v26 (b,c,e,f) clear labels and static guidance: ' + lang, async ({ page }) => {
  await boot(page); await setLanguage(page, lang);
  const ko = lang === 'ko';
  await expect(page.locator('#photo-section [data-copy=photoSkip]')).toContainText(ko ? '단락 그림 없이 글만' : 'paragraphs stay text-only');
  await expect(page.locator('[data-copy=captureHint]')).toContainText(ko ? '하루의 작은 순간' : 'A little moment from the day');
  await expect(page.locator('[data-copy=voiceReplace]')).toContainText(ko ? '덮어씁니다' : 'Converting audio will replace your current note');
  await expect(page.locator('#preparation-notes [data-copy=voiceCheck]')).toContainText(ko ? '메모를 먼저 확인' : 'Please double-check your note');
  await expect(page.locator('#new-day-btn')).toHaveText(ko ? '현재 초안 지우기' : 'Clear current draft');
  await expect(page.locator('#extract-btn')).toHaveText(ko ? '이야기 준비' : 'Prepare reading');
  await expect(page.locator('#prepare-btn')).toHaveText(ko ? '읽을 준비' : 'Prepare selected details');
  await expect(page.locator('#briefing-retry')).toHaveText(ko ? '브리핑 다시 만들기' : 'Remake briefing');
  await expect(page.locator('#story-retry')).toHaveText(ko ? '이야기 다시 만들기' : 'Remake story');
  await page.screenshot({ path: 'test-results/v26-capture-' + lang + '.png', fullPage: true });
  const dialog = page.waitForEvent('dialog');
  const click = page.locator('#new-day-btn').click();
  const confirmation = await dialog;
  expect(confirmation.message()).toContain(ko ? '초안의 메모, 확인 후보·결정, 질문·이야기 초안' : 'draft memo, review candidates and decisions, question and story drafts');
  expect(confirmation.message()).toContain(ko ? '보관한 이야기 전체' : 'all saved stories');
  await confirmation.dismiss(); await click;
});

test('v26 (d) identity instructions name the collapsed control; gate still requires both identities', async ({ page }) => {
  const requests = await boot(page); await review(page, true);
  await expect(page.locator('#identity-hint')).toBeVisible();
  await expect(page.locator('#identity-details')).not.toHaveAttribute('open');
  expect(await page.locator('#identity-details').evaluate(el => el.previousElementSibling.id)).toBe('identity-hint');
  await expect(page.locator('#identity-hint')).toContainText('아래 ‘사진을 이야기의 그림으로 쓰려면’을 열어');
  await page.screenshot({ path: 'test-results/v26-review-ko.png', fullPage: true });
  await page.locator('#prepare-btn').click(); await page.locator('#open-bedtime').click();
  await expect(page.locator('#story')).toContainText(passages[0]);
  await expect(page.locator('#para-art-hint')).toContainText('이 내용이 맞나요? 화면에서 ‘사진을 이야기의 그림으로 쓰려면’을 열어');
  await expect(page.locator('#para-art-all')).toBeDisabled();
  await setLanguage(page, 'en');
  await expect(page.locator('#identity-hint')).toContainText('open “Before using this photo as the story illustration” below');
  await expect(page.locator('#para-art-hint')).toContainText('open “Before using this photo as the story illustration” on the “Does this look right?” review screen');
  await page.locator('#nav-review').click(); await page.locator('#identity-details summary').click();
  await page.locator('#identity-people').selectOption('same');
  await expect(page.locator('#para-art-all')).toBeDisabled();
  await page.locator('#identity-animals').selectOption('absent');
  await page.locator('#prepare-btn').click(); await page.locator('#open-bedtime').click();
  await expect(page.locator('#para-art-all')).toBeEnabled();
  expect(requests.filter(r => r.url.endsWith('/api/image'))).toHaveLength(0);
});

for (const outcome of ['success', 'failure']) test('v26 voice pending warning and preparing disabled, then recovery: ' + outcome, async ({ page }) => {
  const requests = await boot(page); await page.locator('#memo-input').fill('DUMMY_TYPED_MEMO');
  await page.locator('summary[data-copy=voice]').click();
  const wav = Buffer.alloc(44 + 4800); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4800, 40);
  const pending = deferred(), started = deferred();
  await page.route('**/api/voice', async route => {
    started.resolve(); await pending.promise;
    await route.fulfill(outcome === 'success' ? { json: { transcript: 'DUMMY_CONVERTED_MEMO' } } : { status: 500, json: { error: 'mock failure' } });
  });
  await page.locator('#voice-input').setInputFiles({ name: 'dummy.wav', mimeType: 'audio/wav', buffer: wav });
  await page.locator('#transcribe-btn').click(); await started.promise;
  await expect(page.locator('#voice-progress')).toBeVisible(); await expect(page.locator('#voice-progress')).toContainText('음성을 글로 바꾸는 중');
  await expect(page.locator('#extract-btn')).toBeDisabled(); await expect(page.locator('#transcribe-btn')).toBeDisabled();
  await setLanguage(page, 'en');
  await expect(page.locator('#voice-progress')).toContainText('Converting audio to text');
  expect(requests).toHaveLength(0);
  pending.resolve();
  await expect(page.locator('#memo-input')).toHaveValue(outcome === 'success' ? 'DUMMY_CONVERTED_MEMO' : 'DUMMY_TYPED_MEMO');
  await expect(page.locator('#extract-btn')).toBeEnabled(); await expect(page.locator('#transcribe-btn')).toBeEnabled();
  await expect(page.locator('#voice-progress')).toBeHidden();
  if (outcome === 'failure') await expect(page.locator('#message')).toContainText('Could not finish');
});

test('v26 (b,e,h) no-photo text book survives reset and reload; cancel preserves current draft', async ({ page }) => {
  const requests = await boot(page); await reading(page);
  await expect(page.locator('#story img')).toHaveCount(0);
  await page.locator('#save-book').click(); await expect(page.locator('#book-save-status')).toContainText('글 완성본을 보관');
  await page.locator('#nav-capture').click();
  page.once('dialog', d => d.dismiss()); await page.locator('#new-day-btn').click();
  await expect(page.locator('#memo-input')).toHaveValue(memo); expect((await stored(page)).story.lines).toHaveLength(3);
  page.once('dialog', d => d.accept()); await page.locator('#new-day-btn').click();
  await expect(page.locator('#memo-input')).toHaveValue('');
  await expect.poll(async () => (await stored(page)).memoText).toBe('');
  const empty = await stored(page); expect(empty.candidates).toHaveLength(0); expect(empty.story).toBeNull();
  await page.reload(); await page.waitForFunction(() => window.TAW_READY);
  await page.locator('#nav-library').click(); await page.locator('#books .card button').first().click();
  await expect(page.locator('#book-content')).toContainText(passages[0]);
  await expect(page.locator('#book-content img')).toHaveCount(0);
  expect(requests.filter(r => r.url.endsWith('/api/image'))).toHaveLength(0);
});

test('v26 (h) export excludes raw photo, private memo, rejected candidate and child response', async ({ page }, testInfo) => {
  const requests = await boot(page);
  await page.locator('#photo-input').setInputFiles({ name: 'private-original.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.locator('#memo-input').fill(memo + ' PRIVATE_MEMO_ONLY'); await page.locator('#extract-btn').click();
  await expect(page.locator('#screen-review')).toBeVisible();
  for (let i = 0; i < 2; i++) await page.locator('#memo-candidates').getByRole('button', { name: '맞아요', exact: true }).nth(i).click();
  await page.locator('#memo-candidates').getByRole('button', { name: '아니에요', exact: true }).nth(2).click();
  await page.locator('#prepare-btn').click(); await page.locator('#open-bedtime').click();
  await expect(page.locator('#story')).toContainText(passages[0]); await expect(page.locator('#story')).not.toContainText(passages[2]);
  await page.locator('#testimony-input').fill('PRIVATE_CHILD_ONLY'); await page.locator('#save-testimony').click();
  await page.locator('#export-book').click(); const download = page.waitForEvent('download'); await page.locator('#download-book').click();
  const file = testInfo.outputPath('private-boundary.html'); await (await download).saveAs(file);
  const html = require('node:fs').readFileSync(file, 'utf8');
  expect(html).toContain(passages[0]); expect(html).not.toMatch(/PRIVATE_MEMO_ONLY|PRIVATE_CHILD_ONLY|private-original|data:image/);
  expect(html).not.toContain(passages[2]); expect(html).not.toContain(memo);
  const extraction = requests.find(r => r.body.messages?.[0].content.startsWith('Extract'));
  const originalPhoto = extraction.body.messages[1].content.find(part => part.type === 'image_url').image_url.url;
  expect(originalPhoto).toMatch(/^data:image\/jpeg/); expect(html).not.toContain(originalPhoto);
});

test('v26 all 23 fallback locales show the new English copy', async ({ page }) => {
  await boot(page);
  const languages = await page.locator('#lang-select option').evaluateAll(options => options.map(o => o.value).filter(v => !['ko', 'en'].includes(v)));
  expect(languages).toHaveLength(23);
  for (const lang of languages) {
    await setLanguage(page, lang);
    await expect(page.locator('#new-day-btn')).toHaveText('Clear current draft');
    await expect(page.locator('[data-copy=voiceReplace]')).toContainText('Converting audio will replace your current note');
    await expect(page.locator('[data-copy=photoSkip]')).toContainText('paragraphs stay text-only');
    await expect(page.locator('#language-note')).toBeVisible();
  }
});
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
  await boot(page); await reading(page, true); await page.locator('#save-book').click(); await expect(page.locator('#book-save-status')).toContainText('보관했어요');
  await page.reload(); await page.waitForFunction(() => window.TAW_READY);
  await expect(page.locator('#photo-status')).toHaveText(''); await page.locator('#nav-library').click();
  await page.locator('#books .card button').first().click(); await expect(page.locator('#book-dialog')).toBeVisible();
  await expect(page.locator('#book-content img')).toBeVisible(); await expect(page.locator('#book-content')).toContainText(passages[0]); await expect(page.locator('#book-snapshot')).toContainText('보관 당시');
});
test('T23 unsaved artwork is not restored but prepared text is', async ({ page }) => {
  await boot(page); await reading(page, true); await page.reload(); await page.waitForFunction(() => window.TAW_READY);
  await page.locator('#nav-preview').click(); await page.locator('#open-bedtime').click(); await expect(page.locator('#story')).toContainText(passages[0]);
  await expect(page.locator('#reading-art img')).toHaveCount(0);
});
test('T24 storage failure cannot display saved-book success', async ({ page }) => {
  await boot(page); await reading(page);
  await page.evaluate(() => { window.TawStorage.saveBook = async () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
  await page.locator('#save-book').click(); await expect(page.locator('#book-save-status')).toContainText('완성본 보관을 확인하지 못했어요'); await expect(page.locator('#book-save-status')).toContainText('Quota exceeded'); await expect(page.locator('#message')).not.toContainText('보관했어요');
});
test('T25 individual deletion preserves current record; delete-all clears legacy and books', async ({ page }) => {
  await boot(page); await reading(page); await page.locator('#save-book').click(); await expect(page.locator('#book-save-status')).toContainText('보관했어요');
  await page.locator('#nav-capture').click(); await page.locator('#nav-library').click(); page.on('dialog', d => d.accept());
  await page.getByRole('button', { name: '이 보관본 삭제', exact: true }).click(); await expect(page.locator('#books')).toContainText('아직 보관한 이야기가 없어요');
  expect((await stored(page)).memoText).toBe(memo);
  await page.evaluate(() => localStorage.setItem('taw-day-v1', 'legacy-private'));
  await page.locator('#library-management summary').click(); await page.locator('#delete-all').click(); await expect(page.locator('#memo-input')).toHaveValue('');
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
  expect(cached.some(url => new URL(url).pathname.endsWith('/books.js'))).toBe(true);
  expect(cached.some(url => /\.(png|jpe?g|webp)$/.test(url))).toBe(false);
  await context.setOffline(true); await page.reload(); await page.waitForFunction(() => window.TAW_READY);
  await expect(page.locator('footer')).toHaveText('build: settings-cache-fix (shell v34)'); await context.close();
});
for (const reset of ['new day', 'load latest', 'delete all']) {
  test('v19 voice selection clears on ' + reset, async ({ page, context }) => {
    await boot(page);
    await page.locator('summary[data-copy=voice]').click();
    await page.locator('#voice-input').setInputFiles({ name: 'dummy.m4a', mimeType: 'audio/mp4', buffer: Buffer.from('dummy audio') });
    await expect(page.locator('#transcribe-btn')).toBeEnabled();
    page.on('dialog', dialog => dialog.accept());
    if (reset === 'load latest') {
      const other = await context.newPage(); await boot(other);
      await other.locator('#memo-input').fill('Latest dummy memo');
      await expect(other.locator('#save-status')).toContainText('저장됨');
      await page.locator('#memo-input').fill('Stale dummy memo');
      await expect(page.locator('#storage-warning')).toBeVisible();
      await page.locator('#reload-record').click();
      await expect(page.locator('#memo-input')).toHaveValue('Latest dummy memo');
    } else if (reset === 'delete all') {
      await page.locator('#nav-library').click(); await page.locator('#library-management summary').click(); await page.locator('#delete-all').click();
    } else {
      await page.locator('#new-day-btn').click();
    }
    await expect.poll(() => page.locator('#voice-input').evaluate(input => input.files.length)).toBe(0);
    await expect(page.locator('#transcribe-btn')).toBeDisabled();
  });
}

test('v19 ordinary edits and candidate decisions preserve an untranscribed voice selection', async ({ page }) => {
  await boot(page);
  await page.locator('summary[data-copy=voice]').click();
  await page.locator('#voice-input').setInputFiles({ name: 'dummy.m4a', mimeType: 'audio/mp4', buffer: Buffer.from('dummy audio') });
  await review(page);
  await page.locator('#nav-capture').click();
  expect(await page.locator('#voice-input').evaluate(input => input.files.length)).toBe(1);
  await expect(page.locator('#transcribe-btn')).toBeEnabled();
});

for (const reset of ['new day', 'load latest', 'delete all']) {
  test('v20 testimony draft clears on ' + reset, async ({ page, context }) => {
    await boot(page);
    await page.locator('#nav-preview').click(); await page.locator('#open-bedtime').click();
    await page.locator('#testimony-input').fill('DUMMY_RESPONSE_FROM_PREVIOUS_DAY');
    await page.locator('#nav-capture').click();
    page.on('dialog', dialog => dialog.accept());
    if (reset === 'load latest') {
      const other = await context.newPage(); await boot(other);
      await other.locator('#memo-input').fill('Latest dummy memo');
      await expect(other.locator('#save-status')).toContainText('저장됨');
      await page.locator('#memo-input').fill('Stale dummy memo');
      await expect(page.locator('#storage-warning')).toBeVisible();
      await page.locator('#reload-record').click();
      await expect(page.locator('#memo-input')).toHaveValue('Latest dummy memo');
    } else if (reset === 'delete all') {
      await page.locator('#nav-library').click(); await page.locator('#library-management summary').click(); await page.locator('#delete-all').click();
      await expect(page.locator('#screen-capture')).toBeVisible();
    } else {
      await page.locator('#new-day-btn').click();
    }
    await page.locator('#nav-preview').click(); await page.locator('#open-bedtime').click();
    await expect(page.locator('#testimony-input')).toHaveValue('');
    await page.locator('#save-testimony').click();
    expect((await stored(page)).testimony).toHaveLength(0);
  });
}

test('v20 ordinary edits and candidate decisions preserve an unsaved testimony draft', async ({ page }) => {
  await boot(page);
  await page.locator('#nav-preview').click(); await page.locator('#open-bedtime').click();
  await page.locator('#testimony-input').fill('DUMMY_UNSAVED_RESPONSE');
  await page.locator('#nav-capture').click();
  await review(page);
  await page.locator('#prepare-btn').click(); await page.locator('#open-bedtime').click();
  await expect(page.locator('#testimony-input')).toHaveValue('DUMMY_UNSAVED_RESPONSE');
  expect((await stored(page)).testimony).toHaveLength(0);
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
  await boot(page); await setLanguage(page, 'ja');
  await expect(page.locator('#extract-btn')).toHaveText('Prepare reading'); await expect(page.locator('#language-note')).toBeVisible();
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

test('v24 entry has no sample control and reaches review through photo and memo input', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#load-sample-btn')).toHaveCount(0);
  await expect(page.locator('[data-copy=captureHint]')).toContainText('하루의 작은 순간');
  await review(page, true);
  expect((await stored(page)).mode).toBe('live');
  expect((await stored(page)).memoText).toBe(memo);
});
async function corruptField(page, field) {
  await page.evaluate(name => new Promise((resolve, reject) => {
    const open = indexedDB.open('taw-v2');
    open.onsuccess = () => { const db = open.result, tx = db.transaction('current', 'readwrite'), store = tx.objectStore('current'), g = store.get('day');
      g.onsuccess = () => { const v = g.result; v.record[name] = [null]; store.put(v, 'day'); };
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    open.onerror = () => reject(open.error);
  }), field);
}
for (const field of ['testimony', 'history']) {
  test('v21 damaged ' + field + ' entry boots to a recovery banner, not a broken render', async ({ page }) => {
    await boot(page); await page.locator('#memo-input').fill('손상 주입용 더미 메모');
    await expect(page.locator('#save-status')).toContainText('저장됨');
    await corruptField(page, field);
    await page.reload(); await page.waitForFunction(() => window.TAW_READY);
    await expect(page.locator('#storage-warning')).toBeVisible();
    await expect(page.locator('#storage-text')).toContainText('손상되어 읽을 수 없어요');
    await expect(page.locator('#start-fresh')).toBeVisible(); await expect(page.locator('#retry-save')).toBeHidden();
    await expect(page.locator('#nav-library')).toBeVisible();
    const quarantined = await page.evaluate(() => JSON.parse(localStorage.getItem('taw-quarantine-v2')));
    expect(quarantined.record[field]).toEqual([null]); expect(quarantined.record.memoText).toBe('손상 주입용 더미 메모');
    // The damaged record is still in place until the user explicitly recovers.
    expect((await stored(page)).memoText).toBe('손상 주입용 더미 메모');
    await page.locator('#start-fresh').click();
    await expect(page.locator('#storage-warning')).toBeHidden();
    const fresh = await stored(page); expect(fresh.memoText).toBe(''); expect(fresh[field]).toEqual([]);
    // The original is still preserved in quarantine after recovery.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('taw-quarantine-v2')).record.memoText)).toBe('손상 주입용 더미 메모');
    // And the app is fully usable afterwards.
    await page.locator('#memo-input').fill('복구 후 새 메모'); await expect(page.locator('#save-status')).toContainText('저장됨');
    expect((await stored(page)).memoText).toBe('복구 후 새 메모');
  });
}
function paraPrompts(requests) { return requests.filter(r => (r.body.prompt || '').includes('Confirmed passages:')).map(r => r.body.prompt); }
test('v22 stage1: one illustration per paragraph, paired and built only from confirmed passages', async ({ page }) => {
  const requests = await boot(page); await reading(page, true);
  await page.locator('#para-art-all').click();
  await expect(page.locator('#story .para-art img')).toHaveCount(3);
  const prompts = paraPrompts(requests); expect(prompts).toHaveLength(3);
  for (let i = 0; i < 3; i++) {
    expect(prompts[i]).toContain(passages[i]);
    for (let j = 0; j < 3; j++) if (j !== i) expect(prompts[i]).not.toContain(passages[j]);
    expect(prompts[i]).not.toContain('사진에 작은 강아지가 보여요.'); // unconfirmed photo candidate
    expect(prompts[i]).not.toContain('기분은 어떨까?'); // unknown, not a fact
    expect(prompts[i]).not.toContain(memo); // the raw memo is never the image input
  }
  expect(requests.filter(r => (r.body.prompt || '').includes('Confirmed passages:') && r.body.images && r.body.images.length === 1)).toHaveLength(3); // one shared photo-derived anchor
  const storyTexts = await page.locator('#story > p').allTextContents();
  expect(storyTexts.filter(x => passages.includes(x))).toEqual(passages); // paragraph texts unchanged
});
test('v22 stage1: paragraph failure is isolated and its redraw retries only that paragraph', async ({ page }) => {
  const requests = await boot(page, { imageFail: passages[1] }); await reading(page, true);
  await page.locator('#para-art-all').click();
  await expect(page.locator('#story .para-art img')).toHaveCount(2);
  await expect(page.locator('#story .para-art').nth(1)).toContainText('그림을 불러오지 못했어요');
  await expect(page.locator('#story .para-art').nth(0).locator('img')).toHaveCount(1);
  await expect(page.locator('#story .para-art').nth(2).locator('img')).toHaveCount(1);
  expect(paraPrompts(requests)).toHaveLength(3);
});
test('v22 stage1: a single paragraph gets a single illustration (no forced minimum)', async ({ page }) => {
  const requests = await boot(page, { arrange: facts => [facts[facts.length - 1].id] }); await reading(page, true);
  await page.locator('#para-art-all').click();
  await expect(page.locator('#story .para-art img')).toHaveCount(1);
  const prompts = paraPrompts(requests); expect(prompts).toHaveLength(1);
  for (const p of passages) expect(prompts[0]).toContain(p);
  // Redrawing it makes exactly one more call for the same paragraph.
  await page.locator('#story .para-art').nth(0).getByRole('button').click();
  await expect.poll(() => paraPrompts(requests).length).toBe(2);
  expect(paraPrompts(requests)[1]).toBe(prompts[0]);
});
test('v22 stage1: paragraph art stays disabled with guidance until the identity gate is answered', async ({ page }) => {
  const requests = await boot(page); await review(page, true);
  await page.locator('#prepare-btn').click(); await page.locator('#open-bedtime').click();
  await expect(page.locator('#story')).toContainText(passages[0]);
  await expect(page.locator('#para-art-all')).toBeDisabled();
  await expect(page.locator('#para-art-hint')).toContainText('같은지 확인해 주세요');
  await expect(page.locator('#story .para-art button')).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(page.locator('#story .para-art button').nth(i)).toBeDisabled();
  expect(paraPrompts(requests)).toHaveLength(0);
});
test('v22 stage1: saved and exported books keep every paragraph+illustration pair in order', async ({ page }, testInfo) => {
  await boot(page); await reading(page, true);
  await page.locator('#para-art-all').click(); await expect(page.locator('#story .para-art img')).toHaveCount(3);
  await page.locator('#testimony-input').fill('PRIVATE_CHILD_RESPONSE'); await page.locator('#save-testimony').click();
  await page.locator('#save-book').click(); await expect(page.locator('#book-save-status')).toContainText('보관했어요');
  const downloadPromise = page.waitForEvent('download'); await page.locator('#export-book').click(); await page.locator('#download-book').click();
  const download = await downloadPromise; const file = testInfo.outputPath(download.suggestedFilename()); await download.saveAs(file);
  const fs = require('node:fs'); const html = fs.readFileSync(file, 'utf8');
  expect((html.match(/data:image\/png;base64,/g) || []).length).toBe(4); // 1 approved single illustration + 3 paragraph illustrations
  const at = passages.map(p => html.indexOf(p)); expect(at[0]).toBeGreaterThan(-1); expect(at[0]).toBeLessThan(at[1]); expect(at[1]).toBeLessThan(at[2]);
  expect(html).not.toMatch(/PRIVATE_CHILD_RESPONSE|PRIVATE|https?:\/\//);
  await page.reload(); await page.waitForFunction(() => window.TAW_READY);
  await page.locator('#nav-library').click(); await page.locator('#books .card button').first().click();
  await expect(page.locator('#book-dialog')).toBeVisible(); await expect(page.locator('#book-content img')).toHaveCount(4);
  const bookText = await page.locator('#book-content').textContent();
  const inBook = passages.map(p => bookText.indexOf(p)); expect(inBook[0]).toBeGreaterThan(-1); expect(inBook[0]).toBeLessThan(inBook[1]); expect(inBook[1]).toBeLessThan(inBook[2]);
});
test('v22 stage2: six paragraphs are capped at five illustrations, the sixth stays text-only', async ({ page }) => {
  const six = ['첫째 장면이에요.', '둘째 장면이에요.', '셋째 장면이에요.', '넷째 장면이에요.', '다섯째 장면이에요.', '여섯째 장면이에요.'];
  const requests = await boot(page, { passages: six });
  await page.locator('#memo-input').fill(six.join(' '));
  await page.locator('#photo-input').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.locator('#extract-btn').click(); await expect(page.locator('#screen-review')).toBeVisible();
  for (let i = 0; i < 6; i++) await page.locator('#memo-candidates').getByRole('button', { name: '맞아요', exact: true }).nth(i).click();
  await page.locator('#identity-details summary').click(); await page.locator('#identity-people').selectOption('same'); await page.locator('#identity-animals').selectOption('same');
  await page.locator('#prepare-btn').click(); await page.locator('#open-bedtime').click();
  await expect(page.locator('#story')).toContainText(six[5]);
  await page.locator('#para-art-all').click();
  await expect(page.locator('#story .para-art img')).toHaveCount(5);
  expect(paraPrompts(requests)).toHaveLength(5);
  for (let i = 0; i < 5; i++) expect(paraPrompts(requests)[i]).toContain(six[i]);
  await expect(page.locator('#story .para-art').nth(5)).toContainText('글만 보여줘요');
  await expect(page.locator('#story .para-art').nth(5).locator('img')).toHaveCount(0);
  await expect(page.locator('#story')).toContainText(six[5]);
});
// v23: paragraph art is photo-required; memo/fact-check/text story are not.
const imageRequests = requests => requests.filter(r => r.url.endsWith('/api/image'));
test('v23 (a) without a photo, paragraph slots are text-only with guidance, no image call, and text story/save/export still work', async ({ page }, testInfo) => {
  const requests = await boot(page); await review(page); // no photo at all
  await page.locator('#prepare-btn').click(); await page.locator('#open-bedtime').click();
  await expect(page.locator('#story')).toContainText(passages[0]);
  await expect(page.locator('#story .para-art')).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect(page.locator('#story .para-art').nth(i)).toBeHidden();
    await expect(page.locator('#story .para-art').nth(i).locator('button')).toHaveCount(0);
    await expect(page.locator('#story .para-art').nth(i).locator('img')).toHaveCount(0);
  }
  await expect(page.locator('#para-art-all')).toBeDisabled();
  await expect(page.locator('#para-art-hint')).toContainText('지금은 글로 함께 읽어요');
  await expect(page.locator('#para-art-all')).toBeHidden();
  expect(imageRequests(requests)).toHaveLength(0); expect(paraPrompts(requests)).toHaveLength(0);
  // Text-only bookkeeping and export are unaffected by the missing photo.
  await page.locator('#save-book').click(); await expect(page.locator('#book-save-status')).toContainText('보관했어요');
  const downloadPromise = page.waitForEvent('download'); await page.locator('#export-book').click(); await page.locator('#download-book').click();
  const download = await downloadPromise; const file = testInfo.outputPath(download.suggestedFilename()); await download.saveAs(file);
  const html = require('node:fs').readFileSync(file, 'utf8');
  for (const p of passages) expect(html).toContain(p); expect(html).not.toContain('data:image/');
  expect(imageRequests(requests)).toHaveLength(0);
});
test('v23 (c) after reload the photo anchor is gone: slots stay text-only, no new image call, and a saved book keeps its pairs', async ({ page }) => {
  const requests = await boot(page); await reading(page, true);
  await page.locator('#para-art-all').click(); await expect(page.locator('#story .para-art img')).toHaveCount(3);
  await page.locator('#save-book').click(); await expect(page.locator('#book-save-status')).toContainText('보관했어요');
  const callsBefore = imageRequests(requests).length; expect(callsBefore).toBeGreaterThan(0);
  await page.reload(); await page.waitForFunction(() => window.TAW_READY);
  await expect(page.locator('#photo-status')).toHaveText(''); // original photo is session-only
  await page.locator('#nav-preview').click(); await page.locator('#open-bedtime').click();
  await expect(page.locator('#story')).toContainText(passages[0]); // prepared text story still reads
  await expect(page.locator('#para-art-all')).toBeDisabled();
  for (let i = 0; i < 3; i++) {
    await expect(page.locator('#story .para-art').nth(i)).toBeHidden();
    await expect(page.locator('#story .para-art').nth(i).locator('button')).toHaveCount(0);
    await expect(page.locator('#story .para-art').nth(i).locator('img')).toHaveCount(0);
  }
  expect(imageRequests(requests)).toHaveLength(callsBefore); // nothing new went out after the anchor vanished
  // The book saved before the reload keeps every paragraph+illustration pair.
  await page.locator('#nav-capture').click(); await page.locator('#nav-library').click();
  await page.locator('#books .card button').first().click(); await expect(page.locator('#book-dialog')).toBeVisible();
  await expect(page.locator('#book-content img')).toHaveCount(4); // 1 approved single + 3 paragraph illustrations
  const bookText = await page.locator('#book-content').textContent();
  const inBook = passages.map(p => bookText.indexOf(p)); expect(inBook[0]).toBeGreaterThan(-1); expect(inBook[0]).toBeLessThan(inBook[1]); expect(inBook[1]).toBeLessThan(inBook[2]);
});
test('v24 memo input without a photo keeps text-only paragraphs and makes no image call', async ({ page }) => {
  const requests = await boot(page);
  await review(page);
  expect((await stored(page)).mode).toBe('live'); await expect(page.locator('#photo-status')).toHaveText('');
  await page.locator('#prepare-btn').click(); await page.locator('#open-bedtime').click();
  await expect(page.locator('#story .para-art')).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect(page.locator('#story .para-art').nth(i)).toBeHidden();
    await expect(page.locator('#story .para-art').nth(i).locator('button')).toHaveCount(0);
  }
  await expect(page.locator('#para-art-all')).toBeDisabled();
  expect(imageRequests(requests)).toHaveLength(0);
});
test('v21 a normal record reloads without any recovery banner', async ({ page }) => {
  await boot(page); await page.locator('#memo-input').fill('정상 더미 메모');
  await expect(page.locator('#save-status')).toContainText('저장됨');
  await page.reload(); await page.waitForFunction(() => window.TAW_READY);
  await expect(page.locator('#storage-warning')).toBeHidden(); await expect(page.locator('#start-fresh')).toBeHidden();
  await expect(page.locator('#memo-input')).toHaveValue('정상 더미 메모'); await expect(page.locator('#nav-library')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('taw-quarantine-v2'))).toBeNull();
});

async function savedBooks(page) {
  return page.evaluate(async () => { const db = await window.TawStorage.open(); try { return (await window.TawStorage.books(db)).map(b => ({ ...b, artwork: b.artwork?.size || 0, paragraphs: b.paragraphs.map(p => ({ ...p, artwork: p.artwork?.size || 0 })) })); } finally { db.close(); } });
}
for (const kind of ['illustrated', 'text-only', 'mixed']) test('v25 durable day book survives reload, Chrome restart and saved export: ' + kind, async ({ playwright }, testInfo) => {
  const profile = testInfo.outputPath('chrome-profile');
  const launch = () => playwright.chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, baseURL: 'http://127.0.0.1:4173', serviceWorkers: 'block', viewport: { width: 418, height: 900 } });
  let context = await launch();
  try {
    let page = context.pages()[0]; const requests = await boot(page); await review(page, kind !== 'text-only');
    if (kind !== 'text-only') { await page.locator('#identity-details summary').click(); await page.locator('#identity-people').selectOption('same'); await page.locator('#identity-animals').selectOption('same'); }
    await page.locator('#prepare-btn').click(); await page.locator('#open-bedtime').click();
    await expect(page.locator('#book-title')).toHaveValue(passages[0]);
    const initial = await stored(page), submittedDate = await page.locator('#event-date').inputValue();
    expect(submittedDate).toBe(await page.evaluate(at => window.TawWorkflow.localDate(at), initial.submittedAt));
    await page.locator('#event-date').fill('2026-10-30');
    await expect(page.locator('#book-title')).toHaveValue(passages[0]);
    expect((await stored(page)).story.lines).toEqual(initial.story.lines);
    await page.locator('#book-title').fill('더미 하루의 세 장');
    if (kind === 'illustrated') { await page.locator('#para-art-all').click(); await expect(page.locator('#story .para-art img')).toHaveCount(3); }
    if (kind === 'mixed') { await page.locator('#story .para-art button').first().click(); await expect(page.locator('#story .para-art img')).toHaveCount(1); }
    await page.locator('#testimony-input').fill('PRIVATE_TESTIMONY'); await page.locator('#save-testimony').click();
    await page.locator('#save-book').click(); await expect(page.locator('#book-save-status')).toContainText('보관했어요');
    const expected = (await savedBooks(page))[0], count = kind === 'illustrated' ? 3 : kind === 'mixed' ? 1 : 0;
    expect(expected.paragraphs.map(p => p.lines).flat()).toEqual(passages);
    expect(expected.paragraphs.map(p => p.order)).toEqual([0, 1, 2]);
    expect(expected.paragraphs.filter(p => p.artStatus === 'illustrated')).toHaveLength(count);
    expect(expected.title).toBe('더미 하루의 세 장'); expect(expected.eventDate).toBe('2026-10-30');
    expect(expected.submittedAt).toBe(initial.submittedAt); expect(expected.createdAt).toBeGreaterThanOrEqual(initial.submittedAt);
    if (kind === 'text-only') expect(imageRequests(requests)).toHaveLength(0);
    await page.reload(); await page.waitForFunction(() => window.TAW_READY);
    expect((await savedBooks(page))[0]).toEqual(expected);
    await page.locator('#nav-preview').click(); await page.locator('#open-bedtime').click();
    await expect(page.locator('#reading-title')).toHaveText(expected.title); await expect(page.locator('#reading-date')).toHaveText(expected.eventDate);
    await context.close(); context = await launch(); page = context.pages()[0]; await boot(page);
    expect((await savedBooks(page))[0]).toEqual(expected);
    // Current input changes cannot change the saved book or prevent its export.
    await page.locator('#memo-input').fill('UNCONFIRMED_NEW_MEMO');
    await page.locator('#nav-library').click();
    await expect(page.locator('#books .book-date')).toHaveText(expected.eventDate);
    await page.locator('#books .card button').first().click();
    await expect(page.locator('#book-content h3')).toHaveText(expected.title); await expect(page.locator('#book-content img')).toHaveCount(count);
    const dl = page.waitForEvent('download'); await page.locator('#download-book').click();
    const download = await dl, file = testInfo.outputPath('saved.html'); await download.saveAs(file);
    const html = require('node:fs').readFileSync(file, 'utf8');
    expect(html).toContain('<h1>' + expected.title + '</h1>'); expect(html).toContain('datetime="2026-10-30"');
    expect((html.match(/data:image\/png;base64,/g) || [])).toHaveLength(count);
    expect((html.match(/data-paragraph-order=/g) || [])).toHaveLength(3);
    expect((html.match(/data-art-status="text-only"/g) || [])).toHaveLength(3 - count);
    const positions = passages.map(p => html.indexOf(p)); expect(positions[0]).toBeGreaterThan(-1); expect(positions[0]).toBeLessThan(positions[1]); expect(positions[1]).toBeLessThan(positions[2]);
    expect(html).not.toMatch(/PRIVATE_TESTIMONY|UNCONFIRMED_NEW_MEMO|https?:\/\//);
  } finally { await context.close(); }
});

test('v25 next actions, empty library, confirmed-only title and optional metadata use the real path', async ({ page }, testInfo) => {
  await boot(page);
  await expect(page.locator('nav button')).toHaveText(['기록', '확인', '함께 읽기', '보관함']);
  await expect(page.locator('#next-action')).toContainText('사진과 메모');
  await page.locator('#nav-library').click(); await expect(page.locator('#books')).toContainText('완성본을 보관');
  await page.locator('#nav-capture').click(); await page.locator('#memo-input').fill(memo);
  await expect(page.locator('#next-action')).toContainText('이야기를 준비');
  await page.locator('#extract-btn').click(); await expect(page.locator('#screen-review')).toBeVisible();
  await expect(page.locator('#next-action')).toContainText('확인해 주세요');
  // Leave the first passage unconfirmed; it must never suggest the title.
  await page.locator('#memo-candidates').getByRole('button', { name: '맞아요', exact: true }).nth(1).click();
  await expect(page.locator('#next-action')).toContainText('선택한 내용으로 읽기를 준비');
  await page.locator('#prepare-btn').click(); await expect(page.locator('#next-action')).toContainText('함께 읽어');
  await page.locator('#open-bedtime').click(); await expect(page.locator('#book-title')).toHaveValue(passages[1]);
  await expect(page.locator('#next-action')).toContainText('완성본을 보관');
  await page.locator('#book-title').fill(''); await page.locator('#event-date').fill('');
  await page.locator('#save-book').click(); await expect(page.locator('#book-save-status')).toContainText('보관했어요');
  const book = (await savedBooks(page))[0]; expect(book.title).toContain(book.eventDate); expect(book.lines).toEqual([passages[1]]);
  await expect(page.locator('#reading-title')).toHaveText(book.title); await expect(page.locator('#reading-date')).toHaveText(book.eventDate);
  await page.screenshot({ path: testInfo.outputPath('core-hardening-reading.png'), fullPage: true });
});

test('v25 readback detects lost text and offers retry', async ({ page }) => {
  await boot(page); await reading(page, true);
  await page.evaluate(() => { const original = window.TawStorage.books; window.TawStorage.books = async db => { const books = await original(db); books[0].paragraphs[0].lines[0] = 'CORRUPT'; return books; }; });
  await page.locator('#save-book').click(); await expect(page.locator('#book-save-status')).toContainText('Book verification failed');
  await expect(page.locator('#book-save-status')).toContainText('다시 보관'); await expect(page.locator('#message')).not.toContainText('보관했어요');
});


test('v32 starts at dusk; manual paper choice persists without changing in-flight evidence', async ({ page }) => {
  const pending = deferred(); const requests = await boot(page, { extract: pending });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dusk');
  await page.locator('#memo-input').fill(memo); await page.locator('#extract-btn').click();
  await toggleTheme(page); await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
  pending.resolve(); await expect(page.locator('#screen-review')).toBeVisible();
  expect(requests.filter(r => r.url.endsWith('/api/spark'))).toHaveLength(1);
  await expect(page.locator('#nav-review')).toHaveAttribute('aria-current', 'step');
  const before = await stored(page); await page.reload(); await page.waitForFunction(() => window.TAW_READY);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
  expect((await stored(page)).candidates).toEqual(before.candidates);
  await setLanguage(page, 'en'); await expect(page.locator('#theme-toggle')).toHaveAttribute('aria-label', 'Dusk');
  await toggleTheme(page); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dusk');
  await page.reload(); await page.waitForFunction(() => window.TAW_READY);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dusk');
});

test('v28 review distinguishes all four states and keeps excluded text out of reading', async ({ page }) => {
  await boot(page); await page.locator('#memo-input').fill(memo); await page.locator('#extract-btn').click();
  const cards = page.locator('#memo-candidates .candidate-card');
  await expect(cards.nth(0).locator('.state-badge')).toHaveText('미확인 · 사용 안 함');
  await cards.nth(0).getByRole('button', { name: '맞아요', exact: true }).click();
  await expect(cards.nth(0).locator('.state-badge')).toHaveText('확인됨 · 사용');
  await cards.nth(0).locator('input').uncheck();
  await expect(cards.nth(0).locator('.state-badge')).toHaveText('확인됨 · 이번 읽기 제외');
  await cards.nth(1).getByRole('button', { name: '아니에요', exact: true }).click();
  await expect(cards.nth(1).locator('.state-badge')).toHaveText('아니에요 · 사용 안 함');
  await cards.nth(2).getByRole('button', { name: '맞아요', exact: true }).click();
  await page.locator('#prepare-btn').click(); await page.locator('#open-bedtime').click();
  await expect(page.locator('#story')).toContainText(passages[2]);
  await expect(page.locator('#story')).not.toContainText(passages[0]); await expect(page.locator('#story')).not.toContainText(passages[1]);
  const r = await stored(page); expect(r.candidates[0].decision).toBe('confirmed'); expect(r.candidates[0].included).toBe(false);
});

test('v28 library cover reuses saved paragraph art after reload; raw photo is not stored', async ({ page }) => {
  const requests = await boot(page); await review(page, true);
  await page.locator('#identity-details summary').click(); await page.locator('#identity-people').selectOption('same'); await page.locator('#identity-animals').selectOption('same');
  await page.locator('#prepare-btn').click(); await page.locator('#open-bedtime').click(); await expect(page.locator('#story p').first()).toBeVisible();
  await page.locator('#para-art-all').click(); await expect(page.locator('#story .para-art img')).toHaveCount(3);
  await page.locator('#save-book').click(); await expect(page.locator('#book-save-status')).toContainText('보관했어요');
  const calls = requests.filter(r => r.url.endsWith('/api/image')).length;
  await page.reload(); await page.waitForFunction(() => window.TAW_READY); await page.locator('#nav-library').click();
  await expect(page.locator('#books .book-thumb')).toHaveCount(1); await expect(page.locator('#books .book-thumb')).toHaveJSProperty('naturalWidth', 2);
  await expect(page.locator('#nav-library')).toHaveAttribute('aria-current', 'step');
  await page.locator('#books .book-open').click(); await expect(page.locator('#book-content img')).toHaveCount(3);
  expect(requests.filter(r => r.url.endsWith('/api/image'))).toHaveLength(calls);
  const current = await stored(page); expect(current).not.toHaveProperty('photo'); expect(current).not.toHaveProperty('photoData');
});

test('v28 paper and dusk text palettes meet AA and mobile screens do not overflow', async ({ page }) => {
  await boot(page); await page.setViewportSize({ width: 320, height: 900 });
  for (const theme of ['paper', 'dusk']) {
    if ((await page.locator('html').getAttribute('data-theme')) !== theme) await toggleTheme(page);
    const contrasts = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      function luminance(hex) { const rgb = hex.trim().slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; }
      return [['--text','--bg'],['--dim','--bg'],['--dim','--card'],['--text','--inset'],['--accent-text','--accent'],['--danger','--card'],['--accent2','--good-bg']].map(([fg,bg]) => {
        const a=luminance(root.getPropertyValue(fg)), b=luminance(root.getPropertyValue(bg)); return { pair: fg + '/' + bg, ratio: (Math.max(a,b) + .05)/(Math.min(a,b) + .05) };
      });
    });
    for (const c of contrasts) expect(c.ratio, theme + ': ' + c.pair).toBeGreaterThanOrEqual(4.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('v28 responsive reading path preserves full text, controls and theme at 320/360/390/430px', async ({ page }) => {
  await boot(page); await review(page);
  await page.locator('#prepare-btn').click(); await expect(page.locator('#briefing')).toContainText(passages[2]);
  await page.locator('#open-bedtime').click(); await expect(page.locator('#story')).toContainText(passages[2]);
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['paper', 'dusk']) {
      if ((await page.locator('html').getAttribute('data-theme')) !== theme) await toggleTheme(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const text of passages) await expect(page.locator('#story')).toContainText(text);
      await expect(page.locator('#testimony-help')).toContainText('사실로 바꾸지 않아요');
      await expect(page.locator('#book-title')).toBeVisible();
      await page.screenshot({ path: 'test-results/v28-reading-' + width + '-' + theme + '.png', fullPage: true });
    }
  }
  await page.locator('#save-book').click(); await expect(page.locator('#book-save-status')).toContainText('보관했어요');
  await page.locator('#nav-library').click(); await expect(page.locator('#books .book-cover-empty')).toHaveCount(1);
  const colors = await page.locator('#books .book-open').evaluate(el => ({ open: getComputedStyle(el).color, body: getComputedStyle(document.body).color }));
  expect(colors.open).toBe(colors.body); // Only the separate deletion action uses the danger color.
  await page.screenshot({ path: 'test-results/v28-library-dusk.png', fullPage: true });
  await page.locator('#books .book-open').click(); await expect(page.locator('#book-content')).toContainText(passages[2]);
});

for (const width of [320, 360, 390, 430]) test('v33 mobile spacing, settings and reading flow: ' + width, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  await boot(page);
  const shots = [];
  async function capture(name) {
    await page.evaluate(() => scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/v33-${testInfo.project.name || 'chrome'}-${width}-${name}.png`, fullPage: !name.includes('dialog'), scale: 'css' });
    shots.push({ screen: name, height: await page.evaluate(() => document.documentElement.scrollHeight) });
  }
  const firstCard = await page.locator('#screen-capture>.card').boundingBox();
  expect(firstCard.y).toBeLessThan(280);
  await expect(page.locator('#library-btn')).toHaveCount(0);
  await capture('capture');
  await page.locator('#settings-open').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#settings-close')).toBeFocused();
  await expect(page.locator('#theme-toggle')).toHaveAccessibleName('종이');
  await capture('settings-dialog');
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-open')).toBeFocused();
  await page.locator('#nav-library').click(); await capture('empty-library');
  await page.getByRole('button', { name: '기록하러 가기' }).click();
  await review(page);
  const decisions = await page.locator('.candidate-actions button').evaluateAll(buttons => buttons.map(b => ({ width: b.getBoundingClientRect().width, height: b.getBoundingClientRect().height, overflowing: b.scrollWidth > b.clientWidth })));
  for (const b of decisions) { expect(b.height).toBeGreaterThanOrEqual(44); expect(b.height).toBeLessThan(60); expect(b.overflowing).toBe(false); }
  await capture('review');
  // Simulate the shorter visible area when a software keyboard is raised.
  await page.setViewportSize({ width, height: 400 });
  expect(await page.locator('.sticky-actions').evaluate(el => getComputedStyle(el).position)).toBe('static');
  await page.setViewportSize({ width, height: 844 });
  await page.locator('#prepare-btn').click(); await expect(page.locator('#briefing')).toContainText(passages[2]);
  await capture('preview');
  const short = await page.locator('#question-text').boundingBox();
  const longQuestion = Array(10).fill('어떤 장면이 기억나?').join('\n');
  await page.locator('#question-text').fill(longQuestion);
  const tall = await page.locator('#question-text').boundingBox(); expect(tall.height).toBeGreaterThan(short.height);
  await page.locator('#question-text').fill('어떤 장면이 기억나?');
  expect((await page.locator('#question-text').boundingBox()).height).toBeLessThan(tall.height);
  await page.locator('#open-bedtime').click(); await expect(page.locator('#story')).toContainText(passages[2]);
  await expect(page.locator('#para-art-all')).toBeHidden();
  await expect(page.locator('#story .para-art:visible')).toHaveCount(0);
  await expect(page.locator('#para-art-hint')).toContainText('지금은 글로 함께 읽어요');
  await capture('reading');
  await page.locator('#save-book').click(); await expect(page.locator('#book-save-status')).toContainText('보관했어요');
  await expect(page.locator('#message')).toBeHidden();
  await page.locator('#nav-library').click(); await capture('library');
  const list = await page.locator('#books').boundingBox(), tile = await page.locator('.book-tile').boundingBox();
  expect(Math.abs(list.width - tile.width)).toBeLessThan(2);
  await page.locator('.book-open').click(); await expect(page.locator('#book-content')).toContainText(passages[2]);
  await expect(page.locator('#book-content')).not.toContainText('이 단락은 그림 없이');
  await capture('saved-dialog');
  const dialog = page.locator('#book-dialog');
  await dialog.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('#download-book')).toBeInViewport();
  await expect(page.locator('#book-dialog form button')).toBeInViewport();
  await page.locator('#book-dialog form button').click(); await expect(page.locator('.book-open')).toBeFocused();
  require('node:fs').writeFileSync(`test-results/v33-${width}-metrics.json`, JSON.stringify({ width, firstCardTop: firstCard.y, shots }, null, 2));
});
