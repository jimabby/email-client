import { sealedStore } from './offline';
import { stripHtml } from './utils';
import type { EmailBody, EmailSummary } from './types';

/**
 * Search for mail only this phone can read.
 *
 * The server cannot search a message encrypted to a key it does not hold, so
 * every message the phone decrypts is added here: its real subject, sender,
 * recipients and text, sealed with the same AES-GCM key as the offline cache.
 * Searches then merge these hits into the server's results. It covers only
 * what this phone has opened, and it is cleared when the phone's keys go.
 */

export interface IndexedMessage {
  accountId: string;
  id: string;
  folder: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  text: string;
  indexedAt: string;
}
interface IndexState { version: 1; enabled: boolean; messages: IndexedMessage[] }

const STORE = 'private-index';
/** Enough to find a message by what it says without holding every word of a long one. */
const MAX_TEXT = 8000;
const MAX_MESSAGES = 1000;
const empty = (): IndexState => ({ version: 1, enabled: true, messages: [] });
const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

export async function isIndexEnabled(): Promise<boolean> {
  return sealedStore(STORE, empty, s => s.enabled !== false, false).catch(() => false);
}

/** Turning it off also forgets everything indexed so far. */
export async function setIndexEnabled(enabled: boolean): Promise<void> {
  await sealedStore(STORE, empty, s => { s.enabled = enabled; if (!enabled) s.messages = []; }, true);
}

export async function indexedCount(): Promise<number> {
  return sealedStore(STORE, empty, s => s.messages.length, false).catch(() => 0);
}

export async function clearIndex(): Promise<void> {
  await sealedStore(STORE, empty, s => { s.messages = []; }, true);
}

/** Remember a message this phone decrypted, so a search can find it. */
export async function indexDecrypted(email: Pick<EmailSummary, 'accountId' | 'id' | 'folder' | 'date'>, body: EmailBody): Promise<void> {
  const text = (body.text || (body.html ? stripHtml(body.html) : '')).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  const entry: IndexedMessage = {
    accountId: email.accountId, id: email.id, folder: email.folder,
    from: body.from || '', to: String(body.to || '').split(',').map(s => s.trim()).filter(Boolean),
    subject: body.subject || '', date: body.date || email.date, text,
    indexedAt: new Date().toISOString(),
  };
  await sealedStore(STORE, empty, s => {
    if (s.enabled === false) return;
    s.messages = s.messages.filter(m => !(m.accountId === entry.accountId && m.id === entry.id));
    s.messages.push(entry);
    // Oldest-indexed first out.
    if (s.messages.length > MAX_MESSAGES) s.messages.splice(0, s.messages.length - MAX_MESSAGES);
  }, true);
}

/** Drop one message, e.g. after it was deleted. */
export async function forgetIndexed(accountId: string, id: string): Promise<void> {
  await sealedStore(STORE, empty, s => { s.messages = s.messages.filter(m => !(m.accountId === accountId && m.id === id)); }, true).catch(() => {});
}

function snippetAround(text: string, terms: string[]): string {
  const folded = fold(text);
  const at = Math.min(...terms.map(t => folded.indexOf(t)).filter(i => i >= 0), Number.MAX_SAFE_INTEGER);
  if (at === Number.MAX_SAFE_INTEGER) return text.slice(0, 140);
  const start = Math.max(0, at - 40);
  return (start > 0 ? '…' : '') + text.slice(start, start + 140);
}

/**
 * Every indexed message containing all the query's words (in its subject,
 * sender, recipients or text), newest first.
 */
export async function searchIndexed(query: string, opts: { accountId?: string; folder?: string; limit?: number } = {}): Promise<EmailSummary[]> {
  const terms = fold(query).split(/\s+/).map(t => t.replace(/^(from|to|subject):/, '')).filter(Boolean);
  if (!terms.length) return [];
  const messages = await sealedStore(STORE, empty, s => s.messages, false).catch(() => [] as IndexedMessage[]);
  return messages
    .filter(m => (!opts.accountId || m.accountId === opts.accountId) && (!opts.folder || m.folder === opts.folder))
    .filter(m => {
      const hay = fold([m.subject, m.from, m.to.join(' '), m.text].join('\n'));
      return terms.every(t => hay.includes(t));
    })
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
    .slice(0, opts.limit ?? 50)
    .map(m => ({
      id: m.id, accountId: m.accountId, folder: m.folder, from: m.from, to: m.to,
      subject: m.subject, date: m.date, read: true, snippet: snippetAround(m.text, terms),
      matchedOnDevice: true,
    }));
}

/**
 * Server results with this phone's hits folded in: a message both found shows
 * the phone's copy (the server only has "[...]"), the rest are added, and the
 * whole list stays newest first.
 */
export function mergeResults(server: EmailSummary[], local: EmailSummary[]): EmailSummary[] {
  if (!local.length) return server;
  const key = (e: EmailSummary) => `${e.accountId}\n${e.id}`;
  const mine = new Map(local.map(e => [key(e), e]));
  const merged = server.map(e => {
    const hit = mine.get(key(e));
    if (!hit) return e;
    mine.delete(key(e));
    return { ...e, subject: hit.subject, snippet: hit.snippet, matchedOnDevice: true };
  });
  return [...merged, ...mine.values()].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
}
