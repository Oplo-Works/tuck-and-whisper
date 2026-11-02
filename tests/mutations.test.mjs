import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const source = fs.readFileSync('web/workflow.js', 'utf8');
function build(text) {
  const context = { module: { exports: {} }, require: createRequire(new URL('../web/workflow.js', import.meta.url)), crypto: globalThis.crypto };
  vm.runInNewContext(text, context); return context.module.exports;
}
function inclusionOracle(W) {
  const r = W.create(); r.candidates = [{ id: 'F1', text: 'USE', decision: 'confirmed', included: true }, { id: 'F2', text: 'DO_NOT_USE', decision: 'confirmed', included: false }];
  return JSON.stringify(W.used(r).map(c => c.id)) === '["F1"]';
}
function epochOracle(W) { const jobs = W.jobs(), old = jobs.begin('story'); jobs.invalidate(); return jobs.current(old) === false; }
function proseOracle(W) {
  let r = W.input(W.create(), '강아지를 좋아했어요.');
  r = W.extract(r, { candidates: [{ text: '강아지를 좋아했어요.', quote: '강아지를 좋아했어요.', source: 'memo', grade: 'B' }] });
  r = W.prepare(W.decide(r, r.candidates[0].id, 'confirmed'));
  return W.compose(r, 'story', null, true).lines[0].text === '강아지를 좋아했어요.';
}
for (const [name, original, replacement, oracle] of [
  ['included filter removal', "c.decision === 'confirmed' && c.included", "c.decision === 'confirmed'", inclusionOracle],
  ['epoch invalidation removal', 'invalidate() { epoch++; }', 'invalidate() {}', epochOracle],
  ['invented causal prose', 'lines: chosen.map(c => ({ text: c.text,', "lines: chosen.map(c => ({ text: '좋아해서 이름을 지었어요.',", proseOracle]
]) test('independent oracle kills mutant: ' + name, () => {
  assert.ok(source.includes(original)); assert.equal(oracle(build(source)), true);
  assert.equal(oracle(build(source.replace(original, replacement))), false);
});
