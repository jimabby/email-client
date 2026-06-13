import type { Account, EmailSummary } from './types';

export type RootStackParamList = {
  Accounts: undefined;
  Inbox: { account: Account };
  Viewer: { account: Account; email: EmailSummary };
  Compose: { account: Account; replyTo?: EmailSummary };
  Settings: undefined;
};
