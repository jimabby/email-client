const store = require('../store');
const index = require('./searchIndexService');
const { imapUid, imapFolder, gmailOrOutlookId } = require('./emailIds');

// One job per account. The live record is kept here and mirrored to the sealed
// state file after every page, so a restart mid-backfill resumes from the
// last page it finished (see resumeInterrupted).
const jobs = new Map();
for (const [accountId, saved] of Object.entries(store.getBackfillJobs())) {
  // Nothing is running yet in a fresh process; a saved `running` job is one
  // that was interrupted and is waiting for resumeInterrupted().
  jobs.set(accountId, { ...saved, running: false, interrupted: saved.running === true || saved.interrupted === true });
}

const MAX_SCANNED = 100000;

function publicJob(job) {
  const { pageToken, seenTokens, ...rest } = job;
  return rest;
}

function persist(job) {
  store.saveBackfillJob(job.accountId, job);
}

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
  return { folders: [...groups.values()], jobs: [...jobs.values()].map(publicJob), limit: Number(process.env.HERMES_SEARCH_MAX_DOCS) || 50000 };
}

function rangeOf({ since, until }) {
  const from = since ? Date.parse(since) : 0;
  const to = until ? Date.parse(until + (until.length === 10 ? 'T23:59:59.999Z' : '')) : Date.now();
  return { from, to };
}

function launch(account, job) {
  const { from, to } = rangeOf(job);
  job.running = true;
  job.interrupted = false;
  persist(job);
  return run(account, job, from, to)
    .catch(error => { job.error = error.message; })
    .finally(() => {
      job.running = false;
      job.finishedAt = new Date().toISOString();
      delete job.pageToken;
      delete job.seenTokens;
      persist(job);
      index.flush();
    });
}

function start({ accountId, folder, since, until }) {
  const account = store.getAccount(accountId);
  if (!account || typeof folder !== 'string' || !folder.trim() || folder.length > 300) throw new Error('Choose an account and folder');
  const { from, to } = rangeOf({ since, until });
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error('Invalid date range');
  if (jobs.get(accountId)?.running) throw new Error('A backfill is already running for this account');
  const job = {
    accountId, folder, since: since || null, until: until || null,
    running: true, scanned: 0, indexed: 0, error: null,
    startedAt: new Date().toISOString(), pageToken: null, seenTokens: [],
  };
  jobs.set(accountId, job);
  launch(account, job);
  return job;
}

/**
 * Pick up every backfill a restart interrupted, from the last finished page.
 * Called once at boot. Safe to call when there is nothing to resume.
 */
function resumeInterrupted() {
  const resumed = [];
  for (const job of jobs.values()) {
    if (!job.interrupted) continue;
    const account = store.getAccount(job.accountId);
    if (!account) {
      jobs.delete(job.accountId);
      store.saveBackfillJob(job.accountId, null);
      continue;
    }
    job.resumedAt = new Date().toISOString();
    launch(account, job);
    resumed.push(job.accountId);
  }
  if (resumed.length) console.log(`[search] resuming ${resumed.length} interrupted backfill(s)`);
  return resumed;
}

async function run(account, job, from, to) {
  const service = require(account.type === 'gmail' ? './gmailService' : account.type === 'outlook' ? './outlookService' : './imapService');
  let token = job.pageToken || null;
  const tokens = new Set(job.seenTokens || []);
  do {
    if (!store.getAccount(account.id)) throw new Error('Account was removed');
    const page = await service.fetchEmails(account, job.folder, 100, token);
    for (const message of page.emails || []) {
      job.scanned++;
      if (job.scanned > MAX_SCANNED) throw new Error('Scan limit reached. Narrow the folder and retry.');
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
    // Checkpoint after each finished page: a restart resumes from `token`.
    job.pageToken = token || null;
    job.seenTokens = [...tokens].slice(-2000);
    persist(job);
  } while (token);
}

module.exports = { coverage, start, resumeInterrupted, publicJob };
