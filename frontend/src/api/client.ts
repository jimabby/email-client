import axios from 'axios'
import type { Account, EmailSummary, EmailBody, Folder } from '../types/email'

const api = axios.create({
  baseURL: '/api',
  withCredentials: true
})

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
  }) => api.post<{ account: Account }>('/auth/accounts/imap', data).then(r => r.data),

  remove: (id: string) => api.delete(`/auth/accounts/${id}`).then(r => r.data),

  getGmailAuthUrl: () => api.get<{ url: string }>('/auth/gmail').then(r => r.data),
  getOutlookAuthUrl: () => api.get<{ url: string }>('/auth/outlook').then(r => r.data),
}

// ─── Emails ───────────────────────────────────────────────────────────────────

export const emailsApi = {
  list: (accountId: string, folder = 'INBOX', limit = 50, pageToken?: string | null) =>
    api.get<{ emails: EmailSummary[]; nextToken: string | null }>(`/emails/${accountId}`, {
      params: { folder, limit, ...(pageToken ? { pageToken } : {}) }
    }).then(r => r.data),

  search: (accountId: string, query: string, folder?: string, limit = 50) =>
    api.get<EmailSummary[]>(`/emails/${accountId}/search`, { params: { q: query, folder, limit } }).then(r => r.data),

  searchAll: (query: string, folder?: string, limit = 50) =>
    api.get<EmailSummary[]>(`/emails/search-all`, { params: { q: query, folder, limit } }).then(r => r.data),

  searchAttachments: (accountId: string, query: string, type?: string, folder?: string, limit = 50) =>
    api.get<EmailSummary[]>(`/emails/${accountId}/search-attachments`, { params: { q: query, type, folder, limit } }).then(r => r.data),

  searchAttachmentsAll: (query: string, type?: string, folder?: string, limit = 50) =>
    api.get<EmailSummary[]>(`/emails/search-attachments-all`, { params: { q: query, type, folder, limit } }).then(r => r.data),

  getBody: (accountId: string, emailId: string, folder?: string) =>
    api.get<EmailBody>(`/emails/${accountId}/message/${emailId}`, {
      params: folder ? { folder } : {}
    }).then(r => r.data),

  getFolders: (accountId: string) =>
    api.get<Folder[]>(`/emails/${accountId}/folders`).then(r => r.data),

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
    api.delete(`/emails/${accountId}/message/${emailId}`, {
      params: folder ? { folder } : {}
    }).then(r => r.data),

  markRead: (accountId: string, emailId: string, folder?: string) =>
    api.post(`/emails/${accountId}/message/${emailId}/read`, {}, {
      params: folder ? { folder } : {}
    }).then(r => r.data),

  markUnread: (accountId: string, emailId: string, folder?: string) =>
    api.post(`/emails/${accountId}/message/${emailId}/unread`, {}, {
      params: folder ? { folder } : {}
    }).then(r => r.data),

  star: (accountId: string, emailId: string, starred: boolean, folder?: string) =>
    api.post(`/emails/${accountId}/message/${emailId}/star`, { starred }, {
      params: folder ? { folder } : {}
    }).then(r => r.data),

  move: (accountId: string, emailId: string, targetFolder: string, sourceFolder?: string) =>
    api.post(`/emails/${accountId}/message/${emailId}/move`, { folder: targetFolder }, {
      params: sourceFolder ? { folder: sourceFolder } : {}
    }).then(r => r.data),

  categorize: (emails: { id: string; from: string; subject: string; snippet?: string }[]) =>
    api.post<{ categories: Record<string, string> }>('/emails/categorize', { emails }).then(r => r.data),

  getDailyReport: () =>
    api.get<{ subject: string; html: string; text: string; date: string } | null>('/emails/daily-report').then(r => r.data),
}

// ─── AI Settings ──────────────────────────────────────────────────────────────

export const aiApi = {
  getSettings: () =>
    api.get<{ provider: 'claude' | 'openai' | 'gemini' | null; configured: boolean }>('/ai/settings').then(r => r.data),

  saveSettings: (provider: 'claude' | 'openai' | 'gemini', apiKey: string) =>
    api.post('/ai/settings', { provider, apiKey }).then(r => r.data),

  clearSettings: () =>
    api.delete('/ai/settings').then(r => r.data),
}

// ─── AI Suggestions (streaming) ───────────────────────────────────────────────

export async function streamAiChat(
  params: {
    messages: { role: 'user' | 'assistant'; content: string }[]
    emailContext?: {
      emails: { from: string; subject: string; date: string; read: boolean; category?: string }[]
      currentEmail?: { from: string; subject: string; body: string } | null
    }
  },
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void
) {
  const controller = new AbortController()
  let didComplete = false

  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal
    })

    if (!res.ok) {
      const data = await res.json()
      onError(data.error || 'Request failed')
      return controller
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const data = JSON.parse(line.slice(6))
          if (data.text) onChunk(data.text)
          if (data.done && !didComplete) { didComplete = true; onDone() }
          if (data.error) onError(data.error)
        } catch {}
      }
    }
    if (!didComplete) onDone()
  } catch (err: unknown) {
    if (err instanceof Error && err.name !== 'AbortError') onError(err.message)
  }

  return controller
}

export async function streamAiSuggestion(
  params: {
    subject: string
    body: string
    mode: string
    customPrompt?: string
    replyTo?: { from: string; subject: string; body: string }
  },
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void
) {
  const controller = new AbortController()
  let didComplete = false

  try {
    const res = await fetch('/api/ai/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal
    })

    if (!res.ok) {
      const data = await res.json()
      onError(data.error || 'Request failed')
      return controller
    }

    if (!res.body) {
      onError('Empty response body')
      return controller
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const rawLine of lines) {
        const line = rawLine.trimEnd()
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6))
            if (data.text) onChunk(data.text)
            if (data.done && !didComplete) {
              didComplete = true
              onDone()
            }
            if (data.error) onError(data.error)
          } catch {
            // skip malformed
          }
        }
      }
    }

    const finalLine = buffer.trimEnd()
    if (finalLine.startsWith('data: ')) {
      try {
        const data = JSON.parse(finalLine.slice(6))
        if (data.text) onChunk(data.text)
        if (data.error) onError(data.error)
        if (data.done && !didComplete) {
          didComplete = true
          onDone()
        }
      } catch {
        // skip malformed trailing line
      }
    }

    if (!didComplete) onDone()
  } catch (err: unknown) {
    if (err instanceof Error && err.name !== 'AbortError') {
      onError(err.message)
    }
  }

  return controller
}
