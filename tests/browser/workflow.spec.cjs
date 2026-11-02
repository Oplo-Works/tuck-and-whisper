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
