import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import W from '../web/workflow.js';
import S from '../web/storage.js';
import B from '../web/books.js';
function record() {
  let r = W.input(W.create(), '우리의 하루.'); r = W.extract(r, { candidates: [{ text: '우리의 하루.', quote: '우리의 하루.', source: 'memo', grade: 'C' }] });
  r = W.prepare(W.decide(r, r.candidates[0].id, 'confirmed')); r.story = W.compose(r, 'story', null, false);
  r.question = W.question(r, 0, '{fact} 기억나?'); return r;
}
test('reading snapshot and export use an allowlist, escape markup, and reject external/SVG images', () => {
  const r = record(); r.testimony.push({ text: 'PRIVATE_CHILD_RESPONSE', at: 1 }); r.secret = 'PRIVATE_DEBUG';
  const book = B.snapshot(r, null, W); book.lines.push('<script>alert(1)</script>'); book.memoText = 'PRIVATE_MEMO';
  const html = B.html(book, '', 'ko', { title: '읽기', art: '그림', note: '읽기용 완성본' });
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script|PRIVATE_CHILD_RESPONSE|PRIVATE_DEBUG|PRIVATE_MEMO|https?:\/\//);
  assert.throws(() => B.html(book, 'data:image/svg+xml;base64,YQ==', 'ko', {}));
  assert.throws(() => B.html(book, 'https://example.com/p.png', 'ko', {}));
});
test('stale story cannot become a new saved book', () => {
  const r = record(); assert.throws(() => B.snapshot(W.include(r, r.candidates[0].id, false), null, W));
});
test('books persist a snapshot and Blob; later edits cannot rewrite it', async () => {
  const db = await S.open(new IDBFactory()), r = record(); let version = await S.save(db, r, 0);
  r.identity = { people: 'same', animals: 'same' };
  const book = B.snapshot(r, new Blob(['fake-image-for-storage-test'], { type: 'image/png' }), W);
  await S.saveBook(db, book, version); const loaded = (await S.books(db))[0];
  assert.equal(await loaded.artwork.text(), 'fake-image-for-storage-test'); assert.equal(loaded.lines[0], '우리의 하루.');
  version = await S.save(db, W.input(r, '새 메모'), version); assert.equal((await S.books(db))[0].lines[0], '우리의 하루.');
  await assert.rejects(S.saveBook(db, { ...book, id: 'stale' }, version), { name: 'ConflictError' });
  assert.equal((await S.books(db)).length, 1); db.close();
});
test('book snapshot keeps paragraph+artwork pairs and export interleaves them in order', async () => {
  let r = W.input(W.create(), '첫 단락이에요. 둘째 단락이에요.');
  r = W.extract(r, { candidates: ['첫 단락이에요.', '둘째 단락이에요.'].map(text => ({ text, quote: text, source: 'memo', grade: 'C' })) });
  for (const c of r.candidates) r = W.decide(r, c.id, 'confirmed');
  r = W.prepare(r); r.story = W.compose(r, 'story', [r.candidates[0].id], false);
  r.question = W.question(r, 0, '{fact} 기억나?'); r.identity = { people: 'same', animals: 'same' };
  r.testimony.push({ text: 'PRIVATE_CHILD_RESPONSE', at: 1 });
  const art1 = new Blob(['para-art-one'], { type: 'image/png' });
  const book = B.snapshot(r, null, W, [art1, null]);
  assert.equal(book.paragraphs.length, 2); assert.equal(book.paragraphs[0].lines[0], '첫 단락이에요.');
  assert.equal(book.paragraphs[1].artwork, null); assert.equal(await book.paragraphs[0].artwork.text(), 'para-art-one');
  const data = 'data:image/png;base64,iVBORw0KGgo=';
  const html = B.html(book, '', 'ko', { title: '읽기', art: '그림', note: '노트' }, [data, '']);
  assert.ok(html.indexOf('첫 단락이에요.') < html.indexOf('data:image/png') && html.indexOf('data:image/png') < html.indexOf('둘째 단락이에요.'));
  assert.doesNotMatch(html, /PRIVATE_CHILD_RESPONSE/);
  assert.throws(() => B.html(book, '', 'ko', { title: 't', art: 'a', note: 'n' }, ['https://example.com/x.png', '']));
  // Pairs persist through storage unchanged.
  const db = await S.open(new IDBFactory()); const version = await S.save(db, r, 0);
  await S.saveBook(db, book, version); const loaded = (await S.books(db))[0];
  assert.equal(loaded.paragraphs.length, 2); assert.equal(await loaded.paragraphs[0].artwork.text(), 'para-art-one');
  assert.equal(loaded.paragraphs[1].artwork, null); db.close();
});
test('snapshot save refuses a concurrent question edit; individual/all deletion are scoped', async () => {
  const db = await S.open(new IDBFactory()), r = record(), book = B.snapshot(r, null, W);
  let version = await S.save(db, r, 0); await S.saveBook(db, book, version);
  r.question.text = '변경된 질문'; version = await S.save(db, r, version);
  await assert.rejects(S.saveBook(db, { ...book, id: 'old-question' }, version), { name: 'ConflictError' });
  await S.deleteBook(db, book.id); assert.equal((await S.books(db)).length, 0); assert.equal((await S.load(db)).record.question.text, '변경된 질문');
  await S.saveBook(db, B.snapshot(r, null, W), version);
  await S.save(db, W.create(), version, true); assert.equal((await S.books(db)).length, 0); assert.equal((await S.load(db)).record.memoText, ''); db.close();
});
