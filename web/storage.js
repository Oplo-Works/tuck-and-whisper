/* Transactional compare-and-swap for tabs. Legacy localStorage is read-only. */
(function (root) {
  'use strict';
  const booksAPI = () => typeof module === 'object' ? require('./books.js') : root.TawBooks;
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
  // Non-conflict aborts keep the browser's reason (e.g. QuotaExceededError) as `cause`.
  function storageError(conflict, message, cause) {
    const e = Error(message); e.name = conflict ? 'ConflictError' : 'StorageError';
    if (!conflict && cause) e.cause = cause;
    return e;
  }
  function save(db, record, expected, clearBooks = false, artwork) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(clearBooks ? ['current', 'books'] : ['current'], 'readwrite');
      const store = tx.objectStore('current'), req = store.get('day'); let conflict = false, failure = null;
      req.onerror = () => { failure = failure || req.error; };
      req.onsuccess = () => {
        if ((req.result ? req.result.version : 0) !== expected) { conflict = true; tx.abort(); return; }
        try {
          // Generated artwork and its exact source revision commit atomically.
          // Originals never enter this field; older callers remain compatible.
          const entry = { version: expected + 1, record };
          if (artwork !== undefined) entry.artwork = artwork;
          const put = store.put(entry, 'day'); put.onerror = () => { failure = failure || put.error; };
          if (clearBooks) tx.objectStore('books').clear();
        } catch (e) { failure = e; tx.abort(); }
      };
      tx.oncomplete = () => resolve(expected + 1);
      tx.onabort = () => reject(storageError(conflict, conflict ? 'Conflict' : 'Storage failed', failure || tx.error));
      tx.onerror = () => {}; // onabort reports exactly once
    });
  }
  function books(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('books'), req = tx.objectStore('books').getAll();
      tx.oncomplete = () => { try { resolve(req.result.map(decodeBook).map(booksAPI().normalize).sort(booksAPI().compare)); } catch (e) { reject(e); } };
      tx.onabort = () => reject(tx.error); tx.onerror = () => {};
    });
  }
  function decodeBook(book) {
    if (book.artworkEncoding !== 'bytes-v1') return book; // Legacy Blob books remain readable.
    const decode = image => image ? new Blob([image.bytes], { type: image.type }) : null;
    const { artworkEncoding, ...decoded } = book;
    decoded.artwork = decode(book.artwork);
    if (Array.isArray(book.paragraphs)) decoded.paragraphs = book.paragraphs.map(p => ({ ...p, artwork: decode(p.artwork) }));
    return decoded;
  }
  async function saveBook(db, book, expected) {
    // Store bytes rather than browser-managed Blob files, which can fail to
    // persist in WebKit. Finish reading before opening the CAS transaction.
    const encode = async image => image ? { type: image.type, bytes: await image.arrayBuffer() } : null;
    const storedBook = { ...book, artworkEncoding: 'bytes-v1', artwork: await encode(book.artwork) };
    if (Array.isArray(book.paragraphs)) storedBook.paragraphs = await Promise.all(book.paragraphs.map(async p => ({ ...p, artwork: await encode(p.artwork) })));
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['current', 'books'], 'readwrite'), req = tx.objectStore('current').get('day');
      let conflict = false, failure = null;
      req.onerror = () => { failure = failure || req.error; };
      req.onsuccess = () => {
        if (!req.result || req.result.version !== expected || req.result.record.dayId !== book.dayId || req.result.record.contentRevision !== book.revision ||
            JSON.stringify(req.result.record.story?.lines.map(l => l.text)) !== JSON.stringify(book.lines) || (req.result.record.question?.text || '') !== book.question ||
            (book.schemaVersion === 2 && ['title', 'eventDate', 'submittedAt'].some(k => booksAPI().metadata(req.result.record)[k] !== book[k]))) {
          conflict = true; tx.abort(); return;
        }
        try {
          const store = tx.objectStore('books'), all = store.getAll();
          all.onerror = () => { failure = failure || all.error; };
          all.onsuccess = () => {
            // Allocate a durable tie-breaker in the same transaction, even for identical timestamps.
            book.order = all.result.reduce((max, b) => Math.max(max, Number.isFinite(b.order) ? b.order : b.createdAt || 0), 0) + 1;
            storedBook.order = book.order;
            try { const add = store.add(storedBook); add.onerror = () => { failure = failure || add.error; }; }
            catch (e) { failure = e; tx.abort(); }
          };
        }
        catch (e) { failure = e; tx.abort(); }
      };
      tx.oncomplete = () => resolve(book.id);
      tx.onabort = () => reject(storageError(conflict, conflict ? 'Record changed; prepare again' : 'Book storage failed', failure || tx.error));
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
