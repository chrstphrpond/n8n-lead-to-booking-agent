// Normalizes the three intake sources into one lead shape and validates it.
const LEAD_SOURCES = ['web_form', 'call_tracking', 'hubspot_form'];

function toE164(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const digits = text.replace(/\D/g, '');
  if (text.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1') && /^[2-9]/.test(digits.slice(1))) return `+${digits}`;
  return null;
}

function cleanEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

function cleanZip(raw) {
  if (raw === null || raw === undefined) return null;
  const match = String(raw).trim().match(/^(\d{5})(?:-\d{4})?$/);
  return match ? match[1] : null;
}

function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

function truthyConsent(value) {
  return value === true || (typeof value === 'string' && ['true', 'yes', 'checked', 'on'].includes(value.trim().toLowerCase()));
}

function splitName(full) {
  const parts = cleanText(full, 120).split(/\s+/).filter(Boolean);
  return { first_name: parts[0] || '', last_name: parts.slice(1).join(' ') };
}

// ISO 8601 text, epoch milliseconds or a Gravity Forms UTC timestamp ("2026-10-13 10:52:07") become one ISO string.
function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  let date;
  if (typeof value === 'number' || /^\d{12,}$/.test(String(value))) date = new Date(Number(value));
  else if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(String(value))) date = new Date(`${String(value).replace(' ', 'T')}Z`);
  else date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Caller-ID names arrive in capitals ("PATRICIA GRAYSON"); everything else is left as the customer wrote it.
function tidyName(raw) {
  const text = cleanText(raw, 120);
  if (!text || text !== text.toUpperCase() || text === text.toLowerCase()) return text;
  return text.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (match, edge, letter) => edge + letter.toUpperCase());
}

// A call-tracking transcript has no ZIP field: the caller says it, as in "Savannah, Georgia, 31405" or "zip code 31405".
// A bare five-digit number is not enough (house numbers have five digits too).
function zipFromSpeech(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/\bzip(?:\s*code)?(?:\s+is)?\b[\s,.:-]*(\d{5})(?!\d)/i) || text.match(/\b(?:FL|GA|AL|[Ff]lorida|[Gg]eorgia|[Aa]labama)\b[\s,.:-]*(\d{5})(?!\d)/);
  return match ? match[1] : null;
}

// The website's Gravity Forms entries arrive keyed by field id. Forms 3 (free inspection request) and 5 (commercial
// quote request) share this layout.
const WEB_FORM_IDS = ['3', '5'];
const GRAVITY_FIELD_IDS = { first: '1.3', last: '1.6', phone: '2', email: '3', street: '4.1', city: '4.3', state: '4.4', zip: '4.5', message: '5', consent: '6.1' };

function extractFields(payload) {
  if (payload.source === 'web_form') {
    const entry = payload.fields && typeof payload.fields === 'object' ? payload.fields : {};
    const get = key => entry[GRAVITY_FIELD_IDS[key]];
    return { name: [get('first'), get('last')].filter(Boolean).join(' '), phone: get('phone'), email: get('email'), zip: get('zip'), message: get('message'),
      street: get('street'), city: get('city'), state: get('state'), sms_consent: get('consent'), received: toIso(payload.date_created) };
  }
  if (payload.source === 'call_tracking') {
    return { name: tidyName(payload.caller_name), phone: payload.caller_number, email: payload.customer_email, zip: zipFromSpeech(payload.transcription),
      message: payload.transcription, city: payload.caller_city, state: payload.caller_state, sms_consent: payload.sms_consent, received: toIso(payload.start_time) };
  }
  const byName = {};
  for (const field of Array.isArray(payload.fields) ? payload.fields : []) {
    if (field && typeof field.name === 'string') byName[field.name] = field.value;
  }
  const name = [byName.firstname, byName.lastname].filter(Boolean).join(' ');
  return { name, phone: byName.phone, email: byName.email, zip: byName.zip, message: byName.message,
    street: byName.address, city: byName.city, state: byName.state, sms_consent: byName.sms_consent, received: toIso(payload.submittedAt) };
}

function normalizeLead(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['payload must be a JSON object'], lead: null };
  }
  const eventId = typeof payload.event_id === 'string' ? payload.event_id.trim() : '';
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(eventId)) errors.push('event_id must be 8-128 characters of letters, digits, _ . : -');
  if (!LEAD_SOURCES.includes(payload.source)) errors.push(`source must be one of ${LEAD_SOURCES.join(', ')}`);
  else if (payload.source === 'web_form' && !WEB_FORM_IDS.includes(String(payload.form_id))) errors.push(`web_form form_id must be one of ${WEB_FORM_IDS.join(', ')}`);
  if (errors.length) return { valid: false, errors, lead: null };

  const fields = extractFields(payload);
  const phone = toE164(fields.phone);
  const email = cleanEmail(fields.email);
  const warnings = [];
  if (fields.phone && !phone) warnings.push('phone_unparseable');
  if (fields.email && !email) warnings.push('email_invalid');
  if (!phone && !email) errors.push('a valid phone number or email address is required');
  if (errors.length) return { valid: false, errors, lead: null };

  const name = splitName(fields.name);
  const text = cleanText(fields.message, 4000);
  return {
    valid: true,
    errors: [],
    lead: {
      event_id: eventId,
      source: payload.source,
      source_received_at: fields.received,
      first_name: name.first_name,
      last_name: name.last_name,
      full_name: [name.first_name, name.last_name].filter(Boolean).join(' '),
      phone,
      email,
      zip: cleanZip(fields.zip),
      street: cleanText(fields.street, 120),
      city: cleanText(fields.city, 80),
      state: cleanText(fields.state, 40),
      inquiry_text: text,
      sms_consent: truthyConsent(fields.sms_consent),
      warnings,
    },
  };
}
