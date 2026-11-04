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
  assert.deepEqual(await S.load(db), { version: 1, record: { marker: 'original' } }); db.close();
});
test('v18: a conflict carries no cause; a non-conflict abort keeps the browser cause and leaves data intact', async () => {
  const db = await S.open(new IDBFactory()); await S.save(db, { marker: 'original' }, 0);
  const conflict = await S.save(db, { marker: 'stale' }, 0).catch(e => e);
  assert.equal(conflict.name, 'ConflictError'); assert.equal(conflict.cause, undefined);
  // An uncloneable value makes put() throw inside the transaction: a non-version abort.
  const failed = await S.save(db, { marker: 'bad', fn() {} }, 1).catch(e => e);
  assert.equal(failed.name, 'StorageError'); assert.equal(failed.message, 'Storage failed');
  assert.equal(failed.cause?.name, 'DataCloneError');
  assert.deepEqual(await S.load(db), { version: 1, record: { marker: 'original' } }); db.close();
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
  assert.deepEqual(await S.load(db), { version: 1, record: { marker: 'original' }, artwork: art });
  await S.save(db, { marker: 'edited' }, 1, false, null);
  assert.equal((await S.load(db)).artwork, null);
  db.close();
});
