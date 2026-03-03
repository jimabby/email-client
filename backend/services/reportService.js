const cron = require('node-cron');
const store = require('../store');
const { categorizeEmails } = require('./categorizationService');

function getService(type) {
  if (type === 'gmail')   return require('./gmailService');
  if (type === 'outlook') return require('./outlookService');
  return require('./imapService');
}

function isYesterday(dateStr) {
  try {
    const d = new Date(dateStr);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return d.getFullYear() === yesterday.getFullYear()
        && d.getMonth()    === yesterday.getMonth()
        && d.getDate()     === yesterday.getDate();
  } catch { return false; }
}

function isOlderThanYesterday(dateStr) {
  try {
    const startOfYesterday = new Date();
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    startOfYesterday.setHours(0, 0, 0, 0);
    return new Date(dateStr) < startOfYesterday;
  } catch { return false; }
}

function formatDay(date) {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function getSenderName(from) {
  const m = from.match(/^([^<]+)</) || from.match(/^<?([^>]+)>?$/);
  return m ? m[1].trim() : from;
}

async function generateReport() {
  const accounts = store.getAccounts();
  if (!accounts.length) return null;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  let allEmails = [];

  for (const account of accounts) {
    try {
      const service = getService(account.type);
      let pageToken = null;
      let done = false;
      let found = 0;
      while (!done) {
        const { emails, nextToken } = await service.fetchEmails(account, 'INBOX', 100, pageToken);
        for (const email of emails) {
          if (isYesterday(email.date)) {
            allEmails.push({ ...email, accountEmail: account.email });
            found++;
          } else if (isOlderThanYesterday(email.date)) {
            done = true;
            break;
          }
          // today's emails: skip and keep paginating
        }
        if (!nextToken || emails.length === 0) done = true;
        pageToken = nextToken;
      }
      console.log(`[Report] ${account.email}: ${found} emails from yesterday`);
    } catch (err) {
      console.error(`[Report] Failed to fetch emails for ${account.email}:`, err.message);
    }
  }

  if (!allEmails.length) return null;

  const categories = categorizeEmails(allEmails);
  const counts = { Primary: 0, Social: 0, Jobs: 0, Promotions: 0, Receipts: 0 };
  const unreadPrimary = [];

  for (const email of allEmails) {
    const cat = categories[email.id] || 'Primary';
    if (counts[cat] !== undefined) counts[cat]++;
    if (cat === 'Primary' && !email.read) {
      unreadPrimary.push(email);
    }
  }

  const total = allEmails.length;
  const dayStr = formatDay(yesterday);
  const subject = `📬 Hermes Daily Report — ${dayStr}`;

  const unreadRows = unreadPrimary.slice(0, 10).map(e =>
    `<tr><td style="padding:4px 8px;color:#656d76;">${getSenderName(e.from)}</td><td style="padding:4px 8px;color:#1f2328;">${e.subject || '(no subject)'}</td></tr>`
  ).join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1f2328;background:#fff;">
  <h2 style="margin:0 0 4px;color:#1f2328;">📬 Hermes Daily Report</h2>
  <p style="margin:0 0 20px;color:#656d76;font-size:14px;">${dayStr}</p>

  <p style="font-size:15px;">Yesterday you received <strong>${total}</strong> email${total !== 1 ? 's' : ''}:</p>

  <table style="border-collapse:collapse;margin-bottom:24px;">
    ${Object.entries(counts).filter(([, n]) => n > 0).map(([cat, n]) =>
      `<tr><td style="padding:4px 16px 4px 0;color:#656d76;font-size:14px;">${cat}</td><td style="padding:4px 0;font-weight:600;font-size:14px;">${n}</td></tr>`
    ).join('')}
  </table>

  ${unreadPrimary.length ? `
  <p style="font-size:15px;font-weight:600;">Unread Primary emails:</p>
  <table style="border-collapse:collapse;width:100%;margin-bottom:24px;font-size:13px;">
    ${unreadRows}
  </table>` : ''}

  <p style="font-size:12px;color:#818b98;border-top:1px solid #eaeef2;padding-top:16px;margin-top:8px;">
    Sent by Hermes Email Client
  </p>
</body>
</html>`.trim();

  const text = [
    `Hermes Daily Report — ${dayStr}`,
    ``,
    `Yesterday you received ${total} email${total !== 1 ? 's' : ''}:`,
    ...Object.entries(counts).filter(([, n]) => n > 0).map(([cat, n]) => `  ${cat}: ${n}`),
    ``,
    unreadPrimary.length ? `Unread Primary emails:` : '',
    ...unreadPrimary.slice(0, 10).map(e => `  ${getSenderName(e.from)} — ${e.subject || '(no subject)'}`),
  ].filter(l => l !== undefined).join('\n');

  return { subject, html, text, date: yesterday.toISOString().split('T')[0] };
}

async function runDailyReport() {
  // Mark as run for today before generating, to prevent duplicate runs on restart
  store.saveLastReportDate(new Date().toISOString().split('T')[0]);
  console.log('[Report] Generating daily report...');
  try {
    const report = await generateReport();
    if (!report) {
      console.log('[Report] No emails from yesterday, skipping.');
      return;
    }

    // Save for in-app notification
    store.savePendingReport(report);

    // Send as email to each account
    const accounts = store.getAccounts();
    for (const account of accounts) {
      try {
        const service = getService(account.type);
        await service.sendEmail(account, {
          to: account.email,
          subject: report.subject,
          html: report.html,
          text: report.text,
        });
        console.log(`[Report] Sent to ${account.email}`);
      } catch (err) {
        console.error(`[Report] Failed to send to ${account.email}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Report] Error generating report:', err.message);
  }
}

function startScheduler() {
  // Run at 9:00am every day
  cron.schedule('0 9 * * *', runDailyReport);
  console.log('📅 Daily report scheduler started (runs at 9:00am)');

  // If app started after 9am and today's report hasn't run yet, send it now
  const now = new Date();
  if (now.getHours() >= 9) {
    const todayStr = now.toISOString().split('T')[0];
    if (store.getLastReportDate() !== todayStr) {
      console.log('[Report] App started after 9am — running missed report now');
      runDailyReport();
    }
  }
}

module.exports = { startScheduler, runDailyReport };
