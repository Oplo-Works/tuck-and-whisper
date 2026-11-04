import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import S from '../web/storage.js';
test('simultaneous CAS saves cannot both overwrite the same version', async () => {
  const factory = new IDBFactory(), a = await S.open(factory), b = await S.open(factory);
  const results = await Promise.allSettled([S.save(a, { marker: 'a' }, 0), S.save(b, { marker: 'b' }, 0)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.name, 'ConflictError');
  assert.equal((await S.load(a)).version, 1); a.close(); b.close();
});
test('a failed write leaves previous data and version intact', async () => {
  const db = await S.open(new IDBFactory()); await S.save(db, { marker: 'original' }, 0);
  await assert.rejects(S.save(db, { marker: 'stale' }, 0), { name: 'ConflictError' });
  assert.deepEqual(await S.load(db), { version: 1, record: { marker: 'original' }, archived: null }); db.close();
});
test('v18: a conflict carries no cause; a non-conflict abort keeps the browser cause and leaves data intact', async () => {
  const db = await S.open(new IDBFactory()); await S.save(db, { marker: 'original' }, 0);
  const conflict = await S.save(db, { marker: 'stale' }, 0).catch(e => e);
  assert.equal(conflict.name, 'ConflictError'); assert.equal(conflict.cause, undefined);
  // An uncloneable value makes put() throw inside the transaction: a non-version abort.
  const failed = await S.save(db, { marker: 'bad', fn() {} }, 1).catch(e => e);
  assert.equal(failed.name, 'StorageError'); assert.equal(failed.message, 'Storage failed');
  assert.equal(failed.cause?.name, 'DataCloneError');
  assert.deepEqual(await S.load(db), { version: 1, record: { marker: 'original' }, archived: null }); db.close();
});
test('v18: saveBook non-conflict abort keeps the request error as cause', async () => {
  const db = await S.open(new IDBFactory());
  await S.save(db, { dayId: 'd', contentRevision: 1, story: { lines: [{ text: 'a' }] }, question: null }, 0);
  const book = { id: 'b1', dayId: 'd', revision: 1, lines: ['a'], question: '', createdAt: 1 };
  assert.equal(await S.saveBook(db, book, 1), 'b1');
  const failed = await S.saveBook(db, book, 1).catch(e => e);
  assert.equal(failed.name, 'StorageError'); assert.equal(failed.cause?.name, 'ConstraintError');
  const conflict = await S.saveBook(db, Object.assign({}, book, { id: 'b2' }), 0).catch(e => e);
  assert.equal(conflict.name, 'ConflictError'); assert.equal(conflict.cause, undefined);
  assert.equal((await S.books(db)).length, 1); db.close();
});

test('generated draft artwork commits atomically with its matching record; conflict and failed write preserve both', async () => {
  const db = await S.open(new IDBFactory());
  const art = { key: 'day/revision/paragraphs', paragraphs: ['data:image/png;base64,aGVsbG8='] };
  await S.save(db, { marker: 'original' }, 0, false, art);
  await assert.rejects(S.save(db, { marker: 'stale' }, 0, false, { key: 'wrong' }), { name: 'ConflictError' });
  await assert.rejects(S.save(db, { marker: 'invalid', fn() {} }, 1, false, null), { name: 'StorageError' });
  assert.deepEqual(await S.load(db), { version: 1, record: { marker: 'original' }, archived: null, artwork: art });
  await S.save(db, { marker: 'edited' }, 1, false, null);
  assert.equal((await S.load(db)).artwork, null);
  db.close();
});

async function archivedFixture() {
  const db = await S.open(new IDBFactory());
  const r = { dayId: 'day', contentRevision: 1, story: { lines: [{ text: 'Synthetic story' }] }, question: null };
  await S.save(db, r, 0, false, { paragraphs: ['data:image/png;base64,AA=='] });
  await S.saveBook(db, { id: 'book', dayId: 'day', revision: 1, lines: ['Synthetic story'], question: '', createdAt: 1 }, 1);
  return db;
}
test('archived draft reset is atomic and never removes the saved book', async () => {
  const db = await archivedFixture();
  assert.equal(await S.markArchived(db, 'book', 1), true);
  const fresh = { dayId: 'fresh', memoText: '' };
  assert.deepEqual(await S.clearArchived(db, 1, fresh), { version: 2, record: fresh, archived: null });
  assert.equal((await S.load(db)).artwork, undefined); assert.equal((await S.books(db)).length, 1);
  db.close();
});
test('newer edits, missing books and unverified drafts cannot be cleared as archived', async () => {
  const db = await archivedFixture();
  assert.equal(await S.clearArchived(db, 1, {}), null);
  assert.equal(await S.markArchived(db, 'missing', 1), false);
  await S.markArchived(db, 'book', 1);
  await S.save(db, { dayId: 'day', contentRevision: 2, memoText: 'New work' }, 1);
  assert.equal(await S.markArchived(db, 'book', 1), false);
  assert.equal(await S.clearArchived(db, 1, {}), null);
  assert.equal((await S.load(db)).record.memoText, 'New work');
  db.close();
  const other = await archivedFixture(); await S.markArchived(other, 'book', 1); await S.deleteBook(other, 'book');
  assert.equal(await S.clearArchived(other, 1, {}), null); assert.equal((await S.load(other)).record.dayId, 'day'); other.close();
});
test('failed archive reset preserves draft, artwork, marker and saved book', async () => {
  const db = await archivedFixture(); await S.markArchived(db, 'book', 1); const before = await S.load(db);
  await assert.rejects(S.clearArchived(db, 1, { invalid() {} }));
  assert.deepEqual(await S.load(db), before); assert.equal((await S.books(db)).length, 1); db.close();
});
