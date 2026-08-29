export type AccountType = 'gmail' | 'outlook' | 'imap';

export interface Alias {
  email: string;
  name?: string;
  isDefault?: boolean;
}

export interface Account {
  id: string;
  type: AccountType;
  email: string;
  name: string;
  createdAt: string;
  aliases?: Alias[];
  allowInsecureTLS?: boolean;
}

export interface EmailSummary {
  id: string;
  gmailId?: string;
  outlookId?: string;
  uid?: number;
  from: string;
  to: string[];
  subject: string;
  date: string;
  read: boolean;
  starred?: boolean;
  folder: string;
  accountId: string;
  snippet?: string;
  /** Provider conversation id, or a References/Message-ID derived key for IMAP. */
  threadId?: string | null;
  messageId?: string;
  inReplyTo?: string;
  /** Set when the result came from the local search index rather than a provider. */
  fromIndex?: boolean;
}

export interface Attachment {
  filename: string;
  contentType: string;
  size: number;
  /**
   * Always null from the API — bytes are fetched on demand from
   * `emailsApi.attachmentUrl(...)`. Kept optional so locally built drafts can
   * carry inline content.
   */
  content?: string | null;
}

export interface EmailBody {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  date: string;
  html?: string;
  text?: string;
  attachments?: Attachment[];
  // Threading info (set by the backend) so replies keep the conversation.
  messageId?: string;
  references?: string;
  threadId?: string | null;
  /** Raw List-Unsubscribe header, when the sender provides one. */
  listUnsubscribe?: string;
  /** Provider verdict on SPF/DKIM/DMARC — see SenderBadge. */
  authentication?: SenderAuthentication | null;
  /** Parsed meeting invitation, when the message carries one. */
  calendarInvite?: CalendarInvite | null;
  /** Set when served from the offline cache. */
  offline?: boolean;
  cachedAt?: string;
}

/** The receiving provider's sender-authentication result. */
export interface SenderAuthentication {
  status: 'pass' | 'partial' | 'fail' | 'unknown';
  label: string;
  detail: string;
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  /** The domain the signature actually authenticated. */
  alignedDomain: string | null;
}

export interface InviteTime {
  /** ISO timestamp, or a bare YYYY-MM-DD for an all-day event. */
  iso: string;
  allDay: boolean;
  /** True when the time carries no zone and must not be converted. */
  floating: boolean;
  tzid: string | null;
}

export interface InviteAttendee {
  email: string;
  name: string;
  status: string;
  role: string;
  optional: boolean;
}

export interface CalendarInvite {
  method: string;
  uid: string;
  sequence: number;
  summary: string;
  description: string;
  location: string;
  url: string;
  status: string;
  organizer: { email: string; name: string } | null;
  attendees: InviteAttendee[];
  start: InviteTime | null;
  end: InviteTime | null;
  recurrence: { text: string; raw: string } | null;
}

/** One correspondent, derived from indexed mail rather than an address book. */
export interface Contact {
  name: string;
  email: string;
  count: number;
  lastSeen: string | null;
}

export interface VacationSettings {
  enabled: boolean;
  subject: string;
  message: string;
  startAt: string | null;
  endAt: string | null;
  accountIds: string[];
  knownContactsOnly: boolean;
  cooldownDays: number;
  /** Server-computed: enabled AND inside the scheduled window. */
  active?: boolean;
}

/**
 * Signatures keyed by account id, and by `${accountId}:${aliasEmail}` for an
 * alias, so sending from a second identity signs with that identity.
 */
export type SignatureMap = Record<string, string>;

export interface UnifiedPage {
  emails: EmailSummary[];
  /** Per-account continuation tokens; send the whole map back to page on. */
  nextTokens: Record<string, string>;
  errors: Array<{ accountId: string; email: string; error: string }>;
}

export interface Folder {
  name: string;
  path: string;
  delimiter?: string;
  userCreated?: boolean;
}

/** unreadCounts response: accountId -> folderPath -> counts */
export type UnreadCounts = Record<string, Record<string, { unread: number; total: number }>>;

// ─── Rules ───────────────────────────────────────────────────────────────────

export type RuleField = 'from' | 'to' | 'subject' | 'snippet' | 'hasAttachment';
export type RuleOp = 'contains' | 'notContains' | 'equals' | 'startsWith' | 'endsWith' | 'matches' | 'isTrue';
export type RuleActionType = 'move' | 'archive' | 'markRead' | 'markUnread' | 'star' | 'spam' | 'delete';

export interface RuleCondition {
  field: RuleField;
  op: RuleOp;
  value: string;
  caseSensitive?: boolean;
}

export interface RuleAction {
  type: RuleActionType;
  targetFolder?: string;
}

export interface MailRule {
  id: string;
  name: string;
  enabled: boolean;
  accountId?: string;
  /** Whether every condition must match, or just one. */
  match: 'all' | 'any';
  conditions: RuleCondition[];
  actions: RuleAction[];
  /** Stop evaluating later rules once this one matches. */
  stopProcessing?: boolean;
}

export interface MailTemplate { id: string; name: string; subject: string; body: string }

// ─── Outbox ──────────────────────────────────────────────────────────────────

export type OutboxStatus = 'pending' | 'sending' | 'retrying' | 'sent' | 'failed' | 'cancelled';

export interface OutboxItem {
  id: string;
  accountId: string;
  to: string;
  subject: string;
  status: OutboxStatus;
  sendAt: string;
  nextAttemptAt?: string;
  canUndoUntil?: string | null;
  attempts?: number;
  error?: string | null;
  createdAt: string;
  sentAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  hasAttachments?: boolean;
}

export type AiMode = 'improve' | 'concise' | 'complete' | 'grammar' | 'formal' | 'friendly' | 'subject' | 'reply' | 'custom';

export type EmailCategory = 'All' | 'Primary' | 'Social' | 'Jobs' | 'Promotions' | 'Receipts';
export const EMAIL_CATEGORIES: EmailCategory[] = ['All', 'Primary', 'Social', 'Jobs', 'Promotions', 'Receipts'];

/** An attachment carried by a draft or a forward, with its bytes inline. */
export interface DraftAttachment {
  filename: string;
  contentType: string;
  content: string; // base64
  size: number;
}

export interface ComposeData {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  accountId: string;
  replyTo?: EmailBody & { id: string; folder?: string };
  draftId?: string;
  /** Attachments carried over from a forward or a restored draft. */
  attachments?: DraftAttachment[];
  sendAs?: string;
}

export interface SnoozeItem {
  emailId: string;
  accountId: string;
  folder: string;
  email: EmailSummary | null;
  until: string;
  createdAt: string;
}

// Opaque reference to a draft saved in the provider's Drafts folder, so a later
// save can replace it and sending can remove it.
export interface ServerDraftRef {
  type: 'gmail' | 'outlook' | 'imap';
  id?: string | null;
  uid?: number | null;
  mailbox?: string;
}

export interface Draft {
  id: string;
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;   // HTML
  savedAt: string;
  serverRef?: ServerDraftRef | null;
  attachments?: DraftAttachment[];
}
