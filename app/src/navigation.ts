import type { Account, EmailSummary } from './types';

export type RootStackParamList = {
  Accounts: undefined;
  Inbox: { account: Account };
  Viewer: { account: Account; email: EmailSummary };
  Compose: {
    account: Account;
    replyTo?: EmailSummary;
    prefill?: { to?: string; cc?: string; bcc?: string; subject?: string; body?: string };
  };
  Settings: undefined;
};
