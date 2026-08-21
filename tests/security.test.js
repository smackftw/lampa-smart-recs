const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = ['smart-recs.js', 'trailer-player.html']
  .map((file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  .join('\n');

test('distribution does not contain common secret formats', () => {
  assert.doesNotMatch(source, /\bsk-[A-Za-z0-9_-]{16,}\b/);
  assert.doesNotMatch(source, /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/i);
  assert.doesNotMatch(source, /Bearer\s+[A-Za-z0-9._-]{20,}/);
});

test('watch history is not uploaded by the base plugin', () => {
  assert.doesNotMatch(source, /cinema\.maxbob\.xyz/);
  assert.doesNotMatch(source, /SYNC_UID/);
  assert.doesNotMatch(source, /\/sync\/push/);
});

test('protected access code is explicitly non-persistent', () => {
  assert.match(source, /nosave:\s*true/);
  assert.match(source, /runtime\.sessions/);
  assert.doesNotMatch(source, /storageSet\([^)]*access_code/);
});
