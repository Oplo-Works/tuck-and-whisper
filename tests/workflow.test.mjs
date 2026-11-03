import test from 'node:test';
import assert from 'node:assert/strict';
import W from '../web/workflow.js';
const memo = '아이가 강아지를 좋아했어요. 들판에서 만나 들이라고 이름 지었어요. 엄마가 “들이는 들이 엄마와 살고 싶을 거야”라고 말했어요.';
export function fixture() {
  let r = W.input(W.create(), memo);
  return W.extract(r, { candidates: memo.split(/(?<=\.) /).map(text => ({ text, quote: text, source: 'memo', grade: 'B' })).concat({ text: '사진에서는 접촉이 보이지 않아요.', source: 'photo', grade: 'C' }) });
}
function ready() { let r = fixture(); for (const c of r.candidates.filter(c => c.source === 'memo')) r = W.decide(r, c.id, 'confirmed'); return W.prepare(r); }
test('memo alone prepares while unopened photo remains undecided', () => {
  const r = ready(); assert.equal(W.prepared(r), true); assert.equal(r.candidates.at(-1).decision, 'undecided'); assert.equal(W.used(r).length, 3);
});
test('confirmed unused differs from rejected and re-inclusion invalidates output', () => {
  let r = ready(); const id = r.candidates[0].id;
  r.story = W.compose(r, 'story', [id], false); r = W.include(r, id, false);
  assert.equal(r.candidates[0].decision, 'confirmed'); assert.equal(W.used(r).some(c => c.id === id), false); assert.equal(r.story, null);
  r = W.include(r, id, true); assert.equal(W.prepared(r), false); assert.equal(r.history.at(-1).action, 'inclusion');
});
test('photo-only remains restricted', () => { let r = fixture(); r = W.decide(r, r.candidates.at(-1).id, 'confirmed'); assert.equal(W.canPrepare(r), false); });
test('ungrounded memo paraphrase cannot be confirmed', () => {
  const r = W.extract(W.input(W.create(), '메모'), { candidates: [{ text: '행복해서 이름을 지었다', quote: '없는 원문', source: 'memo', grade: 'B' }] });
  assert.throws(() => W.decide(r, r.candidates[0].id, 'confirmed'));
});
test('source quotes override invented model paraphrases; source order wins', () => {
  const r = W.extract(W.input(W.create(), '먼저 왔다. 나중에 갔다.'), { candidates: [
    { text: '행복해서 갔다.', quote: '나중에 갔다.', source: 'memo', grade: 'B' },
    { text: '먼저 왔다.', quote: '먼저 왔다.', source: 'memo', grade: 'C' }] });
  assert.deepEqual(r.candidates.map(c => c.text), ['먼저 왔다.', '나중에 갔다.']);
});
test('a separate causal fragment cannot be selected without its adjacent source passage', () => {
  const text = '이름은 들이야. 왜냐하면 들판에서 만났기 때문이야.';
  const r = W.extract(W.input(W.create(), text), { candidates: ['이름은 들이야.', '왜냐하면 들판에서 만났기 때문이야.'].map(quote => ({ text: quote, quote, source: 'memo', grade: 'B' })) });
  assert.equal(r.candidates.length, 1); assert.equal(r.candidates[0].text, text); assert.equal(r.candidates[0].quote, text);
});
test('selector cannot add facts, causal links, reorder or delete story passages', () => {
  const r = ready(), ids = W.used(r).map(c => c.id);
  assert.throws(() => W.compose(r, 'story', ['unknown'], false));
  const story = W.compose(r, 'story', ids.slice().reverse(), false);
  assert.deepEqual(story.lines.map(l => l.text), memo.split(/(?<=\.) /));
  assert.equal(W.validOutput(r, { ...story, lines: [{ text: '좋아해서 이름을 지었다.', factIds: [ids[0]] }] }), false);
  assert.equal(W.validOutput(W.include(r, ids[0], false), story), false);
});
test('reported speech, reasons and observation qualifiers remain literal', () => {
  const r = ready(), out = W.compose(r, 'story', null, true);
  assert.match(out.lines[1].text, /들판에서/); assert.match(out.lines[2].text, /엄마가.*들이 엄마.*말했/);
  assert.equal(out.lines.some(l => /닿아 있지/.test(l.text)), false);
});
test('partial identity does not allow a whole photo; changes invalidate selection', () => {
  let r = ready(); r = W.prepare(W.identity(r, 'people', 'same')); assert.equal(W.imageAllowed(r), false);
  r = W.prepare(W.identity(r, 'animals', 'same')); assert.equal(W.imageAllowed(r), true);
  r = W.identity(r, 'animals', 'different'); assert.equal(W.imageAllowed(r), false); assert.equal(W.prepared(r), false);
});
test('identity is invalidated even when replacing a photo before first extraction', () => {
  let r = W.identity(W.create(), 'people', 'same'); r = W.input(r, ''); assert.equal(r.identity.people, 'unconfirmed'); assert.equal(r.sourceRevision, 1);
});
test('safe question uses only selected memo context; exhausted alternatives return null', () => {
  let r = ready(); r = W.prepare(W.include(r, r.candidates[0].id, false));
  const q = W.question(r, 0, '“{fact}” 기억나는 장면은?');
  assert.equal(q.factIds[0], r.candidates[1].id); assert.equal(q.unknownId, null); assert.equal(W.question(r, 2, '{fact}'), null);
  assert.equal(W.validQuestion(W.include(r, q.factIds[0], false), q), false);
});
test('migration preserves decisions and old results but never implies a new use choice', () => {
  const old = { mode: 'live', memoText: '메모', candidates: [{ id: 'F1', text: '메모', source: 'memo', grade: 'C', decision: 'confirmed' }], unknowns: [], testimony: [{ text: '답', at: 1 }] };
  const before = JSON.stringify(old), r = W.migrate(old);
  assert.equal(r.candidates[0].included, false); assert.equal(r.candidates[0].decision, 'confirmed'); assert.equal(W.prepared(r), false);
  assert.equal(r.testimony[0].text, '답'); assert.equal(JSON.stringify(old), before); assert.equal(r.history[0].action, 'migrate-v1');
});
test('a legacy confirmed paraphrase without a literal memo source cannot be re-included', () => {
  const r = W.migrate({ mode: 'live', memoText: '좋아했어요.', candidates: [{ id: 'F1', text: '좋아해서 이름을 지었다.', source: 'memo', grade: 'B', decision: 'confirmed' }], unknowns: [] });
  assert.throws(() => W.include(r, 'F1', true)); assert.deepEqual(W.used(r), []);
});
test('stored stale or tampered outputs are discarded and forbidden inclusion rejected', () => {
  const r = ready(); r.story = { revision: r.contentRevision, lines: [{ text: '새 원인', factIds: [r.candidates[0].id] }] };
  assert.equal(W.sanitize(r).story, null); r.candidates.at(-1).included = true; assert.throws(() => W.sanitize(r));
});
test('DS1 independent jobs survive completion; all invalidation events kill old work', () => {
  const j = W.jobs(), story = j.begin('story'), art = j.begin('art'), briefing = j.begin('briefing'), question = j.begin('question');
  assert.ok([story, art, briefing, question].every(j.current));
  j.begin('question'); assert.equal(j.current(question), false); assert.equal(j.current(story), true);
  j.invalidate(); assert.ok([story, art, briefing].every(t => !j.current(t)));
});
test('generation failure leaves selection valid for fallback and retry', () => {
  const r = ready(), out = W.compose(r, 'story', null, true); assert.equal(W.prepared(r), true); assert.equal(W.validOutput(r, out), true);
});
test('paragraphs split only on paragraph boundaries and rejoin to the exact story', () => {
  const r = ready(), ids = W.used(r).filter(c => c.source === 'memo').map(c => c.id);
  r.story = W.compose(r, 'story', [ids[0]], false);
  const paras = W.paragraphs(r);
  // Three confirmed passages in two paragraphs: the second paragraph holds two
  // sentences yet stays one paragraph (no sentence/period splitting).
  assert.equal(paras.length, 2); assert.equal(paras[1].lines.length, 2);
  assert.deepEqual(paras.flatMap(p => p.lines), r.story.lines.map(l => l.text));
  assert.equal(paras[0].text, r.story.lines[0].text);
  assert.equal(W.paragraphs(W.create()).length, 0);
  assert.ok(Number.isInteger(W.PARAGRAPH_ART_LIMIT) && W.PARAGRAPH_ART_LIMIT >= 1);
});
test('sensitive scenes are marked text-only at paragraph level', () => {
  let r = W.input(W.create(), '아이가 목욕을 했어요. 공원에서 놀았어요.');
  r = W.extract(r, { candidates: ['아이가 목욕을 했어요.', '공원에서 놀았어요.'].map(text => ({ text, quote: text, source: 'memo', grade: 'C' })) });
  for (const c of r.candidates) r = W.decide(r, c.id, 'confirmed');
  r = W.prepare(r); r.story = W.compose(r, 'story', null, true);
  const paras = W.paragraphs(r);
  assert.equal(paras.find(p => p.text.includes('목욕')).sensitive, true);
  assert.equal(paras.find(p => p.text.includes('공원')).sensitive, false);
});
test('sanitize rejects malformed testimony, history and unknown entries instead of passing them to rendering', () => {
  const clone = () => JSON.parse(JSON.stringify(ready()));
  const valid = clone(); valid.testimony = [{ text: '답', at: 1, revision: 0, question: null }];
  assert.equal(W.sanitize(valid).testimony[0].text, '답');
  for (const bad of [[null], ['text'], [{ at: 1 }], [{ text: '답' }], [{ text: 1, at: 1 }], [{ text: '답', at: 'now' }]]) {
    const r = clone(); r.testimony = bad; assert.throws(() => W.sanitize(r), /Invalid testimony/, JSON.stringify(bad));
  }
  for (const bad of [[null], [{ at: 1 }], [{ action: 'input' }], [{ action: 1, at: 1 }], [{ action: '', at: 1 }]]) {
    const r = clone(); r.history = bad; assert.throws(() => W.sanitize(r), /Invalid history/, JSON.stringify(bad));
  }
  for (const bad of [[null], ['text'], [{ text: '모름' }], [{ id: 'U1' }], [{ id: 1, text: '모름' }]]) {
    const r = clone(); r.unknowns = bad; assert.throws(() => W.sanitize(r), /Invalid unknown/, JSON.stringify(bad));
  }
  const noUnknowns = clone(); delete noUnknowns.unknowns; assert.throws(() => W.sanitize(noUnknowns));
});

