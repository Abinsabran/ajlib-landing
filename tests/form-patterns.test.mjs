// Browsers compile an input's pattern attribute with the regex 'v' flag,
// where ( ) and - must be escaped inside a character class. An invalid
// pattern throws in checkValidity() and is silently skipped as validation.
// The checkout phone pattern had exactly that bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const pages = await Promise.all(['index.html', 'legal.html'].map(async f => [f, await readFile(new URL(f, root), 'utf8')]));
const patterns = pages.flatMap(([file, html]) => [...html.matchAll(/pattern="([^"]*)"/g)].map(m => ({ file, pattern: m[1] })));
// How a browser builds the pattern regex.
const compile = (pattern, flag) => new RegExp(`^(?:${pattern})$`, flag);

test('every pattern attribute compiles under both the v and u regex flags', () => {
  assert.ok(patterns.length >= 2);
  for (const { file, pattern } of patterns) {
    for (const flag of ['v', 'u']) assert.doesNotThrow(() => compile(pattern, flag), `${file}: ${pattern} (${flag})`);
  }
});

test('the checkout phone rule is unchanged: 7-24 of digits, +, space, ( ) and -', () => {
  const phone = patterns.find(p => p.pattern.includes('{7,24}'));
  assert.ok(phone, 'checkout phone pattern missing');
  const re = compile(phone.pattern, 'v');
  for (const ok of ['0501234', '050 123 4567', '+971501234567', '+971 50 110 9215', '(050) 123-4567', '1'.repeat(24)]) assert.ok(re.test(ok), `should accept ${ok}`);
  for (const bad of ['123456', '1'.repeat(25), '050-12a-4567', '050.123.4567', '٠٥٠١٢٣٤٥٦٧', '050_1234567']) assert.ok(!re.test(bad), `should reject ${bad}`);
});
