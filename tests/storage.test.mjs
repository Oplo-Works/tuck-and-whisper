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
