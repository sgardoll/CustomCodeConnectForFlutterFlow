const { test } = require('node:test');
const assert = require('node:assert');

test('deliberate CI failure for STU-345 verification', () => {
  assert.strictEqual(true, false);
});
