const store = require('../store');
const index = require('./searchIndexService');
const { imapUid, imapFolder, gmailOrOutlookId } = require('./emailIds');
const jobs = new Map();
function coverage() {
  const groups = new Map();
  for (const doc of index.allDocuments()) {
    const key = JSON.stringify([doc.accountId, doc.folder]);
    let group = groups.get(key);
    if (!group) { group = { accountId: doc.accountId, folder: doc.folder, messages: 0, bodies: 0, oldest: null, newest: null }; groups.set(key, group); }
    group.messages++; if (doc.body) group.bodies++;
    if (doc.date && Number.isFinite(Date.parse(doc.date))) {
      const date = new Date(doc.date).toISOString();
      if (!group.oldest || date < group.oldest) group.oldest = date;
      if (!group.newest || date > group.newest) group.newest = date;
    }
  }
  return { folders: [...groups.values()], jobs: [...jobs.values()], limit: Number(process.env.HERMES_SEARCH_MAX_DOCS) || 50000 };
}
function start({ accountId, folder, since, until }) {
  const account = store.getAccount(accountId);
  if (!account || typeof folder !== 'string' || !folder.trim() || folder.length > 300) throw new Error('Choose an account and folder');
  const from = since ? Date.parse(since) : 0;
  const to = until ? Date.parse(until + (until.length === 10 ? 'T23:59:59.999Z' : '')) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error('Invalid date range');
  if (jobs.get(accountId)?.running) throw new Error('A backfill is already running for this account');
  const job = { accountId, folder, since: since || null, until: until || null, running: true, scanned: 0, indexed: 0, error: null, startedAt: new Date().toISOString() };
  jobs.set(accountId, job);
  run(account, job, from, to).catch(error => { job.error = error.message; }).finally(() => { job.running = false; job.finishedAt = new Date().toISOString(); index.flush(); });
  return job;
}
async function run(account, job, from, to) {
  const service = require(account.type === 'gmail' ? './gmailService' : account.type === 'outlook' ? './outlookService' : './imapService');
  let token = null;
  const tokens = new Set();
  do {
    if (!store.getAccount(account.id)) throw new Error('Account was removed');
    const page = await service.fetchEmails(account, job.folder, 100, token);
    for (const message of page.emails || []) {
      job.scanned++;
      if (job.scanned > 100000) throw new Error('Scan limit reached. Narrow the folder and retry.');
      const date = Date.parse(message.date);
      if (!Number.isFinite(date) || date < from || date > to) continue;
      index.indexSummaries([{ ...message, accountId: account.id, folder: job.folder }]);
      const body = account.type === 'imap'
        ? await service.fetchEmailBody(account, imapUid(message.id), imapFolder(message.id, job.folder))
        : await service.fetchEmailBody(account, gmailOrOutlookId(message.id));
      index.indexBody(message.id, body); job.indexed++;
    }
    token = page.nextToken;
    if (token && tokens.has(token)) throw new Error('Provider repeated a page token');
    if (token) tokens.add(token);
  } while (token);
}
module.exports = { coverage, start };