test('metadata uses confirmed story only; optional fields, edits and midnight keep content intact', () => {
  let r = W.input(W.create(), 'UNCONFIRMED_SECRET. 확정된 하루.');
  r = W.submit(r, new Date(2026, 10, 2, 23, 59).getTime());
  r = W.extract(r, { candidates: ['UNCONFIRMED_SECRET.', '확정된 하루.'].map(text => ({ text, quote: text, source: 'memo', grade: 'C' })) });
  r = W.prepare(W.decide(r, r.candidates[1].id, 'confirmed'));
  r.story = W.compose(r, 'story', null, false); r.testimony.push({ text: 'PRIVATE_RESPONSE', at: 1 });
  r = W.bookDetails(r);
  assert.equal(r.title, '확정된 하루.'); assert.equal(r.eventDate, '2026-11-02');
  const story = JSON.stringify(r.story), title = r.title;
  r = W.bookDetails(r, { eventDate: '2026-10-30' });
  assert.equal(r.title, title); assert.equal(JSON.stringify(r.story), story);
  assert.equal(W.submit(r, new Date(2026, 10, 3).getTime()).submittedAt, r.submittedAt);
  assert.deepEqual(W.sanitize(r), r);
  r = W.bookDetails(r, { title: '부모가 고친 제목' });
  assert.equal(W.sanitize(r).title, '부모가 고친 제목');
  r = W.bookDetails(r, { title: '', eventDate: '' });
  assert.match(r.title, /2026-11-02/); assert.equal(r.eventDate, '2026-11-02');
  assert.equal(JSON.stringify(r.story), story);
  assert.equal(W.validDate('2026-02-30'), false);
  delete r.eventDate; delete r.title; delete r.titleRevision;
  const restored = W.sanitize(r);
  assert.equal(restored.eventDate, '2026-11-02'); assert.equal(restored.title, title);
  const unused = W.include(restored, restored.candidates[1].id, false);
  assert.doesNotMatch(W.bookMetadata(unused).title, /확정된|UNCONFIRMED|PRIVATE/);
});
