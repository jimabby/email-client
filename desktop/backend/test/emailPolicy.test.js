const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createContext, runInContext } = require('node:vm');

// shared/emailPolicy.ts is the single source of truth for how both the desktop
// and mobile readers treat message HTML. It is TypeScript consumed by two
// bundlers, so rather than add a build step just to test it, the type
// annotations are stripped and it is evaluated directly. The rules it encodes
// are worth pinning: the mobile client had none of them, and every message
// opened on a phone loaded remote images as a result.

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../../../shared/emailPolicy.ts'),
  'utf8',
);

function loadPolicy() {
  const js = SOURCE
    .replace(/^export\s+/gm, '')
    .replace(/\bas const\b/g, '')
    // Strip type-only constructs: interfaces, and annotations on params/returns.
    .replace(/^export interface[\s\S]*?^}$/gm, '')
    .replace(/^interface[\s\S]*?^}$/gm, '')
    .replace(/:\s*(?:string|number|boolean|null|BlockCounts|void)(?:\s*\|\s*(?:string|number|boolean|null))*(?=\s*[),={])/g, '')
    .replace(/opts:\s*\{[\s\S]*?\}\)/g, 'opts)')
    .replace(/width,\s*height/g, 'width, height');

  const sandbox = { module: { exports: {} }, exports: {} };
  createContext(sandbox);
  runInContext(`${js}\nmodule.exports = { isSafeLinkHref, isRemoteSrc, isTrackingPixel, hasRemoteStyleUrl, hasEscapingStyle, looksLikeUnsubscribe, extractUnsubscribeUrl, htmlToText, escapeHtml, emptyBlockCounts, totalBlocked };`, sandbox);
  return sandbox.module.exports;
}

const policy = loadPolicy();

test('javascript: and data: links are refused', () => {
  for (const href of [
    'javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox',
    'file:///etc/passwd',
  ]) {
    assert.equal(policy.isSafeLinkHref(href), false, href);
  }
});

test('ordinary links are allowed', () => {
  for (const href of [
    'https://acme.com', 'http://acme.com', 'mailto:a@b.com',
    'tel:+441234', '#section', '/relative', 'relative/path',
  ]) {
    assert.equal(policy.isSafeLinkHref(href), true, href);
  }
});

test('an empty href is not a link', () => {
  assert.equal(policy.isSafeLinkHref(''), false);
  assert.equal(policy.isSafeLinkHref('   '), false);
});

test('remote sources are recognised in every form', () => {
  assert.ok(policy.isRemoteSrc('https://t.example/pixel.gif'));
  assert.ok(policy.isRemoteSrc('http://t.example/pixel.gif'));
  assert.ok(policy.isRemoteSrc('//t.example/pixel.gif'));
  assert.ok(!policy.isRemoteSrc('cid:part1'));
  assert.ok(!policy.isRemoteSrc('data:image/png;base64,AAA'));
});

test('a declared 1x1 image is a tracking pixel', () => {
  assert.ok(policy.isTrackingPixel('1', '1'));
  assert.ok(policy.isTrackingPixel('0', '0'));
});

test('a missing dimension is NOT read as zero', () => {
  // This is the bug that removed every legitimate image and left "Show images"
  // with nothing to restore.
  assert.ok(!policy.isTrackingPixel(null, null));
  assert.ok(!policy.isTrackingPixel('1', null));
  assert.ok(!policy.isTrackingPixel(null, '1'));
  assert.ok(!policy.isTrackingPixel('', ''));
  assert.ok(!policy.isTrackingPixel('auto', 'auto'));
});

test('a real image is not a tracking pixel', () => {
  assert.ok(!policy.isTrackingPixel('600', '400'));
  assert.ok(!policy.isTrackingPixel('2', '2'));
});

test('styles that fetch over the network are caught', () => {
  assert.ok(policy.hasRemoteStyleUrl('background:url(https://t.example/p.gif)'));
  assert.ok(policy.hasRemoteStyleUrl("background: url( '//t.example/p.gif' )"));
  assert.ok(!policy.hasRemoteStyleUrl('color:red'));
  assert.ok(!policy.hasRemoteStyleUrl('background:url(data:image/png;base64,AA)'));
});

test('styles that would escape the message box are caught', () => {
  assert.ok(policy.hasEscapingStyle('position:fixed;top:0'));
  assert.ok(policy.hasEscapingStyle('color:red; position : absolute'));
  assert.ok(policy.hasEscapingStyle('z-index:9999'));
  assert.ok(policy.hasEscapingStyle('opacity:0'));
  assert.ok(!policy.hasEscapingStyle('color:red;font-weight:bold'));
  assert.ok(!policy.hasEscapingStyle('opacity:0.9'));
});

test('the List-Unsubscribe header wins over a body scan', () => {
  const url = policy.extractUnsubscribeUrl({
    listUnsubscribe: '<mailto:u@acme.com>, <https://acme.com/unsub?id=7>',
    links: [{ href: 'https://wrong.example/click', text: 'unsubscribe' }],
  });
  assert.equal(url, 'https://acme.com/unsub?id=7');
});

test('the body is scanned when no header is present', () => {
  const url = policy.extractUnsubscribeUrl({
    links: [
      { href: 'https://acme.com/home', text: 'Home' },
      { href: 'https://acme.com/opt-out', text: 'Manage preferences' },
    ],
  });
  assert.equal(url, 'https://acme.com/opt-out');
});

test('an unsubscribe link with an unsafe scheme is not offered', () => {
  const url = policy.extractUnsubscribeUrl({
    links: [{ href: 'javascript:unsubscribe()', text: 'unsubscribe' }],
  });
  assert.equal(url, null);
});

test('trailing sentence punctuation is trimmed from a scanned URL', () => {
  const url = policy.extractUnsubscribeUrl({
    plainText: 'To stop these, visit https://acme.com/unsubscribe.',
  });
  assert.equal(url, 'https://acme.com/unsubscribe');
});

test('htmlToText keeps the shape of the message', () => {
  const text = policy.htmlToText('<p>Hi</p><p>Line<br>break</p><ul><li>one</li><li>two</li></ul>');
  assert.match(text, /Hi/);
  assert.match(text, /Line\nbreak/);
  assert.match(text, /• one/);
});

test('htmlToText drops scripts and styles rather than printing them', () => {
  const text = policy.htmlToText('<style>p{color:red}</style><script>alert(1)</script><p>Real</p>');
  assert.equal(text.includes('alert'), false);
  assert.equal(text.includes('color:red'), false);
  assert.match(text, /Real/);
});

test('htmlToText decodes the entities a reader would otherwise see raw', () => {
  assert.equal(policy.htmlToText('<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;</p>'), 'a & b <c> "d" \'e\'');
});

test('escapeHtml neutralises every delimiter', () => {
  assert.equal(policy.escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(policy.escapeHtml("it's"), 'it&#39;s');
});

test('block counts start empty and total correctly', () => {
  const counts = policy.emptyBlockCounts();
  assert.equal(policy.totalBlocked(counts), 0);
  counts.images = 2; counts.pixels = 1; counts.styles = 3;
  assert.equal(policy.totalBlocked(counts), 6);
});
