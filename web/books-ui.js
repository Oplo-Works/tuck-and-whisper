(function () {
  'use strict';
  let app, saving = false, exportSnapshot = null, exportRevision = null, exportDay = null, objectURLs = [];
  const $ = id => document.getElementById(id), S = window.TawStorage, B = window.TawBooks, W = window.TawWorkflow;
  function release() { for (const url of objectURLs) URL.revokeObjectURL(url); objectURLs = []; }
  function display(book) {
    release(); const area = $('book-content'); area.replaceChildren();
    if (book.artwork) { const url = URL.createObjectURL(book.artwork); objectURLs.push(url); area.append(app.image(url)); }
    for (const text of book.lines) area.append(app.node('p', text));
    if (book.question) area.append(app.node('blockquote', book.question));
  }
  async function currentBook() {
    const r = app.getRecord(), revision = r.contentRevision, dayId = r.dayId, approved = app.getArt();
    const image = await B.artwork(approved);
    if (app.getRecord().dayId !== dayId || app.getRecord().contentRevision !== revision || app.getArt() !== approved) throw Error('Story or illustration changed');
    return B.snapshot(app.getRecord(), image, W);
  }
  async function save() {
    if (saving || app.isBlocked()) return; saving = true; app.message(''); render();
    try {
      const book = await currentBook(); await app.flush();
      if (app.isBlocked()) throw Error('Unsaved changes');
      await S.saveBook(app.getDB(), book, app.getVersion());
      const readback = (await S.books(app.getDB())).find(b => b.id === book.id);
      if (!readback || readback.lines.join('\n') !== book.lines.join('\n') || (readback.artwork?.size || 0) !== (book.artwork?.size || 0)) throw Error('Book verification failed');
      app.message(app.t(book.artwork ? 'bookSaved' : 'bookSavedText'));
    } catch (e) { app.fail(e); }
    finally { saving = false; render(); }
  }
  async function library() {
    app.show('library'); const area = $('books'); area.replaceChildren();
    try {
      const books = await S.books(app.getDB());
      if (!books.length) area.append(app.node('p', app.t('empty')));
      for (const book of books) {
        const card = app.node('div', undefined, 'card'), open = app.node('button', new Date(book.createdAt).toLocaleString(window.TAW_I18N.getLanguage()));
        open.onclick = () => { display(book); $('book-note').textContent = app.t('past'); $('export-options').hidden = true; $('book-dialog').showModal(); };
        const remove = app.node('button', app.t('deleteBook'));
        remove.onclick = async () => { if (!confirm(app.t('deleteBook') + '?')) return; try { await S.deleteBook(app.getDB(), book.id); await library(); } catch (e) { app.fail(e); } };
        card.append(open, app.node('p', book.lines[0] || ''), remove); area.append(card);
      }
    } catch (e) { app.fail(e); }
  }
  async function previewExport() {
    try {
      app.message(''); const book = await currentBook(); exportSnapshot = book; exportDay = book.dayId; exportRevision = book.revision;
      display(book); $('book-note').textContent = app.t('exportHint'); $('export-options').hidden = false; $('export-text-only').checked = false;
      $('book-dialog').showModal();
    } catch (e) { app.fail(e); }
  }
  async function exportBook() {
    try {
      if (!exportSnapshot) return;
      const current = app.getRecord();
      if (current.dayId !== exportDay || current.contentRevision !== exportRevision || !W.validOutput(current, current.story) ||
          current.story.lines.map(l => l.text).join('\n') !== exportSnapshot.lines.join('\n') || (current.question?.text || '') !== exportSnapshot.question) throw Error('Story changed; preview again');
      const data = $('export-text-only').checked ? '' : await B.dataURL(exportSnapshot.artwork);
      // Check again after FileReader, which is asynchronous.
      if (app.getRecord() !== current) throw Error('Record changed; preview again');
      const html = B.html(exportSnapshot, data, window.TAW_I18N.getLanguage(), { title: app.t('bedtime'), art: app.t('photo'), note: app.t('exportHint') });
      app.download('tuck-and-whisper-' + new Date(exportSnapshot.createdAt).toISOString().slice(0, 10) + '.html', html, 'text/html');
      $('book-dialog').close();
    } catch (e) { app.fail(e); }
  }
  function render() {
    if (!app) return;
    $('library-btn').hidden = false; $('book-tools').hidden = false;
    const valid = W.validOutput(app.getRecord(), app.getRecord().story);
    $('save-book').disabled = saving || !valid || app.isBlocked() || !app.getDB();
    $('export-book').disabled = !valid;
  }
  function init(context) {
    app = context;
    $('save-book').onclick = save; $('library-btn').onclick = library; $('export-book').onclick = previewExport; $('download-book').onclick = exportBook;
    $('book-dialog').addEventListener('close', () => { release(); exportSnapshot = null; });
    $('delete-all').onclick = async () => { if (!confirm(app.t('deleteConfirm'))) return; try { await app.reset(); } catch (e) { app.fail(e); } };
    render();
  }
  window.TawBooksUI = { init, render };
})();
