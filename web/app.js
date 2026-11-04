/* v2 UI: factual text comes from confirmed source excerpts, never model prose. */
(function () {
  'use strict';
  const W = window.TawWorkflow, S = window.TawStorage, API = window.TawAPI, I = window.TAW_I18N;
  const $ = id => document.getElementById(id), jobs = W.jobs();
  let record = W.create(), db = null, storageVersion = 0, queue = Promise.resolve(), blocked = false;
  // synced: record descends from storageVersion. conflicted: the banner is the conflict flow (never retried).
  // corrupted: the stored record failed sanitize; quarantined keeps its raw form.
  let synced = false, conflicted = false, retrying = false, corrupted = false, quarantined = null;
  let photoFile = null, photoData = null, photoURL = null, art = null, acceptedArt = null;
  // Paragraph illustrations, aligned to W.paragraphs(record) indexes. Session-only
  // like the single illustration; saved books carry their own copies.
  let paragraphArt = [], paragraphBusy = [], paragraphFailed = [];
  let screen = 'capture', running = {}, statuses = {}, loaded = false, voiceConverted = false;
  let navigationReady = false, restoringHistory = false;
  const t = (key, vars) => window.TawCopy(key, I.getLanguage(), vars);
  function node(tag, text, cls) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; }
  function message(text) { $('message').textContent = text; $('message').hidden = !text; }
  function fail(error) { message(t('failed', { message: error.message })); }
  // The diagnostic code is supplementary; the requested action stays the unsaved/conflict copy.
  function storageWarning(conflict, code) {
    blocked = true; conflicted = conflict; corrupted = false; $('storage-warning').hidden = false; $('storage-text').textContent = t(conflict ? 'conflict' : 'unsaved');
    $('storage-code').textContent = conflict ? '' : code || ''; $('storage-code').hidden = conflict || !code;
    $('retry-save').hidden = conflict; $('start-fresh').hidden = true; $('save-status').textContent = '';
  }
  // Damaged-record flow: never a reload loop. The raw record stays quarantined
  // (in memory, localStorage and the download button) until the user explicitly
  // starts a new record over it or loads a valid record saved meanwhile.
  function corruptWarning(code) {
    blocked = true; conflicted = false; corrupted = true; $('storage-warning').hidden = false; $('storage-text').textContent = t('corrupt');
    $('storage-code').textContent = code || ''; $('storage-code').hidden = !code;
    $('retry-save').hidden = true; $('start-fresh').hidden = false; $('save-status').textContent = '';
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
      try { storageVersion = await S.save(db, snapshot, storageVersion); $('save-status').textContent = t('savedShort'); return true; }
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
  // Explicit recovery from a damaged stored record. CAS over the damaged
  // version, so a valid record saved by another tab meanwhile is never lost:
  // that surfaces as the conflict flow instead. The quarantine copy is kept.
  async function startFresh() {
    if (!corrupted || !db) return;
    try {
      await queue;
      const next = W.create();
      storageVersion = await S.save(db, next, storageVersion);
      quarantined = null; corrupted = false; blocked = false; conflicted = false; synced = true;
      invalidate(); clearPhoto(); clearVoice(); clearTestimony();
      record = next; $('memo-input').value = ''; $('storage-warning').hidden = true;
      show('capture');
    } catch (e) {
      if (e.name === 'ConflictError') storageWarning(true); else corruptWarning(report('save', e));
    }
    render();
  }
  function download(name, contents, type) {
    const url = URL.createObjectURL(new Blob([contents], { type })); const a = node('a');
    a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function invalidate() { jobs.invalidate(); running = {}; statuses = {}; art = null; acceptedArt = null; paragraphArt = []; paragraphBusy = []; paragraphFailed = []; message(''); }
  function clearParagraphArt() { paragraphArt = []; paragraphBusy = []; paragraphFailed = []; }
  // The single fixed anchor for every paragraph call: the parent-approved
  // illustration when there is one, otherwise the original photo. A generated
  // paragraph image is never used as an anchor (no chaining).
  function artAnchor() { return acceptedArt || photoData || null; }
  // Paragraph art is photo-required (v23): a session anchor must exist — the
  // approved illustration, the loaded photo data, or a selected photo file
  // that can still be loaded. Text, memos and the single illustration are
  // unaffected; only paragraph illustrations gain this extra condition on
  // top of the unchanged identity gate (W.imageAllowed).
  function hasArtAnchor() { return !!(acceptedArt || photoData || photoFile); }
  function paragraphArtAllowed() { return W.imageAllowed(record) && hasArtAnchor(); }
  function change(next) { if (next === record) return; invalidate(); record = next; persist(); render(); }
  function show(name, options = {}) {
    if (name === 'review' && !record.candidates.length) name = 'capture';
    if (navigationReady && options.navigation !== 'none' && name !== screen) {
      history.replaceState({ ...history.state, scroll: window.scrollY }, '');
      history.pushState({ taw: true, screen: name, scroll: 0 }, '');
    }
    screen = name;
    for (const el of document.querySelectorAll('main > section')) el.hidden = el.id !== 'screen-' + name;
    if (name === 'bedtime' && photoFile && !W.imageAllowed(record)) $('reading-identity').open = true;
    render(); const h = $('screen-' + name).querySelector('h2'); if (h) h.focus({ preventScroll: true });
    window.scrollTo(0, options.scroll || 0);
  }
  function openDialog() {
    if (!history.state?.dialog) {
      history.replaceState({ ...history.state, scroll: window.scrollY }, '');
      history.pushState({ taw: true, screen, dialog: true, scroll: window.scrollY }, '');
    }
    $('book-dialog').showModal();
  }
  function closeDialog() {
    if (!restoringHistory && history.state?.dialog) history.back();
  }
  async function restoreHistory(event) {
    if (!event.state?.taw) return;
    restoringHistory = true;
    try {
      const state = event.state;
      if ($('book-dialog').open && !state.dialog) $('book-dialog').close();
      if (state.screen !== screen) {
        if (state.screen === 'library') await window.TawBooksUI.library({ navigation: 'none' });
        else show(state.screen, { navigation: 'none' });
      }
      if (state.dialog && !$('book-dialog').open && !window.TawBooksUI.reopen()) {
        history.replaceState({ ...state, dialog: false }, '');
      }
      window.scrollTo(0, state.scroll || 0);
    } finally { restoringHistory = false; }
  }
  function translate() {
    // The selected locale still controls voice recognition. Untranslated UI is English.
    document.documentElement.lang = I.getLanguage() === 'ko' ? 'ko' : 'en'; document.documentElement.dir = 'ltr';
    for (const el of document.querySelectorAll('[data-copy]')) el.textContent = t(el.dataset.copy);
    if ($('save-status').textContent) $('save-status').textContent = t('savedShort');
    $('language-note').hidden = ['ko', 'en'].includes(I.getLanguage());
    for (const kind of ['people', 'animals']) {
      for (const prefix of ['identity-', 'reading-']) {
        const select = $(prefix + kind); select.replaceChildren();
        for (const value of ['unconfirmed', 'same', 'absent', 'different', 'unsure']) { const option = node('option', t(value)); option.value = value; select.append(option); }
      }
    }
    for (const group of $('lang-select').querySelectorAll('optgroup')) group.label = t(group.dataset.label);
  }
  function image(url) { const el = node('img', undefined, 'art'); el.src = url; el.alt = t('photo'); return el; }
  function clearPhoto() { if (photoURL) URL.revokeObjectURL(photoURL); photoURL = null; photoData = null; photoFile = null; $('photo-input').value = ''; }
  function clearVoice() { $('voice-input').value = ''; voiceConverted = false; }
  function updatePhoto(file) {
    if (photoURL) URL.revokeObjectURL(photoURL);
    photoFile = file; photoData = null; photoURL = file ? URL.createObjectURL(file) : null;
    if (!file) $('photo-input').value = '';
    change(W.input(record, record.memoText));
  }
  function readingIdentity(kind, value) {
    const previous = record;
    let next = W.identity(previous, kind, value);
    if (next === previous) return;
    // Only the photo connection changed: revalidate the SAME source text and question
    // at the new revision. Image jobs/art still invalidate through change().
    if (W.prepared(previous)) {
      next = W.prepare(next);
      for (const key of ['story', 'briefing']) {
        if (W.validOutput(previous, previous[key])) {
          const output = { ...previous[key], revision: next.contentRevision };
          if (W.validOutput(next, output)) next[key] = output;
        }
      }
      if (W.validQuestion(previous, previous.question)) {
        const question = { ...previous.question, revision: next.contentRevision };
        if (W.validQuestion(next, question)) next.question = question;
      }
      if (W.validOutput(next, next.story)) next = W.bookDetails(next, W.bookMetadata(previous));
    }
    change(next);
    if (W.prepared(record) && !W.validOutput(record, record.story)) generate('story');
  }
  function clearTestimony() { $('testimony-input').value = ''; }
  function candidate(c) {
    const box = node('div', undefined, 'candidate-card'); box.dataset.factId = c.id;
    const state = c.decision === 'confirmed' ? (c.included ? 'statusIncluded' : 'statusExcluded') : c.decision === 'rejected' ? 'statusRejected' : 'statusUnreviewed';
    box.dataset.decision = c.decision; box.dataset.included = String(c.included);
    box.classList.toggle('is-confirmed', c.decision === 'confirmed'); box.classList.toggle('is-rejected', c.decision === 'rejected');
    box.classList.toggle('is-excluded', c.decision === 'confirmed' && !c.included);
    const badge = node('span', t(state), 'state-badge'); badge.prepend(window.TawUI.icon(c.decision === 'confirmed' ? 'check' : c.decision === 'rejected' ? 'cross' : 'clock'));
    const meta = node('div', undefined, 'candidate-meta'); meta.append(badge, node('span', t(c.source === 'memo' ? 'sourceMemo' : 'sourcePhoto'), 'source')); box.append(meta);
    box.append(node('p', c.text, 'candidate-text'));
    if (!c.grounded) box.append(node('p', t('ungrounded'), 'notice'));
    const yes = node('button', t('confirm'), c.decision === 'confirmed' ? 'primary' : ''); yes.disabled = !c.grounded;
    yes.dataset.icon = 'check'; yes.dataset.decision = 'confirmed'; yes.setAttribute('aria-pressed', String(c.decision === 'confirmed'));
    yes.onclick = () => { change(W.decide(record, c.id, 'confirmed')); document.querySelector('[data-fact-id="' + c.id + '"] button[data-decision="confirmed"]')?.focus(); };
    const no = node('button', t('reject'), c.decision === 'rejected' ? 'primary' : '');
    no.dataset.icon = 'cross'; no.dataset.decision = 'rejected'; no.setAttribute('aria-pressed', String(c.decision === 'rejected'));
    no.onclick = () => { change(W.decide(record, c.id, 'rejected')); document.querySelector('[data-fact-id="' + c.id + '"] button[data-decision="rejected"]')?.focus(); };
    const actions = node('div', undefined, 'candidate-actions'); actions.append(yes, no); box.append(actions);
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
  // Bedtime story: each paragraph is rendered with its own illustration slot.
  // Paragraph text is the confirmed story text, unchanged; only the slot
  // content (image, failure note, text-only note, or a make/redraw button)
  // varies. No page-turning UI: pairs simply follow the reading flow.
  function renderStory() {
    const target = $('story'); target.replaceChildren();
    if (!W.validOutput(record, record.story)) return;
    if (record.story.fallback) target.append(node('p', t('fallback'), 'hint'));
    const allowed = paragraphArtAllowed();
    for (const p of W.paragraphs(record)) {
      target.append(node('p', p.text));
      const slot = node('div', undefined, 'para-art');
      if (paragraphArt[p.index]) {
        slot.append(image(paragraphArt[p.index]), node('p', t(artAnchor() ? 'aiArtFromPhoto' : 'aiArtFromText'), 'hint'));
        const redo = node('button', t('paraArtRedo')); redo.disabled = !allowed || !!paragraphBusy[p.index];
        redo.onclick = () => generateParagraphArt(p.index); slot.append(redo);
      } else if (p.sensitive) {
        slot.append(node('p', t('paraSkipped'), 'hint'));
      } else if (p.index >= W.PARAGRAPH_ART_LIMIT) {
        slot.append(node('p', t('paraTextOnly'), 'hint'));
      } else if (!hasArtAnchor()) {
        // One shared no-photo explanation above the story; no repeated empty slots.
        slot.hidden = true;
      } else if (paragraphFailed[p.index]) {
        slot.append(node('p', t('paraArtFailed'), 'notice'));
        const retry = node('button', t('paraArtRetry')); retry.disabled = !allowed || !!paragraphBusy[p.index];
        retry.onclick = () => generateParagraphArt(p.index); slot.append(retry);
      } else {
        const make = node('button', t(paragraphBusy[p.index] ? 'busy' : 'paraArtOne'));
        make.disabled = !allowed || !!paragraphBusy[p.index];
        make.onclick = () => generateParagraphArt(p.index); slot.append(make);
      }
      target.append(slot);
    }
    if (record.story.observations?.length) {
      const details = node('details'); details.append(node('summary', t('photoGroup')));
      for (const line of record.story.observations) details.append(node('p', line.text));
      target.append(details);
    }
  }
  function render() {
    let next = running.extract || running.story || running.briefing ? 'busy' :
      !record.memoText.trim() ? 'nextCapture' : !record.candidates.length ? 'nextExtract' :
      !W.canPrepare(record) ? 'nextConfirm' : !W.prepared(record) ? 'nextPrepare' :
      screen === 'bedtime' ? 'nextSave' : 'nextRead';
    if (screen === 'library') next = 'nextLibrary';
    if (blocked) next = conflicted ? 'conflict' : corrupted ? 'corrupt' : 'unsaved';
    $('next-action').textContent = t(next);
    $('extract-btn').disabled = !!running.extract || !!running.voice || !record.memoText.trim(); $('transcribe-btn').disabled = !!running.voice || !$('voice-input').files.length;
    $('voice-progress').hidden = !running.voice;
    $('voice-warning').hidden = !$('voice-input').files.length || !record.memoText.trim();
    $('voice-check').hidden = !voiceConverted;
    $('photo-status').textContent = photoFile ? photoFile.name : '';
    $('photo-input').setAttribute('aria-label', t(photoFile ? 'changePhoto' : 'choosePhoto'));
    $('photo-pick-label').textContent = t(photoFile ? 'changePhoto' : 'choosePhoto');
    $('remove-photo').hidden = !photoFile;
    $('photo-change-impact').hidden = !record.candidates.length && !running.extract;
    const previewPhoto = $('capture-photo-preview'); previewPhoto.hidden = !photoURL;
    if (previewPhoto.dataset.url !== (photoURL || '')) {
      previewPhoto.replaceChildren(); if (photoURL) previewPhoto.append(image(photoURL));
      previewPhoto.dataset.url = photoURL || '';
    }
    $('nav-review').disabled = !record.candidates.length;
    $('selection-count').textContent = t('selected', { n: W.used(record).length });
    if (screen === 'review') {
      $('memo-candidates').replaceChildren(); $('photo-candidates').replaceChildren();
      $('photo-details').hidden = !photoFile && !record.candidates.some(c => c.source === 'photo');
      for (const c of record.candidates) $(c.source === 'memo' ? 'memo-candidates' : 'photo-candidates').append(candidate(c));
      $('photo-preview').replaceChildren(); if (photoURL) $('photo-preview').append(image(photoURL));
      $('identity-details').hidden = !photoFile;
      $('identity-hint').hidden = !photoFile;
      for (const k of ['people', 'animals']) $('identity-' + k).value = record.identity[k];
    }
    const ready = W.prepared(record);
    $('reading-identity').hidden = !photoFile || !ready;
    for (const kind of ['people', 'animals']) $('reading-' + kind).value = record.identity[kind];
    $('restricted-notice').hidden = ready;
    output($('briefing'), record.briefing); renderStory();
    const storyValid = W.validOutput(record, record.story);
    $('para-art-tools').hidden = !storyValid;
    $('para-art-all').hidden = !hasArtAnchor();
    $('para-art-all').disabled = !paragraphArtAllowed() || paragraphBusy.some(Boolean);
    $('para-art-hint').textContent = !storyValid ? '' : !hasArtAnchor() ? t('readingTextOnly') : !W.imageAllowed(record) ? t('paraGate') : '';
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
    window.TawUI.render(screen, t);
  }
  async function extract() {
    if (running.extract || !record.memoText.trim()) return;
    const token = jobs.begin('extract'), memo = record.memoText, file = photoFile;
    record = W.submit(record); persist();
    running.extract = true; render();
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
      record = Object.assign({}, record, { [kind]: W.compose(start, kind, ids, false) }); if (kind === 'story') { clearParagraphArt(); record = W.bookDetails(record); } persist();
    } catch (e) {
      if (!jobs.current(token)) return;
      // Retain valid prior work; first failure falls back to source passages.
      if (!W.validOutput(record, record[kind])) { record = Object.assign({}, record, { [kind]: W.compose(start, kind, null, true) }); if (kind === 'story') clearParagraphArt(); }
      if (kind === 'story') record = W.bookDetails(record);
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
  function readTogether() {
    show('bedtime');
    if (W.prepared(record) && !W.validOutput(record, record.story)) generate('story');
  }
  async function style() {
    if (running.style || !photoFile || !W.imageAllowed(record)) return;
    const token = jobs.begin('style'), file = photoFile; running.style = true; statuses.style = ''; render();
    try {
      const data = photoData || await API.photo(file);
      if (!jobs.current(token)) return;
      const result = await API.style(data);
      if (!jobs.current(token)) return;
      art = result; acceptedArt = null; clearParagraphArt();
    } catch (e) { if (jobs.current(token)) statuses.style = t('failed', { message: e.message }); }
    finally { if (jobs.current(token)) { running.style = false; render(); } }
  }
  // One /api/image call per paragraph, gated exactly like the single
  // illustration. A failure marks only that paragraph; the rest are unaffected.
  async function generateParagraphArt(index) {
    const paras = W.paragraphs(record), p = paras[index];
    if (!p || p.sensitive || index >= W.PARAGRAPH_ART_LIMIT || paragraphBusy[index] || !paragraphArtAllowed()) return;
    const token = jobs.begin('para' + index), text = p.text;
    paragraphBusy[index] = true; paragraphFailed[index] = false; render();
    try {
      if (photoFile && !photoData && !acceptedArt) photoData = await API.photo(photoFile);
      if (!jobs.current(token)) return;
      // Blocked before the call: without an anchor no /api/image request
      // (in particular none with an empty images array) may go out.
      const anchor = artAnchor();
      if (!anchor) return;
      const url = await API.paragraphArt(text, anchor);
      if (!jobs.current(token)) return;
      paragraphArt[index] = url;
    } catch (e) { if (jobs.current(token)) paragraphFailed[index] = true; }
    finally { if (jobs.current(token)) { paragraphBusy[index] = false; render(); } }
  }
  async function generateAllParagraphArt() {
    if (!paragraphArtAllowed()) return;
    const paras = W.paragraphs(record);
    for (const p of paras) if (!paragraphArt[p.index] && !p.sensitive && p.index < W.PARAGRAPH_ART_LIMIT) await generateParagraphArt(p.index);
  }
  async function voice() {
    const file = $('voice-input').files[0]; if (!file || running.voice) return;
    const token = jobs.begin('voice'); running.voice = true; message(t('busy')); render();
    try {
      const text = await API.voice(file, I.languageInfo(I.getLanguage()).bias);
      if (!jobs.current(token)) return;
      $('memo-input').value = text; voiceConverted = true; change(W.input(record, text));
    } catch (e) { if (jobs.current(token)) fail(e); }
    finally { if (jobs.current(token)) { running.voice = false; render(); } }
  }
  async function load() {
    synced = false;
    const stored = await S.load(db); const legacy = localStorage.getItem('taw-day-v1');
    // Adopt the stored version only together with a record that passed sanitize.
    let next;
    try {
      next = stored.record ? W.sanitize(stored.record) : (stored.version === 0 && legacy ? W.migrate(legacy) : W.create());
    } catch (e) {
      // Damaged record: quarantine the raw form, keep its version for an
      // explicit CAS recovery, and boot with a fresh in-memory record so the
      // app (including saved books) stays reachable behind the banner.
      quarantined = stored.record;
      try { localStorage.setItem('taw-quarantine-v2', JSON.stringify({ at: Date.now(), version: stored.version, record: stored.record })); } catch {}
      storageVersion = stored.version; record = W.create(); loaded = true;
      $('memo-input').value = ''; corruptWarning(report('load', e));
      return;
    }
    quarantined = null;
    storageVersion = stored.version; record = next; synced = true;
    loaded = true; blocked = false; conflicted = false; corrupted = false; $('storage-warning').hidden = true; $('memo-input').value = record.memoText;
    if (!stored.record) await persist();
  }
  async function init() {
    const lang = localStorage.getItem('taw-lang') || navigator.language.split('-')[0];
    I.setLanguage(lang);
    for (const [key, translated] of [['translatedLanguages', true], ['fallbackLanguages', false]]) {
      const group = node('optgroup'); group.dataset.label = key;
      for (const item of I.languages().filter(item => ['ko', 'en'].includes(item.code) === translated)) {
        const option = node('option', item.name); option.value = item.code; group.append(option);
      }
      $('lang-select').append(group);
    }
    $('lang-select').value = I.getLanguage(); translate();
    $('lang-select').onchange = () => { I.setLanguage($('lang-select').value); localStorage.setItem('taw-lang', I.getLanguage()); translate(); render(); };
    $('theme-toggle').onclick = () => {
      const theme = document.documentElement.dataset.theme === 'dusk' ? 'paper' : 'dusk';
      document.documentElement.dataset.theme = theme;
      try { localStorage.setItem('taw-theme', theme); } catch { /* Reading still works when preference storage is unavailable. */ }
      window.TawUI.render(screen, t);
    };
    $('memo-input').oninput = () => change(W.input(record, $('memo-input').value));
    $('photo-input').onchange = () => updatePhoto($('photo-input').files[0] || null);
    $('remove-photo').onclick = () => { updatePhoto(null); $('photo-input').focus(); };
    $('voice-input').onchange = () => { jobs.begin('voice'); running.voice = false; render(); };
    $('extract-btn').onclick = extract; $('transcribe-btn').onclick = voice;
    $('prepare-btn').onclick = preview;
    $('nav-preview').onclick = () => W.validOutput(record, record.story) ? readTogether() : preview();
    $('nav-review').onclick = () => show('review');
    $('nav-capture').onclick = $('edit-input').onclick = () => show('capture');
    for (const k of ['people', 'animals']) $('identity-' + k).onchange = () => change(W.identity(record, k, $('identity-' + k).value));
    for (const k of ['people', 'animals']) $('reading-' + k).onchange = () => readingIdentity(k, $('reading-' + k).value);
    $('edit-reading').onclick = preview;
    $('briefing-retry').onclick = () => generate('briefing'); $('story-retry').onclick = () => generate('story');
    $('another-question').onclick = () => nextQuestion();
    $('question-text').oninput = () => { if (!record.question) return; record = Object.assign({}, record, { question: Object.assign({}, record.question, { text: $('question-text').value, edited: true }) }); persist(); $('question-meta').textContent = t('edited'); };
    $('open-bedtime').onclick = readTogether;
    $('para-art-all').onclick = generateAllParagraphArt;
    $('style-btn').onclick = style;
    $('accept-art').onclick = () => { if (W.imageAllowed(record)) acceptedArt = art; render(); };
    $('reject-art').onclick = () => { acceptedArt = null; art = null; render(); };
    $('save-testimony').onclick = () => { const text = $('testimony-input').value.trim(); if (!text) return;
      record = Object.assign({}, record, { testimony: record.testimony.concat({ text, at: Date.now(), revision: record.contentRevision, question: record.question?.text || null }) });
      $('testimony-input').value = ''; persist(); render(); };
    $('new-day-btn').onclick = () => { if (!confirm(t('newDayConfirm'))) return; invalidate(); clearPhoto(); clearVoice(); clearTestimony(); record = W.create(); $('memo-input').value = ''; persist(); show('capture'); };
    $('download-draft').onclick = () => corrupted && quarantined
      ? download('taw-damaged-record.json', JSON.stringify(quarantined, null, 2), 'application/json')
      : download('taw-unsaved.json', JSON.stringify(record, null, 2), 'application/json');
    $('reload-record').onclick = async () => { invalidate(); clearPhoto(); clearVoice(); clearTestimony(); await queue; try { await load(); show('capture'); } catch (e) { storageWarning(false, report('load', e)); } };
    $('retry-save').onclick = retrySave; $('start-fresh').onclick = startFresh;
    let stage = 'open';
    try { db = await S.open(); stage = 'load'; await load(); } catch (e) { loaded = true; storageWarning(false, report(stage, e)); }
    window.addEventListener('beforeunload', event => { if (blocked) { event.preventDefault(); event.returnValue = ''; } });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    render();
    // Extension boundary for local books. No service credentials or mutable globals exposed.
    if (window.TawBooksUI) window.TawBooksUI.init({ getRecord: () => record, getDB: () => db, getArt: () => W.imageAllowed(record) ? acceptedArt : null,
      getParagraphArts: () => W.imageAllowed(record) ? paragraphArt.slice() : [],
      setBookDetails: patch => { record = W.bookDetails(record, patch); persist(); render(); },
      getVersion: () => storageVersion, flush: () => queue, isBlocked: () => blocked, t, node, image, show, message, fail, download, openDialog, closeDialog,
      reset: async () => {
        if (blocked) throw Error('Unsaved changes'); blocked = true;
        try {
          await queue; const next = W.create();
          storageVersion = await S.save(db, next, storageVersion, true);
          invalidate(); clearPhoto(); clearVoice(); clearTestimony(); record = next; $('memo-input').value = '';
          localStorage.removeItem('taw-day-v1'); show('capture');
        } finally { blocked = false; render(); }
      } });
    history.replaceState({ taw: true, screen: 'capture', scroll: 0 }, '');
    history.scrollRestoration = 'manual'; navigationReady = true;
    window.addEventListener('popstate', restoreHistory);
    window.TAW_READY = true;
  }
  init().catch(fail);
})();
