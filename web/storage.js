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
  function books(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('books'), req = tx.objectStore('books').getAll();
      tx.oncomplete = () => resolve(req.result.sort((a, b) => b.createdAt - a.createdAt)); tx.onerror = () => reject(tx.error);
    });
  }
  function saveBook(db, book, expected) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['current', 'books'], 'readwrite'), req = tx.objectStore('current').get('day');
      let conflict = false;
      req.onsuccess = () => {
        if (!req.result || req.result.version !== expected || req.result.record.dayId !== book.dayId || req.result.record.contentRevision !== book.revision ||
            JSON.stringify(req.result.record.story?.lines.map(l => l.text)) !== JSON.stringify(book.lines) || (req.result.record.question?.text || '') !== book.question) {
          conflict = true; tx.abort(); return;
        }
        tx.objectStore('books').add(book);
      };
      tx.oncomplete = () => resolve(book.id);
      tx.onabort = () => { const e = Error(conflict ? 'Record changed; prepare again' : 'Book storage failed'); e.name = conflict ? 'ConflictError' : 'StorageError'; reject(e); };
      tx.onerror = () => {};
    });
  }
  function deleteBook(db, id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('books', 'readwrite'); tx.objectStore('books').delete(id);
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => {};
    });
  }
  root.TawStorage = { open, load, save, books, saveBook, deleteBook };
  if (typeof module === 'object') module.exports = root.TawStorage;
})(typeof globalThis === 'object' ? globalThis : this);
