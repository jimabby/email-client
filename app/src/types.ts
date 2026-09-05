// Mirrors the backend API contract (see desktop/frontend/src/types/email.ts).

export type AccountType = 'gmail' | 'outlook' | 'imap';

export interface Account {
  id: string;
  type: AccountType;
  email: string;
  name: string;
  createdAt: string;
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

export interface ThreadSummary {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
}
