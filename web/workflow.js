/* v2 product contract. core.js remains the v1 reader and normalization boundary. */
(function (root, factory) {
  const api = factory(typeof module === 'object' ? require('./core.js') : root.TawCore);
  if (typeof module === 'object') module.exports = api; else root.TawWorkflow = api;
})(typeof globalThis === 'object' ? globalThis : this, function (Legacy) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const states = ['undecided', 'confirmed', 'rejected'];
  const relations = ['unconfirmed', 'same', 'absent', 'different', 'unsure'];
  function create() {
    return { schemaVersion: 2, dayId: globalThis.crypto.randomUUID(), mode: 'live', memoText: '',
      sourceRevision: 0, contentRevision: 0, selectedRevision: null, candidates: [], unknowns: [],
      identity: { people: 'unconfirmed', animals: 'unconfirmed' },
      briefing: null, story: null, question: null, testimony: [], history: [], legacy: null };
  }
  function used(r) { return r.candidates.filter(c => c.decision === 'confirmed' && c.included && c.grounded).map(copy); }
  function canPrepare(r) { return used(r).some(c => c.source === 'memo'); }
  function prepared(r) { return canPrepare(r) && r.selectedRevision === r.contentRevision; }
  function imageAllowed(r) { return prepared(r) && Object.values(r.identity).every(x => x === 'same' || x === 'absent'); }
  function changed(r, patch, action, before, after) {
    const n = Object.assign({}, r, patch, { contentRevision: r.contentRevision + 1, selectedRevision: null,
      briefing: null, story: null, question: null });
    n.history = r.history.concat({ action, before, after, at: Date.now(), revision: n.contentRevision });
    return n;
  }
  function input(r, memoText) {
    return changed(r, { memoText, sourceRevision: r.sourceRevision + 1, candidates: [], unknowns: [],
      identity: { people: 'unconfirmed', animals: 'unconfirmed' } }, 'input', r.sourceRevision, r.sourceRevision + 1);
  }
  function extract(r, raw) {
    const normalized = Legacy.normalizeSpark(raw);
    let candidates = normalized.candidates.map((c, index) => {
      const original = (raw.candidates || []).find(x => x.text === c.text && x.source === c.source) || {};
      const quote = typeof original.quote === 'string' ? original.quote.trim() : '';
      // Memo candidates are exact source excerpts, not unverified paraphrases.
      const grounded = c.source === 'photo' || (quote.length > 0 && r.memoText.includes(quote));
      return { id: 'R' + r.sourceRevision + 'F' + (index + 1), text: c.source === 'memo' && grounded ? quote : c.text,
        proposal: c.text, quote, grounded, source: c.source, grade: c.grade,
        decision: 'undecided', included: false, order: index };
    });
    candidates.sort((a, b) => a.source !== b.source ? (a.source === 'memo' ? -1 : 1) :
      a.source === 'memo' && a.grounded && b.grounded ? r.memoText.indexOf(a.quote) - r.memoText.indexOf(b.quote) : a.order - b.order);
    // Known dependent openings are not independent review choices. Join only
    // adjacent exact source spans; never manufacture a new linking sentence.
    const grouped = [];
    for (const c of candidates) {
      const previous = grouped.at(-1);
      if (previous?.source === 'memo' && previous.grounded && c.source === 'memo' && c.grounded &&
          /^(왜냐하면|그중|그 중|그래서|하지만|그 때문에|because\b|therefore\b|that's why\b|but\b)/i.test(c.quote)) {
        const start = r.memoText.indexOf(previous.quote), next = r.memoText.indexOf(c.quote);
        if (next >= start + previous.quote.length && !r.memoText.slice(start + previous.quote.length, next).trim()) {
          previous.quote = r.memoText.slice(start, next + c.quote.length); previous.text = previous.quote;
          previous.proposal += '\n' + c.proposal; continue;
        }
      }
      grouped.push(c);
    }
    candidates = grouped;
    return changed(r, { candidates, unknowns: normalized.unknowns }, 'extract', null, candidates.map(c => c.id));
  }
  function decide(r, id, decision) {
    if (!states.includes(decision)) throw Error('Invalid decision');
    const c = r.candidates.find(c => c.id === id);
    if (!c || (decision === 'confirmed' && !c.grounded)) throw Error('Ungrounded candidate');
    if (c.decision === decision) return r;
    return changed(r, { candidates: r.candidates.map(x => x.id === id ? Object.assign({}, x, {
      decision, included: decision === 'confirmed' }) : x) }, 'decision', { id, decision: c.decision, included: c.included },
    { id, decision, included: decision === 'confirmed' });
  }
  function include(r, id, value) {
    const c = r.candidates.find(x => x.id === id);
    if (!c || c.decision !== 'confirmed' || (value && !c.grounded) || typeof value !== 'boolean') throw Error('Not confirmed with source');
    if (c.included === value) return r;
    return changed(r, { candidates: r.candidates.map(x => x.id === id ? Object.assign({}, x, { included: value }) : x) },
      'inclusion', { id, included: c.included }, { id, included: value });
  }
  function identity(r, kind, value) {
    if (!['people', 'animals'].includes(kind) || !relations.includes(value)) throw Error('Invalid relation');
    if (r.identity[kind] === value) return r;
    return changed(r, { identity: Object.assign({}, r.identity, { [kind]: value }) }, 'identity',
      { kind, value: r.identity[kind] }, { kind, value });
  }
  function prepare(r) { return Object.assign({}, r, { selectedRevision: canPrepare(r) ? r.contentRevision : null }); }
  // A selector may only choose IDs. No generated prose reaches the reading page.
  // Story keeps all selected memo excerpts, so dependent clauses cannot be silently omitted.
  function compose(r, kind, ids, fallback) {
    if (!prepared(r) || !['briefing', 'story'].includes(kind)) throw Error('Not prepared');
    const facts = used(r).filter(c => c.source === 'memo');
    if (ids && (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !facts.some(c => c.id === id)))) throw Error('Invalid selection');
    const chosen = kind === 'story' || fallback || !ids ? facts : facts.filter(c => ids.includes(c.id));
    return { kind, revision: r.contentRevision, fallback: !!fallback,
      observations: used(r).filter(c => c.source === 'photo').map(c => ({ text: c.text, factIds: [c.id] })),
      lines: chosen.map(c => ({ text: c.text, factIds: [c.id], paragraphEnd: fallback || kind === 'briefing' || !ids || ids.includes(c.id) })) };
  }
  function validOutput(r, output) {
    if (!prepared(r) || !output || output.revision !== r.contentRevision || !Array.isArray(output.lines) || !output.lines.length) return false;
    const facts = used(r).filter(c => c.source === 'memo');
    let last = -1;
    if (!output.lines.every(l => {
      if (!Array.isArray(l.factIds) || l.factIds.length !== 1) return false;
      const index = facts.findIndex(c => c.id === l.factIds[0] && c.text === l.text);
      if (index <= last) return false; last = index; return true;
    })) return false;
    if (output.kind === 'story' && output.lines.length !== facts.length) return false;
    const photos = used(r).filter(c => c.source === 'photo');
    return !output.observations || (Array.isArray(output.observations) && output.observations.every(l =>
      l.factIds?.length === 1 && photos.some(c => c.id === l.factIds[0] && c.text === l.text)));
  }
  function question(r, index, template) {
    const facts = used(r).filter(c => c.source === 'memo');
    if (!prepared(r) || index >= facts.length) return null;
    const fact = facts[index];
    return { text: template.replace('{fact}', fact.text), factIds: [fact.id], revision: r.contentRevision,
      index, edited: false, unknownId: null };
  }
  // Paragraphs come only from story paragraph boundaries (paragraphEnd), never
  // from sentences or periods. Re-joining the paragraphs must reproduce the
  // story lines exactly; if it does not, fall back to a single paragraph.
  const PARAGRAPH_ART_LIMIT = 5;
  const SENSITIVE_SCENE = /목욕|갈아입|옷을\s*갈아|수영|샤워|bath|shower|swim|undress|changing\s+clothes/i;
  function paragraphs(r) {
    if (!validOutput(r, r.story)) return [];
    const groups = []; let current = [];
    for (const line of r.story.lines) { current.push(line); if (line.paragraphEnd !== false) { groups.push(current); current = []; } }
    if (current.length) groups.push(current);
    const flat = groups.flatMap(g => g.map(l => l.text));
    const exact = flat.length === r.story.lines.length && flat.every((text, i) => text === r.story.lines[i].text);
    const source = exact ? groups : [r.story.lines];
    return source.map((lines, index) => { const text = lines.map(l => l.text).join(' '); return {
      index, lines: lines.map(l => l.text), text, factIds: lines.map(l => l.factIds[0]),
      sensitive: SENSITIVE_SCENE.test(text) }; });
  }
  function validQuestion(r, q) {
    const ids = new Set(used(r).map(c => c.id));
    return !!(prepared(r) && q && typeof q.text === 'string' && q.text.trim() && q.revision === r.contentRevision &&
      Array.isArray(q.factIds) && q.factIds.length && q.factIds.every(id => ids.has(id)));
  }
  function migrate(raw) {
    const old = Legacy.restore(raw);
    if (!old) throw Error('Invalid v1 record');
    let n = create();
    n.memoText = old.memoText; n.mode = old.mode;
    n.candidates = old.candidates.map((c, index) => Object.assign({}, c, {
      included: false, proposal: c.text, quote: old.memoText.includes(c.text) ? c.text : '',
      grounded: c.source === 'photo' || old.memoText.includes(c.text), order: index }));
    n.unknowns = old.unknowns; n.testimony = old.testimony;
    n.legacy = { briefing: old.briefing, story: old.pageSentences, question: old.questionCard };
    n.history = [{ action: 'migrate-v1', before: null, after: 'All facts unused; re-extract missing excerpts', at: Date.now(), revision: 0 }];
    return n;
  }
  function sanitize(raw) {
    if (!raw || raw.schemaVersion !== 2 || typeof raw.dayId !== 'string' || typeof raw.memoText !== 'string' ||
      !Number.isSafeInteger(raw.contentRevision) || raw.contentRevision < 0 || !Number.isSafeInteger(raw.sourceRevision) || raw.sourceRevision < 0 ||
      !Array.isArray(raw.candidates) || !Array.isArray(raw.history) || !Array.isArray(raw.testimony) ||
      !Array.isArray(raw.unknowns)) throw Error('Invalid record');
    const n = create();
    for (const key of Object.keys(n)) if (Object.hasOwn(raw, key)) n[key] = copy(raw[key]);
    // Entry-level validation: a single null or malformed item must reject the
    // record here, not crash rendering later (testimony/history are rendered
    // unconditionally or in the audit trail).
    n.unknowns = n.unknowns.map(u => {
      if (!u || typeof u !== 'object' || typeof u.id !== 'string' || typeof u.text !== 'string') throw Error('Invalid unknown');
      return u;
    });
    n.testimony = n.testimony.map(item => {
      if (!item || typeof item !== 'object' || typeof item.text !== 'string' ||
        typeof item.at !== 'number' || !Number.isFinite(item.at)) throw Error('Invalid testimony');
      return item;
    });
    n.history = n.history.map(item => {
      if (!item || typeof item !== 'object' || typeof item.action !== 'string' || !item.action ||
        typeof item.at !== 'number' || !Number.isFinite(item.at)) throw Error('Invalid history');
      return item;
    });
    const seen = new Set();
    n.candidates = n.candidates.map(c => {
      if (!c || typeof c.id !== 'string' || seen.has(c.id) || typeof c.text !== 'string' || !c.text.trim() ||
        !states.includes(c.decision) || !['photo', 'memo'].includes(c.source) || typeof c.included !== 'boolean') throw Error('Invalid candidate');
      seen.add(c.id);
      const grounded = c.source === 'photo' || (typeof c.quote === 'string' && c.quote.length > 0 && c.quote === c.text && n.memoText.includes(c.quote));
      if (c.included && (c.decision !== 'confirmed' || !grounded)) throw Error('Invalid inclusion');
      return { id: c.id, text: c.text, quote: typeof c.quote === 'string' ? c.quote : '',
        proposal: typeof c.proposal === 'string' ? c.proposal : c.text, grounded, source: c.source, grade: c.grade === 'B' ? 'B' : 'C',
        decision: c.decision, included: c.included, order: Number.isSafeInteger(c.order) ? c.order : 0 };
    });
    if (!n.identity || !relations.includes(n.identity.people) || !relations.includes(n.identity.animals)) throw Error('Invalid identity');
    if (!validOutput(n, n.briefing)) n.briefing = null;
    if (!validOutput(n, n.story)) n.story = null;
    if (!validQuestion(n, n.question)) n.question = null;
    return n;
  }
  // Epoch changes only for invalidating events; independent job completions never change it.
  function jobs() {
    let epoch = 0; const serials = new Map();
    return { invalidate() { epoch++; }, begin(name) { const seq = (serials.get(name) || 0) + 1; serials.set(name, seq); return { epoch, seq, name }; },
      current(token) { return token.epoch === epoch && token.seq === serials.get(token.name); } };
  }
  return { create, used, canPrepare, prepared, imageAllowed, input, extract, decide, include, identity, prepare,
    compose, validOutput, paragraphs, PARAGRAPH_ART_LIMIT, question, validQuestion, migrate, sanitize, jobs };
});
