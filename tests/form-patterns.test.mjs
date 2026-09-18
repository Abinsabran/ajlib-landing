// Browsers compile an input's pattern attribute with the regex 'v' flag,
// where ( ) and - must be escaped inside a character class. An invalid
// pattern throws in checkValidity() and is then ignored as validation. The
// checkout phone pattern had exactly that bug.
//
// The checkout form is built inside a JS template literal, where \( becomes
// ( at runtime. These tests therefore check the pattern the browser actually
// receives, not the raw file text (checking the file text alone let the
// first fix attempt pass while Preview still served the broken pattern).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const pages = await Promise.all(['index.html', 'legal.html'].map(async f => [f, await readFile(new URL(f, root), 'utf8')]));

const insideScript = (html, index) => {
  const before = html.slice(0, index);
  return before.lastIndexOf('<script') > before.lastIndexOf('</script>');
};
// The value the browser sees: markup inside a <script> is a JS template
// literal in this codebase, so apply JS escape processing to it.
const runtimeValue = (html, index, raw) => (insideScript(html, index) ? Function(`return \`${raw}\``)() : raw);

const patterns = pages.flatMap(([file, html]) =>
  [...html.matchAll(/pattern="([^"]*)"/g)].map(m => ({ file, raw: m[1], pattern: runtimeValue(html, m.index, m[1]) })));
const compile = (pattern, flag) => new RegExp(`^(?:${pattern})$`, flag);

test('every pattern the browser receives compiles under both the v and u regex flags', () => {
  assert.ok(patterns.length >= 2);
  for (const { file, pattern } of patterns) {
    for (const flag of ['v', 'u']) assert.doesNotThrow(() => compile(pattern, flag), `${file}: ${pattern} (${flag})`);
  }
});

test('the checkout phone input really is built at runtime, and receives the escaped pattern', () => {
  const [, html] = pages[0];
  const i = html.indexOf('{7,24}');
  assert.ok(insideScript(html, i), 'test assumption: the phone pattern lives in a script template');
  assert.equal(patterns.find(p => p.raw.includes('{7,24}')).pattern, '[0-9+ \\(\\)\\-]{7,24}');
});

test('the checkout phone rule is unchanged: 7-24 of digits, +, space, ( ) and -', () => {
  const phone = patterns.find(p => p.pattern.includes('{7,24}'));
  assert.ok(phone, 'checkout phone pattern missing');
  const re = compile(phone.pattern, 'v');
  for (const ok of ['0501234', '050 123 4567', '+971501234567', '+971 50 110 9215', '(050) 123-4567', '1'.repeat(24)]) assert.ok(re.test(ok), `should accept ${ok}`);
  for (const bad of ['123456', '1'.repeat(25), '050-12a-4567', '050.123.4567', '٠٥٠١٢٣٤٥٦٧', '050_1234567']) assert.ok(!re.test(bad), `should reject ${bad}`);
});
