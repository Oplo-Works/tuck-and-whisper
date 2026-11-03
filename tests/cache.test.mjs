import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
test('shell CACHE and footer match; each script is precached, user media is absent', () => {
  const sw = fs.readFileSync('web/sw.js', 'utf8'), html = fs.readFileSync('web/index.html', 'utf8');
  const version = Number(sw.match(/const CACHE = 'taw-shell-v(\d+)'/)[1]);
  assert.equal(version, Number(html.match(/shell v(\d+)/)[1]));
  const shell = sw.match(/const SHELL = \[([^\]]+)\]/)[1];
  for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) { assert.ok(shell.includes("'./" + src + "'"), src); assert.ok(fs.existsSync('web/' + src)); }
  assert.doesNotMatch(shell, /8940|data:|blob:|\.jpe?g|\.png|\.webp/);
  const status = execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8' });
  if (/^web\//m.test(status)) {
    const old = execFileSync('git', ['show', 'HEAD:web/sw.js'], { encoding: 'utf8' });
    assert.equal(version, Number(old.match(/const CACHE = 'taw-shell-v(\d+)'/)[1]) + 1);
  }
});
