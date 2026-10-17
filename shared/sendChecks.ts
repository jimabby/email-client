export interface SendCheckInput {
  to: string; cc?: string; bcc?: string; text: string; attachmentCount: number;
  sender: string; knownRecipients?: string[]; originalRecipient?: string;
  checkRecipients?: boolean;
}
export function addresses(value: string): string[] {
  return (value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(s => s.toLowerCase());
}
export function sendChecks(input: SendCheckInput): string[] {
  const warnings: string[] = [];
  if (!input.attachmentCount && /\b(attach(?:ed|ment|ments)?|enclosed)\b|附件|附上/i.test(input.text)) {
    warnings.push('Your message mentions an attachment, but no files are attached.');
  }
  if (input.checkRecipients) {
    const recipients = [...new Set(addresses([input.to, input.cc, input.bcc].join(', ')))];
    const known = new Set((input.knownRecipients || []).flatMap(addresses));
    const unfamiliar = recipients.filter(a => !known.has(a));
    if (unfamiliar.length) warnings.push('New recipients: ' + unfamiliar.join(', '));
    const domain = addresses(input.sender)[0]?.split('@')[1];
    const external = recipients.filter(a => a.split('@')[1] !== domain);
    if (external.length) warnings.push('Outside your sending domain: ' + external.join(', '));
    if (input.originalRecipient && !addresses(input.originalRecipient).includes(input.sender.toLowerCase())) {
      warnings.push('You are replying from a different address than the original recipient.');
    }
  }
  return warnings;
}
