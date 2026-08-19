import axios from 'axios'
import type {
  Account, EmailSummary, EmailBody, Folder, SnoozeItem, ServerDraftRef,
  MailRule, MailTemplate, Alias, OutboxItem, UnreadCounts,
} from '../types/email'

// When the backend runs with an API_TOKEN it injects the value into the served
// HTML. Reading it from the document keeps the token out of the JS bundle, and
// means enabling authentication doesn't break the desktop UI.
declare global {
  interface Window { __HERMES_TOKEN__?: string }
}

export const apiToken = (): string | undefined =>
  typeof window !== 'undefined' ? window.__HERMES_TOKEN__ : undefined

export function authHeaders(): Record<string, string> {
  const token = apiToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** EventSource cannot set headers, so SSE URLs carry the token as a parameter. */
export function withToken(url: string): string {
  const token = apiToken()
  if (!token) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}access_token=${encodeURIComponent(token)}`
}

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
})

api.interceptors.request.use(config => {
  const token = apiToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Surface the backend's error message rather than axios's generic
// "Request failed with status code 500".
api.interceptors.response.use(
  response => response,
  error => {
    const message = error?.response?.data?.error
    if (message) error.message = message
    return Promise.reject(error)
  },
)

// ─── Auth / Accounts ─────────────────────────────────────────────────────────

export const accountsApi = {
  list: () => api.get<Account[]>('/auth/accounts').then(r => r.data),

  addImap: (data: {
    email: string
    name?: string
    password: string
    imapHost: string
    imapPort?: number
    imapSecure?: boolean
    smtpHost: string
    smtpPort?: number
    smtpSecure?: boolean
    allowInsecureTLS?: boolean
  }) => api.post<{ account: Account }>('/auth/accounts/imap', data).then(r => r.data),

  remove: (id: string) => api.delete(`/auth/accounts/${id}`).then(r => r.data),

  getGmailAuthUrl: () => api.get<{ url: string }>('/auth/gmail').then(r => r.data),
  getOutlookAuthUrl: () => api.get<{ url: string }>('/auth/outlook').then(r => r.data),
}

// ─── Emails ───────────────────────────────────────────────────────────────────

export const emailsApi = {
  list: (accountId: string, folder = 'INBOX', limit = 50, pageToken?: string | null) =>
    api.get<{ emails: EmailSummary[]; nextToken: string | null; offline?: boolean; cachedAt?: string }>(`/emails/${accountId}`, {
      params: { folder, limit, ...(pageToken ? { pageToken } : {}) }
    }).then(r => r.data),

  /** Real per-folder unread totals from the provider. */
  unreadCounts: (folders: string[] = ['INBOX']) =>
    api.get<UnreadCounts>('/emails/unread-counts', { params: { folders: folders.join(',') } }).then(r => r.data),

  search: (accountId: string, query: string, folder?: string, limit = 50) =>
    api.get<EmailSummary[]>(`/emails/${accountId}/search`, { params: { q: query, folder, limit } }).then(r => r.data),

  searchAll: (query: string, folder?: string, limit = 50) =>
    api.get<EmailSummary[]>(`/emails/search-all`, { params: { q: query, folder, limit } }).then(r => r.data),

  /** Instant local index search — no provider round-trip. */
  searchIndex: (query: string, opts: { accountId?: string | null; folder?: string | null; limit?: number } = {}) =>
    api.get<{ emails: EmailSummary[]; stats: { documents: number; tokens: number } }>('/emails/search-index', {
      params: { q: query, accountId: opts.accountId || undefined, folder: opts.folder || undefined, limit: opts.limit ?? 50 }
    }).then(r => r.data),

  searchAttachments: (accountId: string, query: string, type?: string, folder?: string, limit = 50) =>
    api.get<EmailSummary[]>(`/emails/${accountId}/search-attachments`, { params: { q: query, type, folder, limit } }).then(r => r.data),

  searchAttachmentsAll: (query: string, type?: string, folder?: string, limit = 50) =>
    api.get<EmailSummary[]>(`/emails/search-attachments-all`, { params: { q: query, type, folder, limit } }).then(r => r.data),

  getBody: (accountId: string, emailId: string, folder?: string) =>
    api.get<EmailBody>(`/emails/${accountId}/message/${encodeURIComponent(emailId)}`, {
      params: folder ? { folder } : {}
    }).then(r => r.data),

  /**
   * URL for one attachment. Bytes are streamed straight from the provider, so
   * nothing has to be base64'd through the message payload.
   */
  attachmentUrl: (accountId: string, emailId: string, index: number, opts: { folder?: string; inline?: boolean } = {}) => {
    const params = new URLSearchParams()
    if (opts.folder) params.set('folder', opts.folder)
    if (opts.inline) params.set('inline', 'true')
    const query = params.toString()
    return withToken(`/api/emails/${accountId}/message/${encodeURIComponent(emailId)}/attachment/${index}${query ? `?${query}` : ''}`)
  },

  /** Fetch attachment bytes (used when the content is needed in memory). */
  fetchAttachment: (accountId: string, emailId: string, index: number, folder?: string) =>
    api.get<ArrayBuffer>(`/emails/${accountId}/message/${encodeURIComponent(emailId)}/attachment/${index}`, {
      params: folder ? { folder } : {},
      responseType: 'arraybuffer',
    }).then(r => r.data),

  getFolders: (accountId: string) =>
    api.get<Folder[]>(`/emails/${accountId}/folders`).then(r => r.data),

  createFolder: (accountId: string, name: string) => api.post<Folder>(`/emails/${accountId}/folders`, { name }).then(r => r.data),
  renameFolder: (accountId: string, folderId: string, name: string) => api.patch<Folder>(`/emails/${accountId}/folders/${encodeURIComponent(folderId)}`, { name }).then(r => r.data),

  // ─── Send-as aliases ─────────────────────────────────────────────────────
  getAliases: (accountId: string) => api.get<Alias[]>(`/emails/${accountId}/aliases`).then(r => r.data),
  saveAliases: (accountId: string, aliases: Alias[]) =>
    api.put<Alias[]>(`/emails/${accountId}/aliases`, { aliases }).then(r => r.data),

  // ─── Rules ────────────────────────────────────────────────────────────────
  getRules: () => api.get<MailRule[]>('/emails/rules').then(r => r.data),
  saveRules: (rules: MailRule[]) => api.put<MailRule[]>('/emails/rules', { rules }).then(r => r.data),
  getRuleSchema: () => api.get<{ fields: string[]; operators: string[]; actions: string[] }>('/emails/rules/schema').then(r => r.data),
  previewRule: (rule: Partial<MailRule>, emails: EmailSummary[]) =>
    api.post<{ matched: string[] }>('/emails/rules/preview', { rule, emails }).then(r => r.data),
  runRules: (emails: EmailSummary[], force = false) =>
    api.post<{ applied: { emailId: string; ruleId: string; action: string }[]; processed: number }>('/emails/rules/run', { emails, force }).then(r => r.data),

  getTemplates: () => api.get<MailTemplate[]>('/emails/templates').then(r => r.data),
  saveTemplates: (templates: MailTemplate[]) => api.put<MailTemplate[]>('/emails/templates', { templates }).then(r => r.data),

  // ─── Outbox ───────────────────────────────────────────────────────────────
  getOutbox: () => api.get<OutboxItem[]>('/emails/outbox').then(r => r.data),
  retryOutbox: (jobId: string) => api.post(`/emails/outbox/${jobId}/retry`).then(r => r.data),
  cancelOutbox: (jobId: string) => api.post(`/emails/outbox/${jobId}/cancel`).then(r => r.data),
  discardOutbox: (jobId: string) => api.delete(`/emails/outbox/${jobId}`).then(r => r.data),

  send: (accountId: string, data: {
    to: string
    cc?: string
    bcc?: string
    subject: string
    text?: string
    html?: string
    attachments?: { filename: string; contentType: string; content: string }[]
    sendAt?: string
    undoWindowSec?: number
    sendAs?: { email: string; name?: string }
    // Reply threading (all optional)
    inReplyTo?: string
    references?: string
    threadId?: string
    replyToEmailId?: string
    replyToFolder?: string
  }) => api.post<{
    success: boolean
    queued?: boolean
    jobId?: string
    sendAt?: string
    canUndoUntil?: string | null
  }>(`/emails/${accountId}/send`, data).then(r => r.data),

  cancelQueuedSend: (accountId: string, jobId: string) =>
    api.post(`/emails/${accountId}/send-queue/${jobId}/cancel`).then(r => r.data),

  delete: (accountId: string, emailId: string, folder?: string) =>
    api.delete(`/emails/${accountId}/message/${encodeURIComponent(emailId)}`, {
      params: folder ? { folder } : {}
    }).then(r => r.data),

  markRead: (accountId: string, emailId: string, folder?: string) =>
    api.post(`/emails/${accountId}/message/${encodeURIComponent(emailId)}/read`, {}, {
      params: folder ? { folder } : {}
    }).then(r => r.data),

  markUnread: (accountId: string, emailId: string, folder?: string) =>
    api.post(`/emails/${accountId}/message/${encodeURIComponent(emailId)}/unread`, {}, {
      params: folder ? { folder } : {}
    }).then(r => r.data),

  getThread: (accountId: string, threadId: string) =>
    api.get<{ summary: EmailSummary; body: EmailBody }[]>(`/emails/${accountId}/thread/${encodeURIComponent(threadId)}`).then(r => r.data),

  reportSpam: (accountId: string, emailId: string, folder?: string) =>
    api.post(`/emails/${accountId}/message/${encodeURIComponent(emailId)}/spam`, {}, { params: folder ? { folder } : {} }).then(r => r.data),
  blockSender: (accountId: string, emailId: string, sender: string, folder?: string) =>
    api.post(`/emails/${accountId}/message/${encodeURIComponent(emailId)}/block`, { sender }, { params: folder ? { folder } : {} }).then(r => r.data),

  star: (accountId: string, emailId: string, starred: boolean, folder?: string) =>
    api.post(`/emails/${accountId}/message/${encodeURIComponent(emailId)}/star`, { starred }, {
      params: folder ? { folder } : {}
    }).then(r => r.data),

  move: (accountId: string, emailId: string, targetFolder: string, sourceFolder?: string) =>
    api.post(`/emails/${accountId}/message/${encodeURIComponent(emailId)}/move`, { folder: targetFolder }, {
      params: sourceFolder ? { folder: sourceFolder } : {}
    }).then(r => r.data),

  bulkDelete: (accountId: string, emailIds: string[], folder?: string) =>
    api.post<{ succeeded: number; failed: number; errors: string[] }>(`/emails/${accountId}/bulk/delete`, { emailIds }, {
      params: folder ? { folder } : {}
    }).then(r => r.data),

  bulkMarkRead: (accountId: string, emailIds: string[], folder?: string) =>
    api.post<{ succeeded: number; failed: number; errors: string[] }>(`/emails/${accountId}/bulk/read`, { emailIds }, {
      params: folder ? { folder } : {}
    }).then(r => r.data),

  bulkMarkUnread: (accountId: string, emailIds: string[], folder?: string) =>
    api.post<{ succeeded: number; failed: number; errors: string[] }>(`/emails/${accountId}/bulk/unread`, { emailIds }, {
      params: folder ? { folder } : {}
    }).then(r => r.data),

  bulkMove: (accountId: string, emailIds: string[], targetFolder: string, sourceFolder?: string) =>
    api.post<{ succeeded: number; failed: number; errors: string[] }>(`/emails/${accountId}/bulk/move`, { emailIds, folder: targetFolder }, {
      params: sourceFolder ? { folder: sourceFolder } : {}
    }).then(r => r.data),

  categorize: (emails: { id: string; from: string; subject: string; snippet?: string }[]) =>
    api.post<{ categories: Record<string, string> }>('/emails/categorize', { emails }).then(r => r.data),

  getDailyReport: () =>
    api.get<{ subject: string; html: string; text: string; date: string } | null>('/emails/daily-report').then(r => r.data),

  // ─── Snooze ──────────────────────────────────────────────────────────────
  snooze: (accountId: string, emailId: string, until: string, email: EmailSummary, folder?: string) =>
    api.post<{ success: boolean; snooze: SnoozeItem }>(
      `/emails/${accountId}/message/${encodeURIComponent(emailId)}/snooze`,
      { until, email },
      { params: folder ? { folder } : {} }
    ).then(r => r.data),

  unsnooze: (accountId: string, emailId: string) =>
    api.delete(`/emails/${accountId}/message/${encodeURIComponent(emailId)}/snooze`).then(r => r.data),

  listSnoozed: () =>
    api.get<SnoozeItem[]>('/emails/snoozed').then(r => r.data),

  // ─── Server-synced drafts ────────────────────────────────────────────────
  saveServerDraft: (accountId: string, data: {
    to?: string
    cc?: string
    bcc?: string
    subject?: string
    text?: string
    html?: string
    attachments?: { filename: string; contentType: string; content: string }[]
    replaceRef?: ServerDraftRef | null
  }) => api.post<{ success: boolean; ref: ServerDraftRef }>(`/emails/${accountId}/drafts`, data).then(r => r.data),

  deleteServerDraft: (accountId: string, ref: ServerDraftRef) =>
    api.delete(`/emails/${accountId}/drafts`, { data: { ref } }).then(r => r.data),
}

// ─── AI Settings ──────────────────────────────────────────────────────────────

export const aiApi = {
  getSettings: () =>
    api.get<{ provider: 'claude' | 'openai' | 'gemini' | null; configured: boolean }>('/ai/settings').then(r => r.data),

  saveSettings: (provider: 'claude' | 'openai' | 'gemini', apiKey: string) =>
    api.post('/ai/settings', { provider, apiKey }).then(r => r.data),

  clearSettings: () =>
    api.delete('/ai/settings').then(r => r.data),

  rankPriority: (emails: { id: string; from: string; subject: string; snippet?: string; date?: string }[]) =>
    api.post<{ scores: Record<string, { score: number; label: string; reason: string }> }>('/ai/priority', { emails }).then(r => r.data),

  summarizeThread: (params: { subject: string; messages: { from: string; date: string; body: string }[] }) =>
    api.post<{ summary: string; keyPoints: string[]; actionItems: string[] }>('/ai/thread-summary', params).then(r => r.data),

  smartReplies: (params: { from: string; subject: string; body: string }) =>
    api.post<{ replies: string[] }>('/ai/smart-replies', params).then(r => r.data),
  extractActions: (params: { subject: string; body: string }) =>
    api.post<{ actions: { title: string; kind: 'task' | 'calendar'; date?: string; details?: string }[] }>('/ai/extract-actions', params).then(r => r.data),
  summarizeAttachment: (params: { filename: string; contentType: string; content?: string | null; text?: string }) =>
    api.post<{ summary: string }>('/ai/summarize-attachment', params).then(r => r.data),
}

// ─── Streaming helpers ────────────────────────────────────────────────────────

/**
 * Consume a `data:`-framed SSE response body, invoking the callbacks as chunks
 * arrive.
 *
 * The controller is returned *synchronously* by the wrappers below rather than
 * after the stream drains — otherwise `abort()` only ever reaches an already
 * finished request, which is what made the Stop button and the smart-compose
 * debounce no-ops.
 */
async function pumpSseResponse(
  res: Response,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
) {
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const data = await res.json()
      message = data.error || message
    } catch { /* non-JSON error body */ }
    onError(message)
    return
  }
  if (!res.body) {
    onError('Empty response body')
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let didComplete = false

  const handleLine = (rawLine: string) => {
    const line = rawLine.trimEnd()
    if (!line.startsWith('data: ')) return
    try {
      const data = JSON.parse(line.slice(6))
      if (data.text) onChunk(data.text)
      if (data.error) onError(data.error)
      if (data.done && !didComplete) { didComplete = true; onDone() }
    } catch { /* skip malformed frame */ }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) handleLine(line)
  }
  if (buffer) handleLine(buffer)
  if (!didComplete) onDone()
}

export interface StreamHandle {
  abort: () => void
  /** Resolves when the stream finishes (or aborts). */
  done: Promise<void>
}

function streamSse(
  url: string,
  body: unknown,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
): StreamHandle {
  const controller = new AbortController()

  const done = (async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      await pumpSseResponse(res, onChunk, onDone, onError)
    } catch (err: unknown) {
      // An abort is the caller's own doing, not a failure to report.
      if (err instanceof Error && err.name !== 'AbortError') onError(err.message)
    }
  })()

  return { abort: () => controller.abort(), done }
}

export function streamAiChat(
  params: {
    messages: { role: 'user' | 'assistant'; content: string }[]
    emailContext?: {
      emails: { from: string; subject: string; date: string; read: boolean; category?: string }[]
      currentEmail?: { from: string; subject: string; body: string } | null
    }
  },
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
): StreamHandle {
  return streamSse('/api/ai/chat', params, onChunk, onDone, onError)
}

export function streamAiSuggestion(
  params: {
    subject: string
    body: string
    mode: string
    customPrompt?: string
    replyTo?: { from: string; subject: string; body: string }
  },
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
): StreamHandle {
  return streamSse('/api/ai/suggest', params, onChunk, onDone, onError)
}
