// Never trust model output: parse, re-validate against the allowlists, then decide the path.
// The confidence threshold is a rule, so it comes from the ops rules sheet (Settings tab), not from here.

// A model can echo contact details from the inquiry. Slack, ClickUp, Sheets and the response get ids only,
// so email addresses and phone numbers are removed from every model-written string before it travels on.
// Phone formats covered: 7-digit local (555-0142); 10-digit US with dashes, dots, spaces, parentheses or none
// ((904) 555-0142, 904.555.0142, 9045550142); with a leading 1 or +1 (1-904-555-0142, +1 904 555 0142);
// E.164 and other international numbers (+19045550142, +44 20 7946 0958).
const EMAIL_PATTERN = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const INTERNATIONAL_PHONE_PATTERN = /\+\d[\d\s().-]{6,18}\d/g;
const US_PHONE_PATTERN = /(?<!\d)(?:1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
const LOCAL_PHONE_PATTERN = /(?<!\d)\d{3}[\s.-]\d{4}(?!\d)/g;

function redactContactDetails(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(EMAIL_PATTERN, '[email removed]')
    .replace(INTERNATIONAL_PHONE_PATTERN, '[phone removed]')
    .replace(US_PHONE_PATTERN, '[phone removed]')
    .replace(LOCAL_PHONE_PATTERN, '[phone removed]');
}

function extractQualificationText(response) {
  if (!response || typeof response !== 'object') return { ok: false, reason: 'no_response' };
  if (response.type === 'error') return { ok: false, reason: 'llm_error_response' };
  if (response.error) return { ok: false, reason: 'llm_request_failed' };
  if (response.stop_reason === 'refusal') return { ok: false, reason: 'llm_refusal' };
  if (response.stop_reason === 'max_tokens') return { ok: false, reason: 'llm_truncated' };
  const block = Array.isArray(response.content) ? response.content.find(item => item && item.type === 'text') : null;
  if (!block || typeof block.text !== 'string') return { ok: false, reason: 'llm_no_text' };
  try {
    return { ok: true, value: JSON.parse(block.text) };
  } catch (error) {
    return { ok: false, reason: 'llm_invalid_json' };
  }
}

function cleanSummary(text) {
  return redactContactDetails(text.replace(/[\r\n\t]+/g, ' ').replace(/[<>]/g, '').trim()).slice(0, 300);
}

function validateQualification(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['not an object'], value: null };
  const check = (field, allowed) => {
    if (!allowed.includes(value[field])) errors.push(`${field} is not an allowed value: ${redactContactDetails(String(JSON.stringify(value[field]))).slice(0, 60)}`);
  };
  check('pest_type', PEST_TYPES);
  check('urgency', URGENCY_LEVELS);
  check('property_type', PROPERTY_TYPES);
  check('service_interest', SERVICE_INTERESTS);
  if (typeof value.summary !== 'string' || !value.summary.trim()) errors.push('summary must be a non-empty string');
  if (!Array.isArray(value.red_flags) || value.red_flags.length > 10 || value.red_flags.some(flag => typeof flag !== 'string')) {
    errors.push('red_flags must be an array of at most 10 strings');
  }
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    errors.push('confidence must be a number from 0 to 1');
  }
  if (errors.length) return { ok: false, errors, value: null };
  return {
    ok: true,
    errors: [],
    value: {
      pest_type: value.pest_type,
      urgency: value.urgency,
      property_type: value.property_type,
      service_interest: value.service_interest,
      summary: cleanSummary(value.summary),
      red_flags: value.red_flags.map(flag => redactContactDetails(flag).slice(0, 60)),
      confidence: value.confidence,
    },
  };
}

// Returns { status: 'ok' | 'needs_review', reason, qualification }. confidenceThreshold comes from the rules sheet.
function assessQualification(response, confidenceThreshold) {
  if (typeof confidenceThreshold !== 'number' || !(confidenceThreshold >= 0 && confidenceThreshold <= 1)) {
    throw new Error('assessQualification needs the confidence threshold from the ops rules sheet');
  }
  const extracted = extractQualificationText(response);
  if (!extracted.ok) return { status: 'needs_review', reason: extracted.reason, qualification: null };
  const validated = validateQualification(extracted.value);
  if (!validated.ok) return { status: 'needs_review', reason: redactContactDetails(`invalid_output: ${validated.errors.join('; ')}`), qualification: null };
  if (validated.value.confidence < confidenceThreshold) {
    return { status: 'needs_review', reason: `low_confidence: ${validated.value.confidence} < ${confidenceThreshold}`, qualification: validated.value };
  }
  return { status: 'ok', reason: null, qualification: validated.value };
}
