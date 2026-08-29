const test = require('node:test');
const assert = require('node:assert');
const auth = require('../services/authResultsService');

const PASS = 'mx.google.com; dkim=pass header.i=@acme.com; spf=pass smtp.mailfrom=acme.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=acme.com';
const FAIL = 'mx.google.com; dkim=fail header.i=@evil.example; spf=fail smtp.mailfrom=evil.example; dmarc=fail (p=REJECT) header.from=bank.com';

test('a fully authenticated, aligned message reads as verified', () => {
  const result = auth.summarize(PASS, 'Alice <alice@acme.com>');
  assert.equal(result.status, 'pass');
  assert.equal(result.label, 'Verified sender');
  assert.equal(result.dkim, 'pass');
  assert.equal(result.spf, 'pass');
  assert.equal(result.dmarc, 'pass');
});

test('a DMARC failure is reported as a failure, whatever else passed', () => {
  const result = auth.summarize(FAIL, 'Bank <security@bank.com>');
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /did not pass/);
});

test('a missing header is "unknown", never a pass', () => {
  for (const value of [undefined, null, '', '   ']) {
    const result = auth.summarize(value, 'a@b.com');
    assert.equal(result.status, 'unknown');
    assert.equal(result.label, 'Not verified');
  }
});

test('a header with no recognised mechanism is also unknown', () => {
  assert.equal(auth.summarize('mx.google.com; nothing=useful', 'a@b.com').status, 'unknown');
});

test('a pass signed by an unrelated domain is only partial', () => {
  const header = 'mx.google.com; dkim=pass header.i=@bulksender.net; spf=pass smtp.mailfrom=bulksender.net';
  const result = auth.summarize(header, 'Notices <noreply@acme.com>');
  assert.equal(result.status, 'partial');
  assert.match(result.label, /another domain/);
});

test('a subdomain counts as aligned with its parent', () => {
  const { domainMatches } = auth._internals;
  assert.ok(domainMatches('mail.acme.com', 'acme.com'));
  assert.ok(domainMatches('acme.com', 'mail.acme.com'));
  assert.ok(!domainMatches('acme.com.evil.net', 'acme.com'));
  assert.ok(!domainMatches('notacme.com', 'acme.com'));
});

test('softfail lands in partial rather than pass or fail', () => {
  const result = auth.summarize('mx; spf=softfail smtp.mailfrom=acme.com; dkim=none', 'a@acme.com');
  assert.equal(result.status, 'partial');
});

test('the From domain is extracted from a full display-name header', () => {
  const { domainOf } = auth._internals;
  assert.equal(domainOf('Alice Smith <alice@ACME.com>'), 'acme.com');
  assert.equal(domainOf('bob@acme.com'), 'acme.com');
  assert.equal(domainOf('not an address'), null);
});
