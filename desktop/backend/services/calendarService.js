// Calendar invitations.
//
// A meeting invite arrives as a text/calendar part (or a .ics attachment) that
// every other mail client renders as a first-class object with accept/decline
// buttons. Hermes previously showed it as an opaque attachment, so the user had
// to download a file to find out when the meeting was.
//
// This is a deliberately small iCalendar reader: it handles the VEVENT subset
// that real invitations use, not the whole RFC 5545 grammar.

/** Unfold RFC 5545 continuation lines (a leading space or tab continues). */
function unfold(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

// Property values escape commas, semicolons and newlines with backslashes.
function unescapeText(value) {
  return String(value || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// DTSTART;TZID=Europe/London:20260901T093000  ->  { params, value }
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(';');
  const params = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

/**
 * iCalendar timestamps come in three shapes:
 *   20260901T093000Z  UTC
 *   20260901T093000   floating / TZID-qualified
 *   20260901          all-day
 * Without the tz database we cannot resolve a TZID offset, so a TZID-qualified
 * time is reported as-is and flagged, rather than silently shifted.
 */
function parseDate(value, params = {}) {
  const raw = String(value || '').trim();
  const allDay = /^\d{8}$/.test(raw) || params.VALUE === 'DATE';

  const match = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!match) return null;

  const [, y, mo, d, h = '00', mi = '00', s = '00', zulu] = match;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;

  if (allDay) {
    return { iso: `${y}-${mo}-${d}`, allDay: true, floating: false, tzid: null };
  }
  if (zulu) {
    return { iso: new Date(`${iso}Z`).toISOString(), allDay: false, floating: false, tzid: null };
  }
  return { iso, allDay: false, floating: true, tzid: params.TZID || null };
}

function parseAttendee(line) {
  const email = String(line.value || '').replace(/^mailto:/i, '').trim();
  if (!email) return null;
  return {
    email,
    name: line.params.CN || '',
    status: (line.params.PARTSTAT || 'NEEDS-ACTION').toUpperCase(),
    role: (line.params.ROLE || 'REQ-PARTICIPANT').toUpperCase(),
    optional: (line.params.ROLE || '').toUpperCase() === 'OPT-PARTICIPANT',
  };
}

/**
 * @returns {object|null} the first VEVENT in the calendar, or null.
 */
function parseInvite(icsText) {
  const text = unfold(icsText);
  if (!/BEGIN:VCALENDAR/i.test(text)) return null;

  const method = (text.match(/^METHOD:(.+)$/im)?.[1] || '').trim().toUpperCase();

  const start = text.search(/^BEGIN:VEVENT\s*$/im);
  if (start === -1) return null;
  const end = text.search(/^END:VEVENT\s*$/im);
  const block = text.slice(start, end === -1 ? undefined : end);

  const event = {
    method: method || 'PUBLISH',
    uid: '',
    sequence: 0,
    summary: '',
    description: '',
    location: '',
    url: '',
    organizer: null,
    attendees: [],
    start: null,
    end: null,
    recurrence: null,
    status: '',
  };

  for (const line of block.split('\n')) {
    const parsed = parseLine(line.trim());
    if (!parsed) continue;
    switch (parsed.name) {
      case 'UID':         event.uid = parsed.value.trim(); break;
      case 'SEQUENCE':    event.sequence = Number(parsed.value) || 0; break;
      case 'SUMMARY':     event.summary = unescapeText(parsed.value); break;
      case 'DESCRIPTION': event.description = unescapeText(parsed.value).slice(0, 4000); break;
      case 'LOCATION':    event.location = unescapeText(parsed.value); break;
      case 'URL':         event.url = parsed.value.trim(); break;
      case 'STATUS':      event.status = parsed.value.trim().toUpperCase(); break;
      case 'RRULE':       event.recurrence = describeRecurrence(parsed.value); break;
      case 'DTSTART':     event.start = parseDate(parsed.value, parsed.params); break;
      case 'DTEND':       event.end = parseDate(parsed.value, parsed.params); break;
      case 'ORGANIZER':
        event.organizer = {
          email: parsed.value.replace(/^mailto:/i, '').trim(),
          name: parsed.params.CN || '',
        };
        break;
      case 'ATTENDEE': {
        const attendee = parseAttendee(parsed);
        if (attendee && event.attendees.length < 100) event.attendees.push(attendee);
        break;
      }
      default: break;
    }
  }

  if (!event.start && !event.summary) return null;
  return event;
}

// Render the common RRULE shapes in words. Anything exotic falls back to the
// raw rule rather than a wrong description.
function describeRecurrence(rule) {
  const parts = {};
  for (const chunk of String(rule || '').split(';')) {
    const [k, v] = chunk.split('=');
    if (k && v) parts[k.toUpperCase()] = v;
  }
  const interval = Number(parts.INTERVAL) || 1;
  const freq = (parts.FREQ || '').toUpperCase();
  const every = interval === 1 ? 'Every' : `Every ${interval}`;
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[freq];
  if (!unit) return { text: rule, raw: rule };

  const DAYS = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };
  let text = `${every} ${unit}${interval === 1 ? '' : 's'}`;
  if (freq === 'WEEKLY' && parts.BYDAY) {
    const days = parts.BYDAY.split(',').map(d => DAYS[d.trim().slice(-2).toUpperCase()]).filter(Boolean);
    if (days.length) text += ` on ${days.join(', ')}`;
  }
  if (parts.COUNT) text += `, ${parts.COUNT} times`;
  if (parts.UNTIL) {
    const until = parseDate(parts.UNTIL);
    if (until) text += `, until ${until.iso.slice(0, 10)}`;
  }
  return { text, raw: rule };
}

/**
 * Build the REPLY body the organiser's client expects when the user responds.
 * @param {object} event      the parsed invitation
 * @param {string} attendee   the address replying
 * @param {'ACCEPTED'|'DECLINED'|'TENTATIVE'} partstat
 */
function buildReply(event, attendee, partstat) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const fold = (line) => line.match(/.{1,73}/g).join('\r\n ');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hermes//Mail//EN',
    'METHOD:REPLY',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${stamp}`,
    `SEQUENCE:${event.sequence || 0}`,
    fold(`ATTENDEE;PARTSTAT=${partstat}:mailto:${attendee}`),
  ];
  if (event.organizer?.email) lines.push(fold(`ORGANIZER:mailto:${event.organizer.email}`));
  if (event.summary) lines.push(fold(`SUMMARY:${event.summary}`));
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

/** True when an attachment or MIME part looks like a calendar invitation. */
function isCalendarPart(part) {
  const type = String(part?.contentType || '').toLowerCase();
  const name = String(part?.filename || '').toLowerCase();
  return type.startsWith('text/calendar')
    || type === 'application/ics'
    || name.endsWith('.ics');
}

module.exports = { parseInvite, buildReply, isCalendarPart, _internals: { parseDate, describeRecurrence, unfold } };
