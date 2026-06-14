import axios from 'axios';
import { useAppStore } from './store';
import type { Account, EmailSummary, EmailBody, Folder } from './types';

// The base URL is dynamic (set on the Settings screen) because a phone can't
// reach the desktop's localhost — it needs the machine's LAN IP, e.g.
// http://192.168.1.50:3001
function client() {
  const baseURL = useAppStore.getState().serverUrl;
  return axios.create({
    baseURL: `${baseURL}/api`,
    timeout: 20000,
  });
}

export const api = {
  health: () => client().get<{ status: string }>('/health').then((r) => r.data),

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
    data: { to: string; cc?: string; bcc?: string; subject: string; text?: string; html?: string }
  ) => client().post(`/emails/${accountId}/send`, data).then((r) => r.data),

  saveDraft: (
    accountId: string,
    data: { to?: string; cc?: string; bcc?: string; subject?: string; text?: string; html?: string }
  ) => client().post(`/emails/${accountId}/drafts`, data).then((r) => r.data),
};

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
