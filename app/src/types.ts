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
    content?: string | null;
  }[];
}

export interface Folder {
  name: string;
  path: string;
}
