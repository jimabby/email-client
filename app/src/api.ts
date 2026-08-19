import axios from 'axios';
import { useAppStore } from './store';
import type { Account, EmailSummary, EmailBody, Folder, OutboxItem, UnreadCounts } from './types';

// The base URL and private token are configured on the Settings screen. In
// production this should be the HTTPS URL of the always-on cloud backend.
function client() {
  const { serverUrl: baseURL, apiToken } = useAppStore.getState();
  return axios.create({
    baseURL: `${baseURL}/api`,
    timeout: 20000,
    headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : undefined,
  });
}

export const api = {
  health: () => client().get<{ status: string; authenticated: boolean }>('/auth-check').then((r) => r.data),

  listAccounts: () =>
    client().get<Account[]>('/auth/accounts').then((r) => r.data),

  listEmails: (accountId: string, folder = 'INBOX', limit = 50, pageToken?: string | null) =>
    client()
      .get<{ emails: EmailSummary[]; nextToken: string | null }>(`/emails/${accountId}`, {
        params: { folder, limit, ...(pageToken ? { pageToken } : {}) },
      })
      .then((r) => r.data),

  getFolders: (accountId: string) =>
    client().get<Folder[]>(`/emails/${accountId}/folders`).then((r) => r.data),

  getBody: (accountId: string, emailId: string, folder?: string) =>
    client()
      .get<EmailBody>(`/emails/${accountId}/message/${encodeURIComponent(emailId)}`, {
        params: folder ? { folder } : {},
      })
      .then((r) => r.data),

  search: (accountId: string, query: string, folder = 'INBOX', limit = 50) =>
    client()
      .get<EmailSummary[]>(`/emails/${accountId}/search`, {
        params: { q: query, folder, limit },
      })
      .then((r) => r.data),

  markRead: (accountId: string, emailId: string, folder?: string) =>
    client()
      .post(`/emails/${accountId}/message/${encodeURIComponent(emailId)}/read`, {}, {
        params: folder ? { folder } : {},
      })
      .then((r) => r.data),

  markUnread: (accountId: string, emailId: string, folder?: string) =>
    client()
      .post(`/emails/${accountId}/message/${encodeURIComponent(emailId)}/unread`, {}, {
        params: folder ? { folder } : {},
      })
      .then((r) => r.data),

  move: (accountId: string, emailId: string, targetFolder: string, sourceFolder?: string) =>
    client()
      .post(`/emails/${accountId}/message/${encodeURIComponent(emailId)}/move`, { folder: targetFolder }, {
        params: sourceFolder ? { folder: sourceFolder } : {},
      })
      .then((r) => r.data),

  snooze: (accountId: string, emailId: string, until: string, email: EmailSummary, folder?: string) =>
    client()
      .post(`/emails/${accountId}/message/${encodeURIComponent(emailId)}/snooze`, { until, email }, {
        params: folder ? { folder } : {},
      })
      .then((r) => r.data),

  listSnoozed: () =>
    client().get<{ emailId: string; accountId: string }[]>('/emails/snoozed').then((r) => r.data),

  star: (accountId: string, emailId: string, starred: boolean, folder?: string) =>
    client()
      .post(`/emails/${accountId}/message/${encodeURIComponent(emailId)}/star`, { starred }, {
        params: folder ? { folder } : {},
      })
      .then((r) => r.data),

  delete: (accountId: string, emailId: string, folder?: string) =>
    client()
      .delete(`/emails/${accountId}/message/${encodeURIComponent(emailId)}`, {
        params: folder ? { folder } : {},
      })
      .then((r) => r.data),

  send: (
    accountId: string,
    data: {
      to: string; cc?: string; bcc?: string; subject: string; text?: string; html?: string;
      // Reply threading — the backend resolves In-Reply-To/References (or the
      // Outlook reply draft) from the original email's composite id.
      replyToEmailId?: string; replyToFolder?: string;
    }
  ) => client().post(`/emails/${accountId}/send`, data).then((r) => r.data),

  saveDraft: (
    accountId: string,
    data: { to?: string; cc?: string; bcc?: string; subject?: string; text?: string; html?: string }
  ) => client().post(`/emails/${accountId}/drafts`, data).then((r) => r.data),

  // Real per-folder unread totals from the provider.
  unreadCounts: (folders: string[] = ['INBOX']) =>
    client()
      .get<UnreadCounts>('/emails/unread-counts', { params: { folders: folders.join(',') } })
      .then((r) => r.data),

  // ─── Outbox ───────────────────────────────────────────────────────────────
  // Sends are queued on the server and retried after a network failure, so the
  // phone can compose on a flaky connection without losing the message.
  outbox: () => client().get<OutboxItem[]>('/emails/outbox').then((r) => r.data),
  retryOutbox: (jobId: string) => client().post(`/emails/outbox/${jobId}/retry`).then((r) => r.data),
  cancelOutbox: (jobId: string) => client().post(`/emails/outbox/${jobId}/cancel`).then((r) => r.data),
  discardOutbox: (jobId: string) => client().delete(`/emails/outbox/${jobId}`).then((r) => r.data),

  // Instant local search across every indexed message, no provider round-trip.
  searchIndex: (query: string, opts: { accountId?: string; folder?: string; limit?: number } = {}) =>
    client()
      .get<{ emails: EmailSummary[] }>('/emails/search-index', {
        params: { q: query, accountId: opts.accountId, folder: opts.folder, limit: opts.limit ?? 50 },
      })
      .then((r) => r.data.emails),
};

/**
 * Absolute URL for one attachment, with the bearer token as a query parameter
 * so the OS browser/viewer can fetch it. Attachment bytes are no longer inlined
 * in the message payload.
 */
export function attachmentUrl(
  accountId: string,
  emailId: string,
  index: number,
  opts: { folder?: string; inline?: boolean } = {}
): string {
  const { serverUrl, apiToken } = useAppStore.getState();
  const params = new URLSearchParams();
  if (opts.folder) params.set('folder', opts.folder);
  if (opts.inline) params.set('inline', 'true');
  if (apiToken) params.set('access_token', apiToken);
  const query = params.toString();
  const base = `${serverUrl}/api/emails/${accountId}/message/${encodeURIComponent(emailId)}/attachment/${index}`;
  return query ? `${base}?${query}` : base;
}

// Pick the best archive destination from an account's real folder list
// (Gmail IMAP has no "Archive" folder — it uses "[Gmail]/All Mail").
export function resolveArchiveFolder(folders: Folder[]): string {
  const match =
    folders.find((f) => /^archive$/i.test(f.name) || /archive/i.test(f.path)) ||
    folders.find((f) => /all mail/i.test(f.name) || /all mail/i.test(f.path));
  return match?.path || 'Archive';
}

export function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    return (
      (err.response?.data as { error?: string })?.error ||
      err.message ||
      'Request failed'
    );
  }
  return err instanceof Error ? err.message : 'Unexpected error';
}
