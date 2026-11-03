(function () {
  'use strict';
  let app, saving = false, statusKey = '', exportSnapshot = null, exportRevision = null, exportDay = null, exportSaved = false, objectURLs = [];
  let coverURLs = [];
  const $ = id => document.getElementById(id), S = window.TawStorage, B = window.TawBooks, W = window.TawWorkflow;
  function release() { for (const url of objectURLs) URL.revokeObjectURL(url); objectURLs = []; }
  function display(book) {
    book = B.normalize(book);
    release(); const area = $('book-content'); area.replaceChildren();
    area.append(app.node('h3', book.title), app.node('p', book.eventDate));
    if (book.artwork) { const url = URL.createObjectURL(book.artwork); objectURLs.push(url); area.append(app.image(url), app.node('p', app.t('aiArt'), 'hint')); }
    if (Array.isArray(book.paragraphs) && book.paragraphs.length) {
      // Restore paragraph + illustration pairs in order.
      for (const p of book.paragraphs) {
        for (const text of p.lines) area.append(app.node('p', text));
        if (p.artwork) { const url = URL.createObjectURL(p.artwork); objectURLs.push(url); area.append(app.image(url), app.node('p', app.t('aiArt'), 'hint')); }
        else area.append(app.node('p', app.t('paraSkipped'), 'hint'));
      }
    } else {
      for (const text of book.lines) area.append(app.node('p', text));
    }
    if (book.question) area.append(app.node('blockquote', book.question));
  }
  async function currentBook() {
    const r = app.getRecord(), revision = r.contentRevision, dayId = r.dayId, approved = app.getArt();
    const metadata = JSON.stringify(B.metadata(r));
    const paraUrls = (app.getParagraphArts ? app.getParagraphArts() : []).slice();
    const image = await B.artwork(approved);
    const paraImages = [];
    for (const url of paraUrls) paraImages.push(await B.artwork(url || null));
    const nowUrls = app.getParagraphArts ? app.getParagraphArts() : [];
    if (app.getRecord().dayId !== dayId || app.getRecord().contentRevision !== revision || app.getArt() !== approved || JSON.stringify(B.metadata(app.getRecord())) !== metadata ||
        nowUrls.length !== paraUrls.length || nowUrls.some((u, i) => u !== paraUrls[i])) throw Error('Story or illustration changed');
    return B.snapshot(app.getRecord(), image, W, paraImages);
  }
  async function save() {
    if (saving || app.isBlocked()) return; saving = true; app.message(''); $('book-save-status').textContent = app.t('bookSaving'); render();
    try {
      const book = await currentBook(); await app.flush();
      if (app.isBlocked()) throw Error('Unsaved changes');
      await S.saveBook(app.getDB(), book, app.getVersion());
      const readback = (await S.books(app.getDB())).find(b => b.id === book.id);
      if (!await B.same(readback, book)) throw Error('Book verification failed');
      const status = app.t(book.artwork || book.paragraphs.some(p => p.artwork) ? 'bookSaved' : 'bookSavedText');
      $('book-save-status').textContent = status; app.message(status);
    } catch (e) {
      const status = app.t('bookSaveFailed', { reason: e.cause?.name || e.message });
      $('book-save-status').textContent = status; app.message(status);
    }
    finally { saving = false; render(); }
  }
  async function library() {
    for (const url of coverURLs) URL.revokeObjectURL(url); coverURLs = [];
    app.show('library'); const area = $('books'); area.replaceChildren();
    try {
      const books = await S.books(app.getDB());
      if (!books.length) area.append(app.node('p', app.t('libraryEmpty')));
      for (const book of books) {
        const card = app.node('div', undefined, 'card book-tile'), open = app.node('button', undefined, 'book-open');
        const normalized = B.normalize(book), cover = normalized.artwork || normalized.paragraphs.find(p => p.artwork)?.artwork;
        // Covers reuse artwork already stored with the book. Never persist or fetch an original photo.
        if (cover instanceof Blob && ['image/png', 'image/jpeg', 'image/webp'].includes(cover.type)) {
          const url = URL.createObjectURL(cover); coverURLs.push(url);
          const image = app.node('img', undefined, 'book-thumb'); image.src = url; image.alt = app.t('aiArt'); open.append(image);
        } else {
          const empty = app.node('span', undefined, 'book-cover-empty'), label = app.node('span', app.t('textBook'));
          label.dataset.copy = 'textBook'; empty.append(window.TawUI.icon('book'), label); open.append(empty);
        }
        open.append(app.node('span', normalized.title, 'book-name')); open.setAttribute('aria-label', normalized.title);
        open.onclick = () => { exportSnapshot = book; exportSaved = true; display(book); $('book-note').textContent = app.t('past') + ' · ' + app.t('exportHint'); $('export-options').hidden = false; $('export-text-only').checked = false; $('book-dialog').showModal(); };
        const remove = app.node('button', app.t('deleteBook'));
        remove.dataset.copy = 'deleteBook'; remove.dataset.icon = 'trash';
        remove.onclick = async () => { if (!confirm(app.t('deleteBook') + '?')) return; try { await S.deleteBook(app.getDB(), book.id); await library(); } catch (e) { app.fail(e); } };
        const date = app.node('time', normalized.eventDate, 'book-date'); date.dateTime = normalized.eventDate;
        card.append(open, date, app.node('p', normalized.lines[0] || '', 'book-teaser'), remove); area.append(card);
      }
      window.TawUI.decorate(area);
    } catch (e) { app.fail(e); }
  }
  async function previewExport() {
    try {
      app.message(''); const book = await currentBook(); exportSnapshot = book; exportSaved = false; exportDay = book.dayId; exportRevision = book.revision;
      display(book); $('book-note').textContent = app.t('exportHint'); $('export-options').hidden = false; $('export-text-only').checked = false;
      $('book-dialog').showModal();
    } catch (e) { app.fail(e); }
  }
  async function exportBook() {
    try {
      if (!exportSnapshot) return;
      const current = app.getRecord();
      if (!exportSaved && (current.dayId !== exportDay || current.contentRevision !== exportRevision || !W.validOutput(current, current.story) ||
          current.story.lines.map(l => l.text).join('\n') !== exportSnapshot.lines.join('\n') || (current.question?.text || '') !== exportSnapshot.question ||
          ['title', 'eventDate'].some(k => B.metadata(current)[k] !== exportSnapshot[k]))) throw Error('Story changed; preview again');
      const textOnly = $('export-text-only').checked;
      const data = textOnly ? '' : await B.dataURL(exportSnapshot.artwork);
      const paraData = [];
      if (Array.isArray(exportSnapshot.paragraphs)) for (const p of exportSnapshot.paragraphs) paraData.push(textOnly ? '' : await B.dataURL(p.artwork));
      // Check again after FileReader, which is asynchronous.
      if (!exportSaved && app.getRecord() !== current) throw Error('Record changed; preview again');
      const html = B.html(exportSnapshot, data, window.TAW_I18N.getLanguage(), { art: app.t('photo'), note: app.t('exportHint'), ai: app.t('aiArt'), textOnly: app.t('paraSkipped') }, paraData);
      app.download('tuck-and-whisper-' + exportSnapshot.eventDate + '.html', html, 'text/html');
      $('book-dialog').close();
    } catch (e) { app.fail(e); }
  }
  function render() {
    if (!app) return;
    $('library-btn').hidden = false; $('nav-library').disabled = false; $('book-tools').hidden = false;
    const valid = W.validOutput(app.getRecord(), app.getRecord().story);
    const meta = B.metadata(app.getRecord());
    const key = JSON.stringify([app.getRecord().dayId, app.getRecord().contentRevision, meta, app.getRecord().question?.text, app.getArt(), app.getParagraphArts()]);
    if (key !== statusKey) { statusKey = key; if (!saving) $('book-save-status').textContent = ''; }
    $('book-details').hidden = !valid;
    if (document.activeElement !== $('book-title')) $('book-title').value = meta.title;
    if (document.activeElement !== $('event-date')) $('event-date').value = meta.eventDate;
    $('reading-title').textContent = valid ? meta.title : '';
    $('reading-date').textContent = valid ? meta.eventDate : '';
    $('save-book').disabled = saving || !valid || app.isBlocked() || !app.getDB();
    $('export-book').disabled = !valid;
  }
  function init(context) {
    app = context;
    $('book-title').oninput = () => app.setBookDetails({ title: $('book-title').value });
    $('event-date').oninput = () => app.setBookDetails({ eventDate: $('event-date').value });
    $('save-book').onclick = save; $('library-btn').onclick = $('nav-library').onclick = library; $('export-book').onclick = previewExport; $('download-book').onclick = exportBook;
    window.addEventListener('beforeunload', () => { for (const url of coverURLs) URL.revokeObjectURL(url); release(); });
    $('book-dialog').addEventListener('close', () => { release(); exportSnapshot = null; });
    $('delete-all').onclick = async () => { if (!confirm(app.t('deleteConfirm'))) return; try { await app.reset(); } catch (e) { app.fail(e); } };
    render();
  }
  window.TawBooksUI = { init, render };
})();
