const test = require('node:test');
const assert = require('node:assert');
const calendar = require('../services/calendarService');

const INVITE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:abc-123@acme.com',
  'SEQUENCE:2',
  'DTSTART:20260901T093000Z',
  'DTEND:20260901T103000Z',
  'SUMMARY:Quarterly review',
  'LOCATION:Room 4\\, Building B',
  'DESCRIPTION:Bring the numbers.\\nAll of them.',
  'ORGANIZER;CN=Alice Smith:mailto:alice@acme.com',
  'ATTENDEE;CN=Bob Jones;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:bob@acme.com',
  'ATTENDEE;CN=Carol;ROLE=OPT-PARTICIPANT:mailto:carol@acme.com',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('parses the core fields of a meeting request', () => {
  const event = calendar.parseInvite(INVITE);
  assert.equal(event.method, 'REQUEST');
  assert.equal(event.uid, 'abc-123@acme.com');
  assert.equal(event.sequence, 2);
  assert.equal(event.summary, 'Quarterly review');
  assert.equal(event.organizer.email, 'alice@acme.com');
  assert.equal(event.organizer.name, 'Alice Smith');
  assert.equal(event.attendees.length, 2);
  assert.equal(event.attendees[0].status, 'NEEDS-ACTION');
  assert.equal(event.attendees[1].optional, true);
});

test('unescapes commas and newlines in text properties', () => {
  const event = calendar.parseInvite(INVITE);
  assert.equal(event.location, 'Room 4, Building B');
  assert.ok(event.description.includes('\n'));
});

test('a UTC timestamp is normalised to ISO', () => {
  const event = calendar.parseInvite(INVITE);
  assert.equal(event.start.iso, '2026-09-01T09:30:00.000Z');
  assert.equal(event.start.allDay, false);
  assert.equal(event.start.floating, false);
});

test('an all-day event is flagged rather than given a bogus midnight', () => {
  const ics = INVITE.replace('DTSTART:20260901T093000Z', 'DTSTART;VALUE=DATE:20260901');
  const event = calendar.parseInvite(ics);
  assert.equal(event.start.allDay, true);
  assert.equal(event.start.iso, '2026-09-01');
});

test('a TZID time is reported as floating rather than silently shifted', () => {
  const ics = INVITE.replace('DTSTART:20260901T093000Z', 'DTSTART;TZID=Europe/London:20260901T093000');
  const event = calendar.parseInvite(ics);
  assert.equal(event.start.floating, true);
  assert.equal(event.start.tzid, 'Europe/London');
  assert.equal(event.start.iso, '2026-09-01T09:30:00');
});

test('folded continuation lines are joined before parsing', () => {
  const ics = INVITE.replace('SUMMARY:Quarterly review', 'SUMMARY:Quarterly\r\n  review');
  assert.equal(calendar.parseInvite(ics).summary, 'Quarterly review');
});

test('describes a weekly recurrence in words', () => {
  const ics = INVITE.replace('SEQUENCE:2', 'SEQUENCE:2\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE');
  const event = calendar.parseInvite(ics);
  assert.match(event.recurrence.text, /Every 2 weeks on Monday, Wednesday/);
});

test('an unrecognised recurrence falls back to the raw rule', () => {
  const { describeRecurrence } = calendar._internals;
  assert.equal(describeRecurrence('FREQ=SECONDLY').text, 'FREQ=SECONDLY');
});

test('non-calendar content yields null rather than a half-built event', () => {
  assert.equal(calendar.parseInvite('just some text'), null);
  assert.equal(calendar.parseInvite(''), null);
  assert.equal(calendar.parseInvite('BEGIN:VCALENDAR\r\nEND:VCALENDAR'), null);
});

test('the reply carries the UID, sequence, and chosen status', () => {
  const event = calendar.parseInvite(INVITE);
  const reply = calendar.buildReply(event, 'bob@acme.com', 'ACCEPTED');
  assert.match(reply, /METHOD:REPLY/);
  assert.match(reply, /UID:abc-123@acme\.com/);
  assert.match(reply, /SEQUENCE:2/);
  assert.match(reply, /PARTSTAT=ACCEPTED:mailto:bob@acme\.com/);
  assert.match(reply, /ORGANIZER:mailto:alice@acme\.com/);
});

test('identifies calendar parts by type or filename', () => {
  assert.ok(calendar.isCalendarPart({ contentType: 'text/calendar; method=REQUEST' }));
  assert.ok(calendar.isCalendarPart({ contentType: 'application/ics' }));
  assert.ok(calendar.isCalendarPart({ filename: 'meeting.ICS' }));
  assert.ok(!calendar.isCalendarPart({ contentType: 'application/pdf', filename: 'a.pdf' }));
});
