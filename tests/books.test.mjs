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
  const raw = await new Promise(resolve => { const tx = db.transaction('books'), req = tx.objectStore('books').get(book.id); tx.oncomplete = () => resolve(req.result); });
  assert.equal(raw.artworkEncoding, 'bytes-v1'); assert.ok(raw.artwork.bytes instanceof ArrayBuffer);
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

for (const kind of ['illustrated', 'text-only', 'mixed']) test('reopen and export every pair, title and event date: ' + kind, async () => {
  const factory = new IDBFactory(); let db = await S.open(factory);
  let r = W.input(W.create(), '첫째 장. 둘째 장. 셋째 장.');
  r = W.extract(r, { candidates: ['첫째 장.', '둘째 장.', '셋째 장.'].map(text => ({ text, quote: text, source: 'memo', grade: 'C' })) });
  for (const c of r.candidates) r = W.decide(r, c.id, 'confirmed');
  r = W.prepare(r); r.story = W.compose(r, 'story', null, false);
  r = W.bookDetails(r, { eventDate: '2026-10-29', title: '확정한 세 장' });
  const arts = Array.from({ length: 3 }, (_, i) => kind === 'text-only' || kind === 'mixed' && i === 1 ? null : new Blob(['ART' + i], { type: 'image/png' }));
  const book = B.snapshot(r, null, W, arts), version = await S.save(db, r, 0);
  await S.saveBook(db, book, version); db.close(); db = await S.open(factory);
  const loaded = (await S.books(db))[0]; assert.ok(await B.same(loaded, book));
  assert.deepEqual(loaded.paragraphs.map(p => p.order), [0, 1, 2]);
  assert.deepEqual(loaded.paragraphs.map(p => p.artStatus), arts.map(a => a ? 'illustrated' : 'text-only'));
  const data = arts.map(a => a ? 'data:image/png;base64,YQ==' : '');
  const html = B.html(loaded, '', 'ko', { art: '그림', note: '' }, data);
  assert.match(html, /<h1>확정한 세 장<\/h1>/); assert.match(html, /datetime="2026-10-29"/);
  assert.equal((html.match(/data-paragraph-order=/g) || []).length, 3);
  const positions = ['첫째 장.', '둘째 장.', '셋째 장.'].map(t => html.indexOf(t));
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
  const damaged = structuredClone(loaded); damaged.paragraphs[1].lines[0] = 'changed'; assert.equal(await B.same(damaged, book), false);
  if (arts[0]) { const badArt = structuredClone(loaded); badArt.paragraphs[0].artwork = new Blob(['FAIL'], { type: 'image/png' }); assert.equal(await B.same(badArt, book), false); }
  db.close();
});

test('event dates sort before save time; equal-date order persists even with identical timestamps', async () => {
  const factory = new IDBFactory(); let db = await S.open(factory), r = record(), version = 0;
  const saved = [];
  for (const date of ['2026-11-03', '2026-11-01', '2026-11-01']) {
    r = W.bookDetails(r, { eventDate: date }); version = await S.save(db, r, version);
    const book = B.snapshot(r, null, W); book.createdAt = 12345; await S.saveBook(db, book, version); saved.push(book);
  }
  db.close(); db = await S.open(factory);
  assert.deepEqual((await S.books(db)).map(b => b.id), [saved[1].id, saved[2].id, saved[0].id]);
  assert.deepEqual(saved.map(b => b.order), [1, 2, 3]); db.close();
});

test('legacy flat and paired books load without rewriting or losing text and art', async () => {
  const db = await S.open(new IDBFactory()), r = record(); await S.save(db, r, 0);
  const original = { id: 'old-flat', dayId: r.dayId, revision: r.contentRevision, lines: ['옛 이야기.'], question: '', createdAt: new Date(2025, 1, 2).getTime(), artwork: new Blob(['old-art'], { type: 'image/png' }) };
  const paired = { ...original, id: 'old-pairs', paragraphs: [{ lines: ['옛 이야기.'], artwork: original.artwork }, { lines: ['글만 있는 장.'], artwork: null }], lines: ['옛 이야기.', '글만 있는 장.'] };
  await new Promise((resolve, reject) => { const tx = db.transaction('books', 'readwrite'); tx.objectStore('books').add(original); tx.objectStore('books').add(paired); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  const books = await S.books(db); assert.equal(books.length, 2);
  for (const b of books) { assert.equal(b.title, '옛 이야기.'); assert.equal(b.eventDate, '2025-02-02'); assert.deepEqual(b.paragraphs.flatMap(p => p.lines), b.lines); }
  assert.equal(await books[0].artwork.text(), 'old-art'); assert.equal(books[1].paragraphs[1].artStatus, 'text-only');
  const raw = await new Promise(resolve => { const tx = db.transaction('books'), q = tx.objectStore('books').get('old-flat'); tx.oncomplete = () => resolve(q.result); });
  assert.equal(raw.title, undefined); assert.equal(raw.paragraphs, undefined); db.close();
});

test('concurrent metadata edit cannot save a stale title or event date', async () => {
  const db = await S.open(new IDBFactory()); let r = W.bookDetails(record()), version = await S.save(db, r, 0);
  const book = B.snapshot(r, null, W);
  for (const patch of [{ title: '새 제목' }, { eventDate: '2026-09-01' }]) {
    r = W.bookDetails(r, patch); version = await S.save(db, r, version);
    await assert.rejects(S.saveBook(db, book, version), { name: 'ConflictError' });
  }
  assert.equal((await S.books(db)).length, 0); db.close();
});
