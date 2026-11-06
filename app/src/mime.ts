/**
 * The small part of RFC 5322 / 2045 / 2047 the phone needs to write a message
 * itself: for on-device OpenPGP, the backend must never see the plaintext,
 * so it cannot build the MIME either.
 *
 * Everything here is deliberately plain: base64 for every body part (they are
 * encrypted afterwards, so transport-safety of the inner entity is moot) and
 * RFC 2047 B-words for any header text that is not ASCII.
 */

const utf8 = (text: string) => new TextEncoder().encode(text);

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12)
      | ((i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : 0) << 6) | (i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : 0);
    out[o++] = (n >> 16) & 255;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.slice(0, o);
}

const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, '$&\r\n');
const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);
const sanitize = (text: string) => String(text || '').replace(/[\r\n]+/g, ' ');

/** RFC 2047: non-ASCII header text as one or more =?UTF-8?B?…?= words. */
export function encodeWords(text: string): string {
  const value = sanitize(text);
  if (isAscii(value)) return value;
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    // 45 bytes of UTF-8 base64-encode to 60 chars; the word stays under 75.
    if (utf8(chunk + ch).length > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map(w => `=?UTF-8?B?${bytesToBase64(utf8(w))}?=`).join(' ');
}

/** Split "A <a@x>, \"B, Jr\" <b@y>" into entries, honouring quotes. */
export function splitAddresses(list: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  for (const ch of String(list || '')) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle++;
    else if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    if (ch === ',' && !quoted && angle === 0) { if (current.trim()) out.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** The bare, lower-cased address of one list entry. */
export function addressOf(entry: string): string {
  const angle = entry.match(/<([^<>\s]+@[^<>\s]+)>/);
  return (angle ? angle[1] : entry.match(/[^\s<>"',;]+@[^\s<>"',;]+/)?.[0] || '').toLowerCase();
}

/** An address header with any non-ASCII display names encoded. */
export function encodeAddressList(list: string): string {
  return splitAddresses(list).map(entry => {
    const address = addressOf(entry);
    if (!address) return '';
    const name = entry.replace(/<[^>]*>/, '').replace(/^"|"$/g, '').trim().replace(/^"|"$/g, '');
    if (!name || name.toLowerCase() === address) return address;
    return isAscii(name) ? `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>` : `${encodeWords(name)} <${address}>`;
  }).filter(Boolean).join(', ');
}

export function recipientsOf(...lists: (string | undefined)[]): string[] {
  return [...new Set(lists.flatMap(list => splitAddresses(list || '')).map(addressOf).filter(Boolean))];
}

const boundary = (tag: string) => `----=_Hermes_${tag}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

function textPart(type: 'text/plain' | 'text/html', content: string): string {
  return `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(bytesToBase64(utf8(content)))}`;
}

export interface OutgoingAttachment { filename: string; contentType: string; content: string /* base64 */ }

/**
 * The body as one MIME entity, carrying the real subject as an RFC 9788
 * protected header. This is what gets encrypted.
 */
export function innerEntity({ subject, text, html, attachments = [] }: { subject: string; text: string; html?: string; attachments?: OutgoingAttachment[] }): string {
  const protectedHeaders = `Subject: ${encodeWords(subject)}`;
  const bodyPart = html
    ? (() => {
        const alt = boundary('alt');
        return `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n--${alt}\r\n${textPart('text/plain', text)}--${alt}\r\n${textPart('text/html', html)}--${alt}--\r\n`;
      })()
    : textPart('text/plain', text);

  if (!attachments.length) {
    // Single-part: the protected headers sit on the part itself.
    const [head, ...rest] = bodyPart.split('\r\n\r\n');
    const marked = head.replace(/^(Content-Type: [^\r\n]*)/, '$1; protected-headers="v1"');
    return `${marked}\r\n${protectedHeaders}\r\n\r\n${rest.join('\r\n\r\n')}`;
  }
  const mixed = boundary('mix');
  const files = attachments.map(a => {
    const name = encodeWords(a.filename || 'attachment');
    return `--${mixed}\r\nContent-Type: ${sanitize(a.contentType) || 'application/octet-stream'}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(a.content.replace(/\s+/g, ''))}`;
  }).join('');
  return `Content-Type: multipart/mixed; boundary="${mixed}"; protected-headers="v1"\r\n${protectedHeaders}\r\n\r\n--${mixed}\r\n${bodyPart}${files}--${mixed}--\r\n`;
}

/** RFC 5322 date, e.g. "Fri, 06 Nov 2026 10:21:32 +0000". */
export const rfc2822Date = (date = new Date()) => date.toUTCString().replace(/GMT$/, '+0000');

/** The outer PGP/MIME message (RFC 3156) around an armored, encrypted payload. */
export function pgpMimeMessage({ from, to, cc, bcc, messageId, inReplyTo, references, armored, date = new Date() }: {
  from: { name?: string; address: string }
  to: string; cc?: string; bcc?: string
  messageId: string
  inReplyTo?: string; references?: string
  armored: string
  date?: Date
}): string {
  const b = boundary('enc');
  const fromHeader = from.name && from.name.toLowerCase() !== from.address.toLowerCase()
    ? encodeAddressList(`${from.name.replace(/[<>",]/g, '')} <${from.address}>`)
    : from.address;
  const refs = [references, inReplyTo].filter(Boolean).map(s => sanitize(s as string)).join(' ');
  const headers = [
    `From: ${fromHeader}`,
    to ? `To: ${encodeAddressList(to)}` : null,
    cc ? `Cc: ${encodeAddressList(cc)}` : null,
    // The backend strips Bcc before SMTP delivery; Gmail and Graph read it.
    bcc ? `Bcc: ${encodeAddressList(bcc)}` : null,
    'Subject: [...]',
    `Date: ${rfc2822Date(date)}`,
    `Message-ID: ${messageId}`,
    inReplyTo ? `In-Reply-To: ${sanitize(inReplyTo)}` : null,
    refs ? `References: ${refs}` : null,
    'MIME-Version: 1.0',
    `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${b}"`,
  ].filter(Boolean);
  return `${headers.join('\r\n')}\r\n\r\n`
    + `This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)\r\n`
    + `--${b}\r\nContent-Type: application/pgp-encrypted\r\nContent-Description: PGP/MIME version identification\r\n\r\nVersion: 1\r\n\r\n`
    + `--${b}\r\nContent-Type: application/octet-stream; name="encrypted.asc"\r\nContent-Description: OpenPGP encrypted message\r\nContent-Disposition: inline; filename="encrypted.asc"\r\n\r\n`
    + `${armored.replace(/\r?\n/g, '\r\n').replace(/\r\n$/, '')}\r\n--${b}--\r\n`;
}
