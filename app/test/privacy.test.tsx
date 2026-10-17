/// <reference types="jest" />
import { parseDocument } from 'htmlparser2';
import { sanitizeEmailHtml, isAllowedImageSource } from '../src/emailHtml';
import { sendChecks } from '../../shared/sendChecks';
test('duplicate attributes cannot bypass remote image blocking', () => {
  const result = sanitizeEmailHtml('<img src="https://tracker.example/pixel" src="data:image/png;base64,AAAA" width="200" height="200">', false);
  expect(result.blocked.images).toBe(1);
  const node: any = parseDocument(result.html).children[0];
  expect(node.attribs.src).toBeUndefined();
  expect(isAllowedImageSource('https://tracker.example/pixel', false)).toBe(false);
});
test('encoded sources and active markup are removed; explicit HTTPS opt-in works', () => {
  const blocked = sanitizeEmailHtml('<script>bad()</script><img src="https&#58;//example.com/photo"><img src="file:///private">', false);
  expect(blocked.html).not.toContain('<script'); expect(blocked.html).not.toContain('src=');
  expect(sanitizeEmailHtml('<img src="https://example.com/photo">', true).html).toContain('https://example.com/photo');
});
test('send checks identify missing files and optional identity warnings', () => {
  expect(sendChecks({ to: 'new@elsewhere.example', sender: 'me@work.example', text: 'See attached', attachmentCount: 0 })).toHaveLength(1);
  const warnings = sendChecks({ to: 'new@elsewhere.example', sender: 'me@work.example', text: 'See attached', attachmentCount: 1, checkRecipients: true, originalRecipient: 'me@personal.example' });
  expect(warnings).toHaveLength(3);
});
