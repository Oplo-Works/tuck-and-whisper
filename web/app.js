/* v2 UI: factual text comes from confirmed source excerpts, never model prose. */
(function () {
  'use strict';
  const W = window.TawWorkflow, S = window.TawStorage, API = window.TawAPI, I = window.TAW_I18N;
  const $ = id => document.getElementById(id), jobs = W.jobs();
  let record = W.create(), db = null, storageVersion = 0, queue = Promise.resolve(), blocked = false;
  // synced: record descends from storageVersion. conflicted: the banner is the conflict flow (never retried).
  let synced = false, conflicted = false, retrying = false;
  let photoFile = null, photoData = null, photoURL = null, art = null, acceptedArt = null;
  let screen = 'capture', running = {}, statuses = {}, loaded = false;
  const t = (key, vars) => window.TawCopy(key, I.getLanguage(), vars);
  function node(tag, text, cls) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; }
  function message(text) { $('message').textContent = text; $('message').hidden = !text; }
  function fail(error) { message(t('failed', { message: error.message })); }
  // The diagnostic code is supplementary; the requested action stays the unsaved/conflict copy.
  function storageWarning(conflict, code) {
    blocked = true; conflicted = conflict; $('storage-warning').hidden = false; $('storage-text').textContent = t(conflict ? 'conflict' : 'unsaved');
    $('storage-code').textContent = conflict ? '' : code || ''; $('storage-code').hidden = conflict || !code;
    $('retry-save').hidden = conflict; $('save-status').textContent = '';
  }
  // Error names and messages only: never memo, photo or candidate content.
  function report(stage, error) {
    const cause = error && error.cause;
    console.error('[taw] storage ' + stage + ' failed', { stage, name: error && error.name, message: error && error.message,
      cause: cause ? { name: cause.name, message: cause.message } : null });
    return stage === 'save' ? 'save-failed: ' + ((error && error.name) || 'Error') + (cause && cause.name ? ' / ' + cause.name : '') : stage;
  }
  function persist() {
    if (!loaded || blocked || !db) return Promise.resolve(false);
    let snapshot;
    try { snapshot = W.sanitize(record); } catch (e) { storageWarning(false, report('sanitize', e)); return Promise.resolve(false); }
    $('save-status').textContent = '';
    queue = queue.then(async () => {
      if (blocked) return false;
      try { storageVersion = await S.save(db, snapshot, storageVersion); $('save-status').textContent = t('saved'); return true; }
      catch (error) { const conflict = error.name === 'ConflictError', code = report('save', error); storageWarning(conflict, code); return false; }
    });
    return queue;
  }
  // Unsaved-only retry. If the stored version moved since this record's base, another
  // tab wrote: switch to the conflict flow (Download + Load latest) and never overwrite.
  async function retrySave() {
    if (!blocked || conflicted || retrying) return;
    retrying = true; $('retry-save').disabled = true; let stage = 'open';
    try {
      await queue;
      if (!db) db = await S.open();
      stage = 'load'; const stored = await S.load(db);
      const unchanged = synced ? stored.version === storageVersion : stored.version === 0 && !localStorage.getItem('taw-day-v1');
      if (!unchanged) {
        console.error('[taw] retry stopped: stored version changed', { expected: synced ? storageVersion : 0, found: stored.version });
        storageWarning(true); return;
      }
      if (!synced) storageVersion = 0;
      blocked = false; loaded = true; $('storage-warning').hidden = true;
      if (await persist()) synced = true;
    } catch (e) { storageWarning(false, report(stage, e)); }
    finally { retrying = false; $('retry-save').disabled = false; }
  }
  function download(name, contents, type) {
    const url = URL.createObjectURL(new Blob([contents], { type })); const a = node('a');
    a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function invalidate() { jobs.invalidate(); running = {}; statuses = {}; art = null; acceptedArt = null; message(''); }
  function change(next) { if (next === record) return; invalidate(); record = next; persist(); render(); }
  function show(name) {
    screen = name;
    for (const el of document.querySelectorAll('main > section')) el.hidden = el.id !== 'screen-' + name;
    render(); const h = $('screen-' + name).querySelector('h2'); if (h) h.focus(); window.scrollTo(0, 0);
  }
  function translate() {
    document.documentElement.lang = I.getLanguage(); document.documentElement.dir = I.languageInfo(I.getLanguage())?.rtl ? 'rtl' : 'ltr';
    for (const el of document.querySelectorAll('[data-copy]')) el.textContent = t(el.dataset.copy);
    $('language-note').hidden = ['ko', 'en'].includes(I.getLanguage());
    for (const kind of ['people', 'animals']) {
      const select = $('identity-' + kind); select.replaceChildren();
      for (const value of ['unconfirmed', 'same', 'absent', 'different', 'unsure']) { const option = node('option', t(value)); option.value = value; select.append(option); }
    }
  }
  function image(url) { const el = node('img', undefined, 'art'); el.src = url; el.alt = t('photo'); return el; }
  function clearPhoto() { if (photoURL) URL.revokeObjectURL(photoURL); photoURL = null; photoData = null; photoFile = null; $('photo-input').value = ''; }
  function clearVoice() { $('voice-input').value = ''; }
  function candidate(c) {
    const box = node('div', undefined, 'candidate-card'); box.dataset.factId = c.id;
    box.append(node('p', c.text, 'candidate-text'), node('p', t(c.source === 'memo' ? 'sourceMemo' : 'sourcePhoto'), 'source'));
    if (!c.grounded) box.append(node('p', t('ungrounded'), 'notice'));
    const yes = node('button', t('confirm'), c.decision === 'confirmed' ? 'primary' : ''); yes.disabled = !c.grounded;
    yes.onclick = () => change(W.decide(record, c.id, 'confirmed'));
    const no = node('button', t('reject'), c.decision === 'rejected' ? 'primary' : ''); no.onclick = () => change(W.decide(record, c.id, 'rejected'));
    box.append(yes, no);
    if (c.decision === 'confirmed') {
      const label = node('label', undefined, 'use'), check = node('input'); check.type = 'checkbox'; check.checked = c.included; check.disabled = !c.grounded;
      check.onchange = () => { const id = c.id; change(W.include(record, id, check.checked)); document.querySelector('[data-fact-id="' + id + '"] input')?.focus(); };
      label.append(check, node('span', t('include'))); box.append(label);
    }
    return box;
  }
  function audit(target) {
    target.replaceChildren(node('h3', t('original')), node('p', record.memoText));
    for (const c of record.candidates) target.append(node('p', c.id + ' · ' + t(c.source === 'memo' ? 'sourceMemo' : 'sourcePhoto') + ' · ' + c.decision + ' · ' + (c.included ? t('include') : '—') + '\n' + c.text));
    target.append(node('h3', t('history')));
    for (const item of record.history) target.append(node('p', new Date(item.at).toLocaleString(I.getLanguage()) + ' · ' + t(item.action) + '\n' + JSON.stringify({ before: item.before, after: item.after })));
    if (record.legacy) { const d = node('details'); d.append(node('summary', t('legacy')), node('pre', JSON.stringify(record.legacy, null, 2))); target.append(d); }
  }
  function output(target, value) {
    target.replaceChildren();
    if (!W.validOutput(record, value)) return;
    if (value.fallback) target.append(node('p', t('fallback'), 'hint'));
    let paragraph = [];
    for (const line of value.lines) {
      paragraph.push(line.text);
      if (line.paragraphEnd !== false) { target.append(node('p', paragraph.join(' '))); paragraph = []; }
    }
    if (paragraph.length) target.append(node('p', paragraph.join(' ')));
    if (value.observations?.length) {
      const details = node('details'); details.append(node('summary', t('photoGroup')));
      for (const line of value.observations) details.append(node('p', line.text));
      target.append(details);
    }
  }
  function render() {
    $('extract-btn').disabled = !!running.extract || !record.memoText.trim(); $('transcribe-btn').disabled = !!running.voice || !$('voice-input').files.length;
    $('photo-status').textContent = photoFile ? photoFile.name : '';
    $('nav-review').disabled = !record.candidates.length;
    $('selection-count').textContent = t('selected', { n: W.used(record).length });
    if (screen === 'review') {
      $('memo-candidates').replaceChildren(); $('photo-candidates').replaceChildren();
      for (const c of record.candidates) $(c.source === 'memo' ? 'memo-candidates' : 'photo-candidates').append(candidate(c));
      $('photo-preview').replaceChildren(); if (photoURL) $('photo-preview').append(image(photoURL));
      $('identity-details').hidden = !photoFile;
      for (const k of ['people', 'animals']) $('identity-' + k).value = record.identity[k];
    }
    const ready = W.prepared(record);
    $('restricted-notice').hidden = ready;
    output($('briefing'), record.briefing); output($('story'), record.story);
    $('briefing-status').textContent = running.briefing ? t('busy') : (statuses.briefing || '');
    $('story-status').textContent = running.story ? t('busy') : (statuses.story || '');
    $('briefing-retry').disabled = !ready || !!running.briefing; $('story-retry').disabled = !ready || !!running.story;
    $('another-question').disabled = !ready;
    if (document.activeElement !== $('question-text')) $('question-text').value = W.validQuestion(record, record.question) ? record.question.text : (!ready ? t('generalQuestion') : '');
    $('question-text').disabled = !ready;
    $('question-meta').textContent = record.question ? t(record.question.edited ? 'edited' : 'suggested') : '';
    $('reading-question').textContent = W.validQuestion(record, record.question) ? record.question.text : t('generalQuestion');
    if (!ready) $('story').replaceChildren(node('p', t('noMemo')));
    $('reading-art').replaceChildren();
    if (acceptedArt && W.imageAllowed(record)) $('reading-art').append(image(acceptedArt));
    // Restricted photo conversation has no memo-derived names or assertions.
    if (!ready && photoURL) $('reading-art').append(image(photoURL));
    $('art-preview').replaceChildren(); if (art && W.imageAllowed(record)) $('art-preview').append(image(art));
    $('art-approval').hidden = !art || !W.imageAllowed(record);
    $('style-btn').disabled = !photoFile || !W.imageAllowed(record) || !!running.style;
    $('art-message').textContent = running.style ? t('busy') : (statuses.style || (!W.imageAllowed(record) ? t('noImage') : t('artworkReview')));
    $('testimony-list').replaceChildren();
    for (const item of record.testimony) $('testimony-list').append(node('p', new Date(item.at).toLocaleString(I.getLanguage()) + ' · ' + item.text));
    if (screen === 'preview') audit($('preview-audit'));
    if (screen === 'bedtime') audit($('bedtime-audit'));
    if (window.TawBooksUI) window.TawBooksUI.render();
  }
  async function extract() {
    if (running.extract || !record.memoText.trim()) return;
    const token = jobs.begin('extract'), memo = record.memoText, file = photoFile;
    running.extract = true; message(t('busy')); render();
    try {
      const data = file ? await API.photo(file) : null;
      if (!jobs.current(token)) return; photoData = data;
      const raw = await API.extract(memo, data);
      if (!jobs.current(token)) return;
      change(W.extract(record, raw)); show('review');
    } catch (e) { if (jobs.current(token)) fail(e); }
    finally { if (jobs.current(token)) { running.extract = false; render(); } }
  }
  async function generate(kind) {
    if (!W.prepared(record) || running[kind]) return;
    const token = jobs.begin(kind), start = record;
    running[kind] = true; statuses[kind] = ''; render();
    try {
      const facts = W.used(start).filter(c => c.source === 'memo');
      const ids = await API.arrange(kind, facts);
      if (!jobs.current(token)) return;
      record = Object.assign({}, record, { [kind]: W.compose(start, kind, ids, false) }); persist();
    } catch (e) {
      if (!jobs.current(token)) return;
      // Retain valid prior work; first failure falls back to source passages.
      if (!W.validOutput(record, record[kind])) record = Object.assign({}, record, { [kind]: W.compose(start, kind, null, true) });
      statuses[kind] = t('fallback'); persist();
    } finally { if (jobs.current(token)) { running[kind] = false; render(); } }
  }
  function nextQuestion(first = false) {
    const index = first || !record.question ? 0 : record.question.index + 1;
    const q = W.question(record, index, t('questionTemplate'));
    if (!q) { message(t('exhausted')); return; }
    record = Object.assign({}, record, { question: q }); persist(); render();
  }
  function preview() {
    if (W.canPrepare(record)) record = W.prepare(record);
    persist(); show('preview');
    if (W.prepared(record)) { if (!W.validQuestion(record, record.question)) nextQuestion(true); if (!W.validOutput(record, record.briefing)) generate('briefing'); }
  }
  async function style() {
    if (running.style || !photoFile || !W.imageAllowed(record)) return;
    const token = jobs.begin('style'), file = photoFile; running.style = true; statuses.style = ''; render();
    try {
      const data = photoData || await API.photo(file);
      if (!jobs.current(token)) return;
      const result = await API.style(data);
      if (!jobs.current(token)) return;
      art = result; acceptedArt = null;
    } catch (e) { if (jobs.current(token)) statuses.style = t('failed', { message: e.message }); }
    finally { if (jobs.current(token)) { running.style = false; render(); } }
  }
  async function voice() {
    const file = $('voice-input').files[0]; if (!file || running.voice) return;
    const token = jobs.begin('voice'); running.voice = true; message(t('busy')); render();
    try {
      const text = await API.voice(file, I.languageInfo(I.getLanguage()).bias);
      if (!jobs.current(token)) return;
      $('memo-input').value = text; change(W.input(record, text));
    } catch (e) { if (jobs.current(token)) fail(e); }
    finally { if (jobs.current(token)) { running.voice = false; render(); } }
  }
  function sample() {
    invalidate(); clearPhoto(); clearVoice(); record = W.create(); record.mode = 'sample';
    record.memoText = '오늘 아이와 공원에 갔어요. 아이가 나뭇잎을 주웠어요. 집에 돌아와 나뭇잎을 책 사이에 넣었어요.';
    const parts = record.memoText.match(/[^.]+\./g).map(x => x.trim());
    record = W.extract(record, { candidates: parts.map(text => ({ text, quote: text, source: 'memo', grade: 'C' })), unknowns: [] });
    $('memo-input').value = record.memoText; persist(); show('review');
  }
  async function load() {
    synced = false;
    const stored = await S.load(db); const legacy = localStorage.getItem('taw-day-v1');
    // Adopt the stored version only together with a record that passed sanitize.
    const next = stored.record ? W.sanitize(stored.record) : (stored.version === 0 && legacy ? W.migrate(legacy) : W.create());
    storageVersion = stored.version; record = next; synced = true;
    loaded = true; blocked = false; conflicted = false; $('storage-warning').hidden = true; $('memo-input').value = record.memoText;
    if (!stored.record) await persist();
  }
  async function init() {
    const lang = localStorage.getItem('taw-lang') || navigator.language.split('-')[0];
    I.setLanguage(lang);
    for (const item of I.languages()) { const option = node('option', item.name); option.value = item.code; $('lang-select').append(option); }
    $('lang-select').value = I.getLanguage(); translate();
    $('lang-select').onchange = () => { I.setLanguage($('lang-select').value); localStorage.setItem('taw-lang', I.getLanguage()); translate(); render(); };
    $('memo-input').oninput = () => change(W.input(record, $('memo-input').value));
    $('photo-input').onchange = () => { if (photoURL) URL.revokeObjectURL(photoURL); photoFile = $('photo-input').files[0] || null; photoData = null; photoURL = photoFile ? URL.createObjectURL(photoFile) : null; change(W.input(record, record.memoText)); };
    $('voice-input').onchange = () => { jobs.begin('voice'); running.voice = false; render(); };
    $('extract-btn').onclick = extract; $('load-sample-btn').onclick = sample; $('transcribe-btn').onclick = voice;
    $('prepare-btn').onclick = preview; $('nav-preview').onclick = preview; $('nav-review').onclick = () => show('review');
    $('nav-capture').onclick = $('edit-input').onclick = () => show('capture');
    for (const k of ['people', 'animals']) $('identity-' + k).onchange = () => change(W.identity(record, k, $('identity-' + k).value));
    $('briefing-retry').onclick = () => generate('briefing'); $('story-retry').onclick = () => generate('story');
    $('another-question').onclick = () => nextQuestion();
    $('question-text').oninput = () => { if (!record.question) return; record = Object.assign({}, record, { question: Object.assign({}, record.question, { text: $('question-text').value, edited: true }) }); persist(); $('question-meta').textContent = t('edited'); };
    $('open-bedtime').onclick = () => { show('bedtime'); if (W.prepared(record) && !W.validOutput(record, record.story)) generate('story'); };
    $('style-btn').onclick = style;
    $('accept-art').onclick = () => { if (W.imageAllowed(record)) acceptedArt = art; render(); };
    $('reject-art').onclick = () => { acceptedArt = null; art = null; render(); };
    $('save-testimony').onclick = () => { const text = $('testimony-input').value.trim(); if (!text) return;
      record = Object.assign({}, record, { testimony: record.testimony.concat({ text, at: Date.now(), revision: record.contentRevision, question: record.question?.text || null }) });
      $('testimony-input').value = ''; persist(); render(); };
    $('new-day-btn').onclick = () => { if (!confirm(t('newDayConfirm'))) return; invalidate(); clearPhoto(); clearVoice(); record = W.create(); $('memo-input').value = ''; persist(); show('capture'); };
    $('download-draft').onclick = () => download('taw-unsaved.json', JSON.stringify(record, null, 2), 'application/json');
    $('reload-record').onclick = async () => { invalidate(); clearPhoto(); clearVoice(); await queue; try { await load(); show('capture'); } catch (e) { storageWarning(false, report('load', e)); } };
    $('retry-save').onclick = retrySave;
    let stage = 'open';
    try { db = await S.open(); stage = 'load'; await load(); } catch (e) { loaded = true; storageWarning(false, report(stage, e)); }
    window.addEventListener('beforeunload', event => { if (blocked) { event.preventDefault(); event.returnValue = ''; } });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    render(); window.TAW_READY = true;
    // Extension boundary for local books. No service credentials or mutable globals exposed.
    if (window.TawBooksUI) window.TawBooksUI.init({ getRecord: () => record, getDB: () => db, getArt: () => W.imageAllowed(record) ? acceptedArt : null,
      getVersion: () => storageVersion, flush: () => queue, isBlocked: () => blocked, t, node, image, show, message, fail, download,
      reset: async () => {
        if (blocked) throw Error('Unsaved changes'); blocked = true;
        try {
          await queue; const next = W.create();
          storageVersion = await S.save(db, next, storageVersion, true);
          invalidate(); clearPhoto(); clearVoice(); record = next; $('memo-input').value = '';
          localStorage.removeItem('taw-day-v1'); show('capture');
        } finally { blocked = false; render(); }
      } });
  }
  init().catch(fail);
})();
