/// <reference types="jest" />
// The phone's private search index: what it keeps, what it finds, how its
// hits fold into the server's results, and how it is forgotten.
jest.mock('../src/offline', () => {
  const files: Record<string, any> = {};
  return {
    sealedStore: jest.fn(async (name: string, empty: () => any, fn: (s: any) => any, mutate: boolean) => {
      const state = files[name] ? JSON.parse(JSON.stringify(files[name])) : empty();
      const result = fn(state);
      if (mutate) files[name] = state;
      return result;
    }),
  };
});
import {
  indexDecrypted, searchIndexed, mergeResults, clearIndex, setIndexEnabled, isIndexEnabled, indexedCount, forgetIndexed,
} from '../src/privateIndex';
import type { EmailBody, EmailSummary } from '../src/types';

const ref = (id: string, date = '2026-11-01T10:00:00Z') => ({ accountId: 'one', id, folder: 'INBOX', date });
const body = (subject: string, text: string, extra: Partial<EmailBody> = {}): EmailBody =>
  ({ from: 'Alice <alice@example.org>', to: 'me@example.com', subject, date: '2026-11-01T10:00:00Z', text, ...extra });

beforeEach(async () => { await setIndexEnabled(true); await clearIndex(); });

test('finds a decrypted message by its real subject, text or sender, with every word required', async () => {
  await indexDecrypted(ref('INBOX:1'), body('Quarterly plans', 'The launch moves to Thursday at the Zürich office.'));
  await indexDecrypted(ref('INBOX:2'), body('Lunch', 'Pizza on Friday?', { from: 'Bob <bob@example.org>' }));

  expect((await searchIndexed('quarterly')).map(e => e.id)).toEqual(['INBOX:1']);
  expect((await searchIndexed('launch thursday')).map(e => e.id)).toEqual(['INBOX:1']);
  expect((await searchIndexed('zurich')).map(e => e.id)).toEqual(['INBOX:1']);
  expect((await searchIndexed('from:bob')).map(e => e.id)).toEqual(['INBOX:2']);
  expect(await searchIndexed('launch pizza')).toEqual([]);
  const [hit] = await searchIndexed('thursday');
  expect(hit).toMatchObject({ subject: 'Quarterly plans', matchedOnDevice: true, accountId: 'one', folder: 'INBOX' });
  expect(hit.snippet).toMatch(/Thursday/);
});

test('scopes a search to the account and folder being searched', async () => {
  await indexDecrypted(ref('INBOX:1'), body('Secret', 'alpha'));
  await indexDecrypted({ ...ref('X:9'), accountId: 'two', folder: 'Archive' }, body('Secret', 'alpha'));
  expect((await searchIndexed('alpha', { accountId: 'one', folder: 'INBOX' })).map(e => e.id)).toEqual(['INBOX:1']);
  expect(await searchIndexed('alpha')).toHaveLength(2);
});

test('the phone’s copy replaces the server’s "[...]" row, and extra hits join, newest first', () => {
  const server: EmailSummary[] = [
    { id: 'INBOX:1', accountId: 'one', folder: 'INBOX', from: 'a', to: [], subject: '[...]', date: '2026-11-01T10:00:00Z', read: true },
    { id: 'INBOX:3', accountId: 'one', folder: 'INBOX', from: 'c', to: [], subject: 'Plain', date: '2026-11-03T10:00:00Z', read: false },
  ];
  const local: EmailSummary[] = [
    { id: 'INBOX:1', accountId: 'one', folder: 'INBOX', from: 'a', to: [], subject: 'Real subject', date: '2026-11-01T10:00:00Z', read: true, snippet: 's', matchedOnDevice: true },
    { id: 'INBOX:2', accountId: 'one', folder: 'INBOX', from: 'b', to: [], subject: 'Only here', date: '2026-11-02T10:00:00Z', read: true, matchedOnDevice: true },
  ];
  const merged = mergeResults(server, local);
  expect(merged.map(e => [e.id, e.subject])).toEqual([['INBOX:3', 'Plain'], ['INBOX:2', 'Only here'], ['INBOX:1', 'Real subject']]);
  expect(merged.find(e => e.id === 'INBOX:3')?.read).toBe(false);
});

test('re-opening a message replaces its entry; deleting forgets it', async () => {
  await indexDecrypted(ref('INBOX:1'), body('Old', 'first'));
  await indexDecrypted(ref('INBOX:1'), body('New', 'second'));
  expect(await indexedCount()).toBe(1);
  expect(await searchIndexed('first')).toEqual([]);
  await forgetIndexed('one', 'INBOX:1');
  expect(await indexedCount()).toBe(0);
});

test('turning it off forgets everything and stops indexing', async () => {
  await indexDecrypted(ref('INBOX:1'), body('Secret', 'alpha'));
  await setIndexEnabled(false);
  expect(await isIndexEnabled()).toBe(false);
  expect(await indexedCount()).toBe(0);
  await indexDecrypted(ref('INBOX:2'), body('Secret', 'beta'));
  expect(await searchIndexed('beta')).toEqual([]);
});

test('HTML-only mail is indexed by its words, not its markup', async () => {
  await indexDecrypted(ref('INBOX:5'), body('Invite', '', { text: undefined, html: '<p>Party at <b>noon</b></p>' }));
  expect((await searchIndexed('party noon')).map(e => e.id)).toEqual(['INBOX:5']);
  expect(await searchIndexed('<b>')).toEqual([]);
});
