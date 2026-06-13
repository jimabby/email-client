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
};

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
