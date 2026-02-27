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
  gmailId?: string;
  outlookId?: string;
  uid?: number;
  from: string;
  to: string[];
  subject: string;
  date: string;
  read: boolean;
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
  attachments?: { filename: string; contentType: string; size: number }[];
}

export interface Folder {
  name: string;
  path: string;
}

export type AiMode = 'improve' | 'concise' | 'complete' | 'grammar' | 'formal' | 'friendly' | 'subject' | 'reply' | 'custom';

export interface ComposeData {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  accountId: string;
  replyTo?: EmailBody & { id: string };
}
