(function () {
  'use strict';
  let app, saving = false, statusKey = '', exportSnapshot = null, exportRevision = null, exportDay = null, exportSaved = false, objectURLs = [];
  let coverURLs = [], dialogReturnFocus = null;
  let lastDialog = null, feedbackKey = '', feedbackVars = {}, libraryRequest = 0;
  const $ = id => document.getElementById(id), S = window.TawStorage, B = window.TawBooks, W = window.TawWorkflow, TRANS_KEY = 'taw-book-translations-v1';
  let translatingId = null;
  function readTranslations() { try { return JSON.parse(localStorage.getItem(TRANS_KEY) || '{}') || {}; } catch { return {}; } }
  function writeTranslations(store) { try { localStorage.setItem(TRANS_KEY, JSON.stringify(store)); } catch {} }
  function activeTranslation(id) { const e = readTranslations()[id], l = e?.active; return l && e?.items?.[l] ? { lang: l, data: e.items[l] } : null; }
  function localizedBook(book) {
    const n = B.normalize(book), hit = activeTranslation(n.id);
    if (!hit) return n;
    const paragraphs = n.paragraphs.map((p, i) => Object.assign({}, p, { lines: Array.isArray(hit.data.paragraphs?.[i]) && hit.data.paragraphs[i].length ? hit.data.paragraphs[i] : p.lines }));
    return Object.assign({}, n, { title: hit.data.title || n.title, question: typeof hit.data.question === 'string' ? hit.data.question : n.question, paragraphs, lines: paragraphs.flatMap(p => p.lines) });
  }
  function syncTranslateUI() {
    const bar = $('book-translate-bar'); if (!bar) return;
    if (!exportSnapshot || !exportSaved) { bar.hidden = true; return; }
    bar.hidden = false; const select = $('book-lang-select');
    const I = window.TAW_I18N; if (!select.options.length && I) for (const item of I.languages()) { const o = app.node('option', item.name); o.value = item.code; select.append(o); }
    select.setAttribute('aria-label', app.t('bookLangLabel'));
    const hit = activeTranslation(exportSnapshot.id), busy = translatingId === exportSnapshot.id;
    if (document.activeElement !== select && !busy) select.value = hit ? hit.lang : I.getLanguage();
    select.disabled = busy; $('translate-book').disabled = busy; $('original-book').hidden = !hit || busy;
    const langName = hit ? (I.languageInfo(hit.lang)?.name || hit.lang) : '';
    $('book-translate-status').textContent = busy ? app.t('translatingBook') : hit ? app.t('translatedBook', { lang: langName }) : '';
  }
  async function convertBook(book, langCode) {
    if (!book || translatingId) return;
    const n = B.normalize(book), I = window.TAW_I18N, lang = I.languageInfo(langCode || I.getLanguage()) || I.languageInfo('en');
    const store = readTranslations(), entry = store[n.id] || { active: null, items: {} };
    if (entry.items?.[lang.code]) {
      entry.active = lang.code; store[n.id] = entry; writeTranslations(store);
      if (exportSnapshot?.id === n.id) { display(exportSnapshot); syncTranslateUI(); }
      if (!$('screen-library').hidden) await library({ navigation: 'none' });
      return;
    }
    translatingId = n.id; syncTranslateUI();
    try {
      const translated = await window.TawAPI.translateBook(n, lang), next = readTranslations(), cur = next[n.id] || { active: null, items: {} };
      cur.items = Object.assign({}, cur.items, { [lang.code]: translated }); cur.active = lang.code; next[n.id] = cur; writeTranslations(next);
      if (exportSnapshot?.id === n.id) display(exportSnapshot);
      if (!$('screen-library').hidden) await library({ navigation: 'none' });
    } catch (e) { app.fail(e); } finally { translatingId = null; syncTranslateUI(); }
  }
  async function restoreOriginalBook(book) {
    if (!book) return;
    const store = readTranslations(); if (store[book.id]) { store[book.id].active = null; writeTranslations(store); }
    if (exportSnapshot?.id === book.id) { display(exportSnapshot); syncTranslateUI(); }
    if (!$('screen-library').hidden) await library({ navigation: 'none' });
  }
  function release() { for (const url of objectURLs) URL.revokeObjectURL(url); objectURLs = []; }
  function display(book) {
    book = localizedBook(book);
    release(); const area = $('book-content'); area.replaceChildren();
    const title = app.node('h3', book.title); title.id = 'saved-book-title';
    area.append(title, app.node('p', book.eventDate, 'hint'));
    if (book.artwork) { const url = URL.createObjectURL(book.artwork); objectURLs.push(url); area.append(app.image(url), app.node('p', app.t('aiArt'), 'hint')); }
    if (Array.isArray(book.paragraphs) && book.paragraphs.length) {
      // Restore paragraph + illustration pairs in order.
      for (const p of book.paragraphs) {
        for (const text of p.lines) area.append(app.node('p', text));
        if (p.artwork) { const url = URL.createObjectURL(p.artwork); objectURLs.push(url); area.append(app.image(url), app.node('p', app.t('aiArt'), 'hint')); }
        // The reading copy does not need a missing-image notice after every paragraph.
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
    if (saving || app.isBlocked()) return; saving = true; app.message(''); feedbackKey = 'bookSaving'; feedbackVars = {}; render();
    try {
      const book = await currentBook(); await app.flush();
      if (app.isBlocked()) throw Error('Unsaved changes');
      const savedVersion = app.getVersion();
      await S.saveBook(app.getDB(), book, savedVersion);
      const readback = (await S.books(app.getDB())).find(b => b.id === book.id);
      if (!await B.same(readback, book)) throw Error('Book verification failed');
      // Mark only a verified, unchanged draft. A later autosave removes this marker.
      if (!app.hasUnarchivedArtwork()) await S.markArchived(app.getDB(), book.id, savedVersion);
      feedbackKey = book.artwork || book.paragraphs.some(p => p.artwork) ? 'bookSaved' : 'bookSavedText';
    } catch (e) {
      feedbackKey = 'bookSaveFailed'; feedbackVars = { reason: e.cause?.name || e.message };
    }
    finally { saving = false; render(); }
  }
  async function library(options = {}) {
    const request = ++libraryRequest;
    for (const url of coverURLs) URL.revokeObjectURL(url); coverURLs = [];
    app.show('library', options); const area = $('books'); area.replaceChildren();
    try {
      const books = await S.books(app.getDB());
      if (request !== libraryRequest) return;
      if (!books.length) {
        const empty = app.node('p', app.t('libraryEmpty')); empty.dataset.copy = 'libraryEmpty'; area.append(empty);
        const start = app.node('button', app.t('returnCapture'), 'primary'); start.dataset.icon = 'note';
        start.dataset.copy = 'returnCapture';
        start.onclick = () => app.show('capture'); area.append(start);
      }
      for (const book of books) {
        const card = app.node('div', undefined, 'card book-tile'), open = app.node('button', undefined, 'book-open');
        const normalized = localizedBook(book), cover = normalized.artwork || normalized.paragraphs.find(p => p.artwork)?.artwork;
        // Covers reuse artwork already stored with the book. Never persist or fetch an original photo.
        if (cover instanceof Blob && ['image/png', 'image/jpeg', 'image/webp'].includes(cover.type)) {
          const url = URL.createObjectURL(cover); coverURLs.push(url);
          const image = app.node('img', undefined, 'book-thumb'); image.src = url; image.alt = app.t('aiArt'); open.append(image);
        } else {
          const empty = app.node('span', undefined, 'book-cover-empty'), label = app.node('span', app.t('textBook'));
          label.dataset.copy = 'textBook'; empty.append(window.TawUI.icon('book'), label); open.append(empty);
        }
        const info = app.node('span', undefined, 'book-info');
        info.append(app.node('span', normalized.title, 'book-name'));
        const date = app.node('time', normalized.eventDate, 'book-date'); date.dateTime = normalized.eventDate; info.append(date);
        if (normalized.lines[0] && normalized.lines[0] !== normalized.title) info.append(app.node('span', normalized.lines[0], 'book-teaser'));
        open.append(info); open.setAttribute('aria-label', normalized.title);
        open.onclick = () => { dialogReturnFocus = open; exportSnapshot = book; exportSaved = true; showDialog(); };
        const actions = app.node('div', undefined, 'book-tile-actions'), xlate = app.node('button', app.t('translateBook'), 'book-translate');
        xlate.dataset.copy = 'translateBook'; xlate.dataset.icon = 'talk'; xlate.disabled = translatingId === book.id;
        xlate.onclick = () => convertBook(book, window.TAW_I18N.getLanguage()); actions.append(xlate);
        if (activeTranslation(book.id)) {
          const orig = app.node('button', app.t('showOriginal'), 'book-original'); orig.dataset.copy = 'showOriginal';
          orig.onclick = () => restoreOriginalBook(book); actions.append(orig);
        }
        const remove = app.node('button', app.t('deleteBook'), 'book-delete');
        remove.dataset.copy = 'deleteBook'; remove.dataset.icon = 'trash';
        remove.onclick = async () => { if (!confirm(app.t('deleteBook') + '?')) return; try { await S.deleteBook(app.getDB(), book.id); const st = readTranslations(); delete st[book.id]; writeTranslations(st); if (lastDialog?.book.id === book.id) lastDialog = null; await library(); } catch (e) { app.fail(e); } };
        actions.append(remove); card.append(open, actions); area.append(card);
      }
      window.TawUI.decorate(area);
    } catch (e) { app.fail(e); }
  }
  async function previewExport() {
    try {
      app.message(''); const book = await currentBook(); exportSnapshot = book; exportSaved = false; exportDay = book.dayId; exportRevision = book.revision;
      dialogReturnFocus = $('export-book'); showDialog();
    } catch (e) { app.fail(e); }
  }
  function showDialog() {
    lastDialog = { book: exportSnapshot, saved: exportSaved, day: exportDay, revision: exportRevision, focus: dialogReturnFocus, textOnly: false };
    display(exportSnapshot); syncTranslateUI(); $('book-snapshot').hidden = !exportSaved;
    $('book-note').textContent = app.t('exportHint'); $('export-options').hidden = false; $('export-text-only').checked = false;
    app.openDialog(); $('book-dialog').scrollTop = 0;
  }
  function reopen() {
    if (!lastDialog) return false;
    const snapshot = lastDialog;
    exportSnapshot = snapshot.book; exportSaved = snapshot.saved; exportDay = snapshot.day; exportRevision = snapshot.revision; dialogReturnFocus = snapshot.focus;
    showDialog(); $('export-text-only').checked = snapshot.textOnly; lastDialog.textOnly = snapshot.textOnly; return true;
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
      const view = exportSaved ? localizedBook(exportSnapshot) : exportSnapshot, lang = (exportSaved && activeTranslation(exportSnapshot.id)?.lang) || window.TAW_I18N.getLanguage();
      const html = B.html(view, data, lang, { art: app.t('photo'), note: app.t('exportHint'), ai: app.t('aiArt'), textOnly: app.t('paraSkipped') }, paraData);
      app.download('tuck-and-whisper-' + exportSnapshot.eventDate + '.html', html, 'text/html');
      $('book-dialog').close();
    } catch (e) { app.fail(e); }
  }
  function render() {
    if (!app) return;
    $('nav-library').disabled = false; $('book-tools').hidden = false;
    const valid = W.validOutput(app.getRecord(), app.getRecord().story);
    const meta = B.metadata(app.getRecord());
    const key = JSON.stringify([app.getRecord().dayId, app.getRecord().contentRevision, meta, app.getRecord().question?.text, app.getArt(), app.getParagraphArts()]);
    if (key !== statusKey) { statusKey = key; if (!saving) feedbackKey = ''; }
    $('book-save-status').textContent = feedbackKey ? app.t(feedbackKey, feedbackVars) : '';
    $('book-details').hidden = !valid;
    if (document.activeElement !== $('book-title')) $('book-title').value = meta.title;
    if (document.activeElement !== $('event-date')) $('event-date').value = meta.eventDate;
    $('reading-title').textContent = valid ? meta.title : '';
    $('reading-date').textContent = valid ? meta.eventDate : '';
    $('save-book').disabled = saving || !valid || app.isBlocked() || !app.getDB();
    $('export-book').disabled = !valid; syncTranslateUI();
  }
  function init(context) {
    app = context;
    $('book-title').oninput = () => app.setBookDetails({ title: $('book-title').value });
    $('event-date').oninput = () => app.setBookDetails({ eventDate: $('event-date').value });
    $('save-book').onclick = save; $('nav-library').onclick = library; $('export-book').onclick = previewExport; $('download-book').onclick = exportBook;
    $('translate-book').onclick = () => convertBook(exportSnapshot, $('book-lang-select').value);
    $('original-book').onclick = () => restoreOriginalBook(exportSnapshot);
    $('export-text-only').onchange = () => { if (lastDialog) lastDialog.textOnly = $('export-text-only').checked; };
    window.addEventListener('beforeunload', () => { for (const url of coverURLs) URL.revokeObjectURL(url); release(); });
    $('book-dialog').addEventListener('close', () => {
      // close is queued: a rapid browser Forward may have already reopened it.
      if ($('book-dialog').open) return;
      if (lastDialog) lastDialog.textOnly = $('export-text-only').checked;
      release(); exportSnapshot = null;
      if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus({ preventScroll: true });
      dialogReturnFocus = null; app.closeDialog();
    });
    $('delete-all').onclick = async () => { if (!confirm(app.t('deleteConfirm'))) return; try { await app.reset(); try { localStorage.removeItem(TRANS_KEY); } catch {} lastDialog = null; } catch (e) { app.fail(e); } };
    render();
  }
  window.TawBooksUI = { init, render, library, reopen };
})();
