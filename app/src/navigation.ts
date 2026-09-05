import type { Account, EmailSummary } from './types';

export type RootStackParamList = {
  Accounts: undefined;
  /**
   * `folder` defaults to INBOX. `unified` merges every account into one list —
   * the account param is still carried so Compose has an identity to send from.
   */
  Inbox: { account: Account; folder?: string; unified?: boolean };
  Folders: { account: Account };
  Viewer: { account: Account; email: EmailSummary };
  Compose: {
    account: Account;
    replyTo?: EmailSummary;
    prefill?: { to?: string; cc?: string; bcc?: string; subject?: string; body?: string };
  };
  Settings: undefined;
  Outbox: undefined;
};
