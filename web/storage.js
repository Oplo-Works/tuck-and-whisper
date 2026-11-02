/* Transactional compare-and-swap for tabs. Legacy localStorage is read-only. */
(function (root) {
  'use strict';
  function open(factory = root.indexedDB) {
    return new Promise((resolve, reject) => {
      const request = factory.open('taw-v2', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('current'); db.createObjectStore('books', { keyPath: 'id' });
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('Storage update blocked; close older tabs.'));
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); resolve(db); };
    });
  }
  function load(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('current', 'readonly'), req = tx.objectStore('current').get('day');
      tx.oncomplete = () => resolve(req.result || { version: 0, record: null });
      tx.onerror = () => reject(tx.error);
    });
  }
  function save(db, record, expected, clearBooks = false) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(clearBooks ? ['current', 'books'] : ['current'], 'readwrite');
      const store = tx.objectStore('current'), req = store.get('day'); let conflict = false;
      req.onsuccess = () => {
        if ((req.result ? req.result.version : 0) !== expected) { conflict = true; tx.abort(); return; }
        store.put({ version: expected + 1, record }, 'day');
        if (clearBooks) tx.objectStore('books').clear();
      };
      tx.oncomplete = () => resolve(expected + 1);
      tx.onabort = () => { const e = Error(conflict ? 'Conflict' : 'Storage failed'); e.name = conflict ? 'ConflictError' : 'StorageError'; reject(e); };
      tx.onerror = () => {}; // onabort reports exactly once
    });
  }
  root.TawStorage = { open, load, save };
  if (typeof module === 'object') module.exports = root.TawStorage;
})(typeof globalThis === 'object' ? globalThis : this);
