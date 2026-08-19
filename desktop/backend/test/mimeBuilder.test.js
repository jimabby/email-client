const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mime-'));
process.env.HERMES_SECRET_KEY = '9'.repeat(64);

const gmail = require('../services/gmailService');

// buildRawMessage isn't exported (it's an implementation detail of send and
// saveDraft), so exercise it through the public surface by intercepting what
// saveDraft would transmit. Re-deriving the RFC822 text from the base64url
// output is the same thing the Gmail API receives.
function decodeRaw(base64url) {
  return Buffer.from(base64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// A tiny stand-in for the module's internal builder, reached via saveDraft.
async function buildViaDraft(account, draft) {
  const { google } = require('googleapis');
  const original = google.gmail;
  let captured = null;
  google.gmail = () => ({
    users: {
      drafts: {
        create: async ({ requestBody }) => {
          captured = requestBody.message.raw;
          return { data: { id: 'draft-1' } };
        },
      },
    },
  });
  try {
    await gmail.saveDraft(account, draft);
    return decodeRaw(captured);
  } finally {
    google.gmail = original;
  }
}

const ACCOUNT = { id: 'acct-1', email: 'me@example.com', name: 'Me', accessToken: 'x', refreshToken: 'y' };

test('a normal message produces well-formed headers', async () => {
  const raw = await buildViaDraft(ACCOUNT, { to: 'you@example.com', subject: 'Hello', html: '<p>Hi</p>' });
  assert.match(raw, /^From: Me <me@example\.com>/m);
  assert.match(raw, /^To: you@example\.com$/m);
  assert.match(raw, /^Subject: Hello$/m);
});

// The injection cases. A CR or LF in any header value used to end the header
// and let the rest of the string add headers of its own — a silent Bcc, or a
// forged From.
test('a newline in the To field cannot inject another header', async () => {
  const raw = await buildViaDraft(ACCOUNT, {
    to: 'you@example.com\r\nBcc: attacker@evil.com',
    subject: 'Hello',
    html: '<p>Hi</p>',
  });
  assert.ok(!/^Bcc: attacker@evil\.com$/m.test(raw), 'Bcc must not become its own header');
  assert.match(raw, /^To: you@example\.com Bcc: attacker@evil\.com$/m);
});

test('a newline in the subject cannot inject another header', async () => {
  const raw = await buildViaDraft(ACCOUNT, {
    to: 'you@example.com',
    subject: 'Hi\nX-Injected: yes',
    html: '<p>Hi</p>',
  });
  assert.ok(!/^X-Injected:/m.test(raw));
});

test('a newline in In-Reply-To and References is folded away', async () => {
  const raw = await buildViaDraft(ACCOUNT, {
    to: 'you@example.com',
    subject: 'Re: hi',
    html: '<p>Hi</p>',
    inReplyTo: '<abc@x>\r\nBcc: attacker@evil.com',
    references: '<def@x>',
  });
  assert.ok(!/^Bcc:/m.test(raw));
});

test('a newline in an attachment filename cannot inject MIME headers', async () => {
  const raw = await buildViaDraft(ACCOUNT, {
    to: 'you@example.com',
    subject: 'Files',
    html: '<p>Hi</p>',
    attachments: [{
      filename: 'ok.txt"\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>',
      contentType: 'text/plain',
      content: Buffer.from('hello').toString('base64'),
    }],
  });
  assert.ok(!/^Content-Type: text\/html$/m.test(raw));
  // The quote is neutralised so it cannot close the filename parameter.
  assert.match(raw, /filename="ok\.txt_ Content-Type: text\/html/);
});

test('non-ASCII subjects and display names are RFC 2047 encoded', async () => {
  const raw = await buildViaDraft({ ...ACCOUNT, name: 'Zoë Ärgen' }, {
    to: 'you@example.com',
    subject: 'Grüße — 日本語',
    html: '<p>Hi</p>',
  });
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(raw, /^From: =\?UTF-8\?B\?/m);
});

test('an array of recipients is joined into one header', async () => {
  const raw = await buildViaDraft(ACCOUNT, {
    to: ['a@example.com', 'b@example.com'],
    subject: 'Hello',
    html: '<p>Hi</p>',
  });
  assert.match(raw, /^To: a@example\.com, b@example\.com$/m);
});

// ─── Send-as aliases ────────────────────────────────────────────────────────

test('an unregistered send-as address is ignored in favour of the account', async () => {
  const raw = await buildViaDraft(ACCOUNT, {
    to: 'you@example.com',
    subject: 'Hello',
    html: '<p>Hi</p>',
    sendAs: { email: 'someone-else@evil.com' },
  });
  assert.match(raw, /^From: Me <me@example\.com>/m);
});

test('a registered alias is used as the From address', async () => {
  const withAlias = { ...ACCOUNT, aliases: [{ email: 'sales@example.com', name: 'Sales' }] };
  const raw = await buildViaDraft(withAlias, {
    to: 'you@example.com',
    subject: 'Hello',
    html: '<p>Hi</p>',
    sendAs: { email: 'sales@example.com' },
  });
  assert.match(raw, /^From: Sales <sales@example\.com>/m);
});
