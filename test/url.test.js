import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samePage } from '../src/runtime.js';

test('samePage ignores a hash and a trailing slash', () => {
  assert.equal(samePage('https://a.test/x', 'https://a.test/x/'), true);
  assert.equal(samePage('https://a.test/x#frag', 'https://a.test/x'), true);
  assert.equal(samePage('https://a.test/x?q=1', 'https://a.test/x'), false);
  assert.equal(samePage('https://a.test/x', 'https://b.test/x'), false);
  assert.equal(samePage('not a url', 'https://a.test/'), false);
});
