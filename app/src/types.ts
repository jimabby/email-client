// Mirrors the backend API contract (see desktop/frontend/src/types/email.ts).

export type AccountType = 'gmail' | 'outlook' | 'imap';

export interface Account {
  id: string;
  type: AccountType;
  email: string;
  name: string;
  createdAt: string;
  /** Set when the provider stopped accepting this account's credentials. */
  authError?: { message: string; at: string } | null;
}

export interface EmailSummary {
  id: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  read: boolean;
  starred?: boolean;
  folder: string;
  accountId: string;
  snippet?: string;
  /** Provider conversation id, or the root Message-ID for IMAP. */
  threadId?: string | null;
  gmailId?: string;
  outlookId?: string;
  uid?: number;
  /** Undefined when the provider could not say. */
  hasAttachments?: boolean;
}

export interface EmailBody {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  date: string;
  html?: string;
  text?: string;
  attachments?: {
    filename: string;
    contentType: string;
    size: number;
    /** Always null — bytes are fetched on demand from the attachment endpoint. */
    content?: string | null;
  }[];
}

export interface Folder {
  name: string;
  path: string;
}

/** unreadCounts response: accountId -> folderPath -> counts */
export type UnreadCounts = Record<string, Record<string, { unread: number; total: number }>>;

export type OutboxStatus = 'pending' | 'sending' | 'retrying' | 'sent' | 'failed' | 'cancelled';

export interface OutboxItem {
  id: string;
  accountId: string;
  to: string;
  subject: string;
  status: OutboxStatus;
  sendAt: string;
  nextAttemptAt?: string;
  attempts?: number;
  error?: string | null;
  createdAt: string;
  sentAt?: string;
  hasAttachments?: boolean;
}

export interface UnifiedPage {
  emails: EmailSummary[];
  /**
   * Per-account continuation tokens. An exhausted account is an explicit null,
   * not a missing key — send the whole map back to page on.
   */
  nextTokens: Record<string, string | null>;
  errors: Array<{ accountId: string; email: string; error: string }>;
}

// ─── Rules (same shape the desktop editor and the server use) ───────────────

export type RuleField = 'from' | 'fromAddress' | 'to' | 'subject' | 'snippet' | 'hasAttachment';
export type RuleOp = 'contains' | 'notContains' | 'equals' | 'startsWith' | 'endsWith' | 'matches' | 'isTrue';
export type RuleActionType = 'move' | 'archive' | 'markRead' | 'markUnread' | 'star' | 'spam' | 'delete';

export interface MailRule {
  id: string;
  name: string;
  enabled: boolean;
  accountId?: string;
  match: 'all' | 'any';
  conditions: { field: RuleField; op: RuleOp; value: string; caseSensitive?: boolean }[];
  actions: { type: RuleActionType; targetFolder?: string }[];
  stopProcessing?: boolean;
}

// ─── Follow-ups and muting ──────────────────────────────────────────────────

export interface Followup {
  id: string;
  accountId: string;
  to: string;
  subject: string;
  sentAt: string;
  dueAt: string;
  status: 'waiting' | 'due' | 'replied';
  repliedAt?: string;
}

export interface MutedThread {
  accountId: string;
  threadId: string;
  subject: string;
  mutedAt: string;
}

/** Draft-assist modes, the same set the desktop composer offers. */
export type AiMode = 'improve' | 'concise' | 'grammar' | 'formal' | 'friendly' | 'reply';

export interface ThreadSummary {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
}
