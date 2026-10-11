// node --test tests/    (no n8n, no network, no Claude calls)
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startMock } from '../mock/server.mjs';
import { buildAll } from '../workflow/build-workflow.mjs';
import { MODULE_FILES, loadModules, moduleSource } from '../workflow/modules.mjs';
import { runCodeNode } from './code-node.mjs';
import { assertKeyReuse, assertWriteHeaders } from './key-reuse.mjs';
import { DEMO_VARIABLES, SYSTEM_VARIABLES, buildN8nEnv } from './n8n-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lib = loadModules();
const fixture = name => JSON.parse(readFileSync(join(root, 'fixtures', name), 'utf8'));
const OPS_RULES = fixture('ops-rules.json');
const tab = name => ({ values: OPS_RULES.tabs[name].rows });
const SERVICE_AREA = lib.parseServiceArea(tab('Service area'));
const PRICING = lib.parsePricing(tab('Pricing'));
const SETTINGS = lib.parseSettings(tab('Settings'));
const { scenarios, checks } = fixture('scenarios.json');
const DAY = fixture('day/leads.json');
// US phone numbers as people type them: 9045550150, 904-555-0150, (904) 555-0150, 904.555.0150, 904 555 0150, +1 904-555-0150, 1-904-555-0150
const PHONE_TEXT = /(?<![\d])(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g;
const phonesIn = text => [...String(text).matchAll(PHONE_TEXT)].map(match => ({ typed: match[0], area: match[1], exchange: match[2], line: match[3] }));
const NOW = Date.parse('2026-10-12T14:00:00Z');
const THRESHOLD = SETTINGS.confidence_threshold;
const NOW_S = String(NOW / 1000);
const resolvePayload = def => {
  const base = def.payload ?? (scenarios.find(s => s.id === def.payload_from) ?? { payload: checks[def.payload_from]?.payload }).payload;
  return { ...base, ...(def.payload_patch ?? {}) };
};

// ------------------------------------------------------------------ signature and clock

test('signature: valid, prefixed, wrong, missing and malformed headers', () => {
  const body = Buffer.from('{"event_id":"evt-1"}');
  const good = lib.computeSignature('secret', NOW_S, body);
  assert.match(good, /^[0-9a-f]{64}$/);
  const verify = (secret, raw, signature, timestamp = NOW_S, now = NOW) => lib.verifySignature(secret, raw, signature, timestamp, now);
  assert.equal(verify('secret', body, good).ok, true);
  assert.equal(verify('secret', body, `sha256=${good}`).ok, true);
  assert.equal(verify('secret', body, good.toUpperCase()).ok, true);
  assert.equal(verify('other', body, good).reason, 'signature_mismatch');
  assert.equal(verify('secret', Buffer.from(`${body} `), good).reason, 'signature_mismatch');
  assert.equal(verify('secret', body, undefined).reason, 'missing_signature');
  assert.equal(verify('secret', body, 'abc').reason, 'malformed_signature');
  assert.equal(verify('', body, good).ok, false, 'an unset secret never validates');
});

test('signature: the timestamp is part of what is signed', () => {
  const body = Buffer.from('{"a":1}');
  const good = lib.computeSignature('secret', NOW_S, body);
  assert.equal(lib.verifySignature('secret', body, good, String(NOW / 1000 + 1), NOW).reason, 'signature_mismatch', 'moving the timestamp breaks the signature');
  assert.notEqual(lib.computeSignature('secret', NOW_S, body), lib.computeSignature('secret', NOW_S, Buffer.from('{"a":2}')));
  // the signed text is "<timestamp>.<body>"
  assert.equal(good, createHmac('sha256', 'secret').update(`${NOW_S}.{"a":1}`).digest('hex'));
});

test('signature: replay window is 300 s back and 60 s forward, checked only after the signature', () => {
  const body = Buffer.from('{"a":1}');
  const at = offsetSeconds => {
    const timestamp = String(NOW / 1000 + offsetSeconds);
    return lib.verifySignature('secret', body, lib.computeSignature('secret', timestamp, body), timestamp, NOW);
  };
  assert.equal(at(-300).ok, true, '300 s old is still accepted');
  assert.equal(at(-301).reason, 'stale_timestamp');
  assert.equal(at(60).ok, true, '60 s ahead is still accepted');
  assert.equal(at(61).reason, 'future_timestamp');
  assert.equal(at(0).ok, true);
  assert.equal(lib.verifySignature('secret', body, lib.computeSignature('secret', NOW_S, body), undefined, NOW).reason, 'missing_timestamp');
  assert.equal(lib.verifySignature('secret', body, lib.computeSignature('secret', NOW_S, body), '1791813600000', NOW).reason, 'malformed_timestamp', 'milliseconds are not seconds');
  assert.equal(lib.verifySignature('secret', body, lib.computeSignature('secret', NOW_S, body), 'yesterday', NOW).reason, 'malformed_timestamp');
  // a bad signature on a stale timestamp is just a bad signature: the window is not revealed to strangers
  assert.equal(lib.verifySignature('secret', body, 'a'.repeat(64), String(NOW / 1000 - 4000), NOW).reason, 'signature_mismatch');
});

test('signature: a missing or empty raw body is rejected, not hashed as an empty buffer', () => {
  const emptySignature = lib.computeSignature('secret', NOW_S, Buffer.alloc(0));
  assert.equal(lib.verifySignature('secret', Buffer.alloc(0), emptySignature, NOW_S, NOW).reason, 'missing_raw_body', 'a validly signed empty body is still refused');
  assert.equal(lib.verifySignature('secret', null, emptySignature, NOW_S, NOW).reason, 'missing_raw_body');
  assert.equal(lib.verifySignature('secret', undefined, emptySignature, NOW_S, NOW).reason, 'missing_raw_body');
});

test('signature: the hash covers the exact raw bytes, not a re-serialization (pretty-printed, non-ASCII)', () => {
  const payload = { name: 'Elena Peña', note: 'Café Central', zip: '32207' };
  const pretty = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  const compact = Buffer.from(JSON.stringify(payload), 'utf8');
  assert.ok(pretty.length > compact.length && pretty.some(byte => byte > 127), 'pretty-printed and multi-byte');
  const signedPretty = lib.computeSignature('secret', NOW_S, pretty);
  assert.equal(lib.verifySignature('secret', pretty, signedPretty, NOW_S, NOW).ok, true);
  assert.equal(lib.verifySignature('secret', compact, signedPretty, NOW_S, NOW).reason, 'signature_mismatch', 'same JSON value, different bytes');
  // decoding to a string and back to Latin-1 would change bytes too
  assert.equal(lib.verifySignature('secret', Buffer.from(pretty.toString('latin1'), 'utf8'), signedPretty, NOW_S, NOW).reason, 'signature_mismatch');
});

test('clock: the test-now header is honored only in test mode', () => {
  const headers = { 'x-ridgeway-test-now': '2026-10-12T14:00:00Z' };
  assert.deepEqual(lib.resolveClock(headers, 'true'), { nowMs: NOW, fixed: true });
  assert.equal(lib.resolveClock(headers, 'false').fixed, false);
  assert.equal(lib.resolveClock(headers, undefined).fixed, false);
  assert.equal(lib.resolveClock({ 'x-ridgeway-test-now': 'garbage' }, 'true').fixed, false);
});

// ------------------------------------------------------------------ normalization

test('normalize: phone numbers become E.164', () => {
  assert.equal(lib.toE164('(904) 555-0142'), '+19045550142');
  assert.equal(lib.toE164('1-912-555-0177'), '+19125550177');
  assert.equal(lib.toE164('+44 20 7946 0958'), '+442079460958');
  assert.equal(lib.toE164('555-0142'), null);
  assert.equal(lib.toE164('0115550142'), null);
  assert.equal(lib.toE164(''), null);
  assert.equal(lib.toE164(undefined), null);
});

test('normalize: all three sources produce the same lead shape', () => {
  const byId = Object.fromEntries(scenarios.map(s => [s.id, s]));
  const web = lib.normalizeLead(byId.termite_fl_new.payload);
  assert.equal(web.valid, true);
  assert.deepEqual([web.lead.phone, web.lead.email, web.lead.zip, web.lead.sms_consent], ['+19045550150', 'malik.hendricks@gmail.example', '32207', false]);
  assert.deepEqual([web.lead.first_name, web.lead.last_name, web.lead.street, web.lead.city, web.lead.state], ['Malik', 'Hendricks', '2218 Cutler Marsh Rd', 'Jacksonville', 'FL']);
  assert.equal(web.lead.source_received_at, '2026-10-12T13:12:18.000Z', 'Gravity Forms stamps entries in UTC');
  const call = lib.normalizeLead(byId.ants_ga_recurring.payload);
  assert.deepEqual([call.lead.source, call.lead.phone, call.lead.zip, call.lead.sms_consent, call.lead.last_name, call.lead.email], ['call_tracking', '+19125550163', '31405', true, 'Rahman', 'ayesha.rahman@gmail.example']);
  assert.match(call.lead.inquiry_text, /quarterly thing/);
  assert.equal(call.lead.source_received_at, '2026-10-13T15:19:41.000Z', 'the call start time carries its own UTC offset');
  const form = lib.normalizeLead(byId.existing_customer_al.payload);
  assert.deepEqual([form.lead.source, form.lead.full_name, form.lead.phone, form.lead.zip, form.lead.street], ['hubspot_form', 'Lorraine Beauchamp', '+12515550179', '36605', '1217 Bayou Sorrel Ln']);
  assert.equal(form.lead.source_received_at, '2026-10-14T19:05:09.000Z', 'HubSpot sends submittedAt in epoch milliseconds');
});

test('normalize: web_form entries are read by Gravity Forms field id, and a form we do not map is refused', () => {
  const entry = { event_id: 'evt-gf-0001', source: 'web_form', form_id: '5', date_created: '2026-10-13 12:25:49', fields: { '1.3': 'Hector', '1.6': 'Valdivia', 2: '9045550150', 3: '', '4.1': '9020 Tidewater Plaza Blvd', '4.5': '32246', 5: 'roaches', '6.1': 'yes' } };
  const result = lib.normalizeLead(entry);
  assert.equal(result.valid, true);
  assert.deepEqual([result.lead.full_name, result.lead.phone, result.lead.email, result.lead.zip, result.lead.sms_consent], ['Hector Valdivia', '+19045550150', null, '32246', true]);
  assert.equal(lib.normalizeLead({ ...entry, form_id: 3 }).valid, true, 'the form id may be a number');
  const unmapped = lib.normalizeLead({ ...entry, form_id: '9' });
  assert.equal(unmapped.valid, false);
  assert.match(unmapped.errors.join(' '), /form_id must be one of 3, 5/);
  assert.equal(lib.normalizeLead({ ...entry, fields: undefined }).valid, false, 'no fields, no phone, no email');
});

test('normalize: caller-ID names in capitals are tidied, and the ZIP is what the caller says', () => {
  assert.equal(lib.tidyName('PATRICIA GRAYSON'), 'Patricia Grayson');
  assert.equal(lib.tidyName("DESHAWN O'NEAL-REYES"), "Deshawn O'Neal-Reyes");
  assert.equal(lib.tidyName('Marcus Bell'), 'Marcus Bell', 'mixed case is left alone');
  assert.equal(lib.tidyName(''), '');
  assert.equal(lib.tidyName(undefined), '');
  assert.equal(lib.zipFromSpeech("We're in Savannah, Georgia, 31405. Not urgent."), '31405');
  assert.equal(lib.zipFromSpeech('Orange Park, Florida 32065'), '32065');
  assert.equal(lib.zipFromSpeech('my zip code is 36609'), '36609');
  assert.equal(lib.zipFromSpeech('Mobile, AL 36618'), '36618');
  assert.equal(lib.zipFromSpeech('I live at 12345 Oak Hollow Road and call me on 904 555 0150'), null, 'a house number is not a ZIP');
  assert.equal(lib.zipFromSpeech('Pooler, Georgia 313220'), null, 'six digits are not a ZIP');
  assert.equal(lib.zipFromSpeech(undefined), null);
  const call = { event_id: 'evt-call-0001', source: 'call_tracking', caller_number: '+19045550150', caller_name: 'PATRICIA GRAYSON', start_time: '2026-10-13T07:12:44.000-04:00', transcription: 'ants, Jacksonville, Florida 32258' };
  const lead = lib.normalizeLead(call).lead;
  assert.deepEqual([lead.full_name, lead.zip, lead.email, lead.sms_consent], ['Patricia Grayson', '32258', null, false]);
  assert.equal(lib.normalizeLead({ ...call, transcription: 'ants, but I forgot to say where' }).lead.zip, null);
});

test('normalize: timestamps from every source become one ISO string', () => {
  assert.equal(lib.toIso(1791994509000), '2026-10-14T16:15:09.000Z');
  assert.equal(lib.toIso('1791994509000'), '2026-10-14T16:15:09.000Z');
  assert.equal(lib.toIso('2026-10-13 12:25:49'), '2026-10-13T12:25:49.000Z');
  assert.equal(lib.toIso('2026-10-13T08:04:12.000-04:00'), '2026-10-13T12:04:12.000Z');
  assert.equal(lib.toIso('not a date'), null);
  assert.equal(lib.toIso(''), null);
  assert.equal(lib.toIso(undefined), null);
});

test('normalize: validation rejects what the workflow must answer with 400', () => {
  const web = (fields = {}, extra = {}) => ({ event_id: 'evt-valid-001', source: 'web_form', form_id: '3', fields: { '1.3': 'A', '1.6': 'B', '4.5': '32207', 5: 'ants', ...fields }, ...extra });
  assert.equal(lib.normalizeLead(web()).valid, false, 'no phone and no email');
  assert.equal(lib.normalizeLead(web({ 2: '12' })).valid, false, 'unparseable phone and no email');
  assert.equal(lib.normalizeLead(web({ 3: 'a@b.example' })).valid, true, 'email alone is enough');
  assert.deepEqual(lib.normalizeLead(web({ 3: 'a@b.example', 2: '12' })).lead.warnings, ['phone_unparseable']);
  assert.equal(lib.normalizeLead(web({ 3: 'a@b.example' }, { event_id: 'x' })).valid, false, 'short event_id');
  assert.equal(lib.normalizeLead(web({ 3: 'a@b.example' }, { source: 'fax' })).valid, false, 'unknown source');
  assert.equal(lib.normalizeLead(null).valid, false);
  assert.equal(lib.normalizeLead([]).valid, false);
});

test('normalize: sms consent is true only for an explicit yes', () => {
  const base = { event_id: 'evt-consent-01', source: 'web_form', form_id: '3' };
  for (const [value, expected] of [[true, true], ['true', true], ['Checked', true], ['yes', true], [false, false], ['no', false], [undefined, false], [1, false], ['', false]]) {
    assert.equal(lib.normalizeLead({ ...base, fields: { 3: 'a@b.example', '6.1': value } }).lead.sms_consent, expected, `consent ${JSON.stringify(value)}`);
  }
});

test('normalize: control characters are stripped and text is length-capped', () => {
  const result = lib.normalizeLead({ event_id: 'evt-clean-0001', source: 'web_form', form_id: '3', fields: { 3: 'a@b.example', 5: `ants\u0000\u0007 here ${'x'.repeat(6000)}` } });
  assert.ok(!/[\u0000-\u0008]/.test(result.lead.inquiry_text));
  assert.equal(result.lead.inquiry_text.length, 4000);
});

// ------------------------------------------------------------------ the shared Claude request

test('anthropic: request shape for claude-haiku-5-5 with structured output', () => {
  const lead = lib.normalizeLead(scenarios[0].payload).lead;
  const body = lib.buildQualificationRequest(lead);
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.metadata.user_id, 'evt-termite-fl-001');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.deepEqual(body.output_config.format.schema, lib.QUALIFICATION_SCHEMA);
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.deepEqual(body.output_config.format.schema.properties.pest_type.enum, lib.PEST_TYPES);
  for (const banned of ['temperature', 'top_p', 'top_k', 'thinking', 'budget_tokens']) assert.ok(!(banned in body), `${banned} must not be sent`);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user', 'no assistant prefill');
  assert.ok(body.max_tokens >= 1024, 'room for adaptive thinking plus the answer');
});

test('anthropic: no customer contact details are sent to the model', () => {
  const lead = lib.normalizeLead(scenarios[0].payload).lead;
  const serialized = JSON.stringify(lib.buildQualificationRequest(lead));
  for (const secret of [lead.phone, lead.email, lead.full_name, lead.street, '555-0150']) assert.ok(!serialized.includes(secret), `leaked ${secret}`);
  assert.ok(serialized.includes('<inquiry>'));
});

test('anthropic: headers carry the key and version only', () => {
  assert.deepEqual(lib.buildAnthropicHeaders('k'), { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
});

test('anthropic: the request is deterministic (recordings stay valid)', () => {
  const lead = lib.normalizeLead(scenarios[0].payload).lead;
  assert.deepEqual(lib.buildQualificationRequest(lead), lib.buildQualificationRequest(lib.normalizeLead(scenarios[0].payload).lead));
});

// ------------------------------------------------------------------ guardrails

const goodOutput = { pest_type: 'ants', urgency: 'normal', property_type: 'residential', service_interest: 'recurring', summary: 'Ants in the kitchen.', red_flags: [], confidence: 0.9 };
const wrap = (value, extra = {}) => ({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...extra });

test('guardrails: a valid answer passes and thinking blocks are skipped', () => {
  const response = wrap(goodOutput);
  response.content.unshift({ type: 'thinking', thinking: '', signature: 'x' });
  const result = lib.assessQualification(response, THRESHOLD);
  assert.equal(result.status, 'ok');
  assert.equal(result.qualification.pest_type, 'ants');
});

test('guardrails: bad model output goes to needs_review with a reason', () => {
  const cases = [
    [wrap({ ...goodOutput, pest_type: 'gremlins' }), /invalid_output: pest_type/],
    [wrap({ ...goodOutput, urgency: 'whenever' }), /urgency/],
    [wrap({ ...goodOutput, confidence: 1.4 }), /confidence/],
    [wrap({ ...goodOutput, confidence: '0.9' }), /confidence/],
    [wrap({ ...goodOutput, red_flags: 'none' }), /red_flags/],
    [wrap({ ...goodOutput, summary: '  ' }), /summary/],
    [wrap('not json at all'), /llm_invalid_json/],
    [wrap(goodOutput, { stop_reason: 'refusal' }), /llm_refusal/],
    [wrap(goodOutput, { stop_reason: 'max_tokens' }), /llm_truncated/],
    [{ type: 'message', content: [] }, /llm_no_text/],
    [{ error: 'ECONNREFUSED' }, /llm_request_failed/],
    [{ type: 'error', error: { type: 'api_error' } }, /llm_error_response/],
    [null, /no_response/],
  ];
  for (const [response, reason] of cases) {
    const result = lib.assessQualification(response, THRESHOLD);
    assert.equal(result.status, 'needs_review', JSON.stringify(response));
    assert.match(result.reason, reason);
  }
});

test('guardrails: confidence below 0.6 needs review, 0.6 passes', () => {
  const low = lib.assessQualification(wrap({ ...goodOutput, confidence: 0.59 }), THRESHOLD);
  assert.equal(low.status, 'needs_review');
  assert.match(low.reason, /^low_confidence/);
  assert.equal(low.qualification.pest_type, 'ants', 'the best guess is kept for the reviewer');
  assert.equal(lib.assessQualification(wrap({ ...goodOutput, confidence: 0.6 }), THRESHOLD).status, 'ok');
  // the threshold is a rule from the sheet, not a constant in the code
  assert.equal(lib.assessQualification(wrap({ ...goodOutput, confidence: 0.7 }), 0.8).status, 'needs_review');
  assert.equal(lib.assessQualification(wrap({ ...goodOutput, confidence: 0.7 }), 0.5).status, 'ok');
  assert.throws(() => lib.assessQualification(wrap(goodOutput)), /confidence threshold/, 'no silent default');
  assert.throws(() => lib.assessQualification(wrap(goodOutput), '0.6'), /confidence threshold/);
});

test('guardrails: summary is sanitized', () => {
  const result = lib.assessQualification(wrap({ ...goodOutput, summary: '<b>ants</b>\nin\tkitchen' }), THRESHOLD);
  assert.equal(result.qualification.summary, 'bants/b in kitchen');
});

test('guardrails: phone numbers and emails are redacted in every common format', () => {
  const phones = ['(904) 555-0188', '(904)555-0188', '904-555-0188', '904.555.0188', '904 555 0188', '9045550188', '1-904-555-0188', '1 (904) 555-0188',
    '+1 904 555 0188', '+1-904-555-0188', '+1 (904) 555-0188', '+19045550188', '+44 20 7946 0958', '+442079460958', '555-0188', '555 0188'];
  for (const phone of phones) {
    const out = lib.redactContactDetails(`Call ${phone} today`);
    assert.equal(out, 'Call [phone removed] today', `format ${phone}`);
  }
  for (const email of ['jo.rivera@mail.example', 'JO+ants@Mail.Example.com', "o'neil@mail.example", '9045550188@mail.example']) {
    assert.equal(lib.redactContactDetails(`write ${email} now`), 'write [email removed] now', email);
  }
  assert.equal(lib.redactContactDetails('call_9045550188 and contact_jo@mail.example'), 'call_[phone removed] and [email removed]', 'labels with embedded numbers are covered');
  assert.equal(lib.redactContactDetails('ants in the kitchen, ZIP 32207, quote $1200, 3 to 5 visits, Oct 12 2026-10-12 10:00'), 'ants in the kitchen, ZIP 32207, quote $1200, 3 to 5 visits, Oct 12 2026-10-12 10:00', 'ordinary numbers stay');
  assert.equal(lib.redactContactDetails(undefined), undefined);
});

test('guardrails: model-written summary, red flags and invalid-output reasons are redacted before they travel on', () => {
  const echoed = { ...goodOutput, summary: 'Reach Jo at (904) 555-0188 / jo.rivera@mail.example about ants.', red_flags: ['mail_jo.rivera@mail.example', 'tel_+1 904 555 0188'] };
  const ok = lib.assessQualification(wrap(echoed), THRESHOLD);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.qualification.summary, 'Reach Jo at [phone removed] / [email removed] about ants.');
  assert.deepEqual(ok.qualification.red_flags, ['[email removed]', 'tel_[phone removed]']);
  // a contact detail at the truncation edge must not survive as a fragment
  const edge = lib.assessQualification(wrap({ ...goodOutput, summary: `${'x'.repeat(285)} jo.rivera@mail.example` }), THRESHOLD);
  assert.ok(!/jo\.rivera|mail\.example|@/.test(edge.qualification.summary), edge.qualification.summary);
  // an invalid answer reports the bad value, redacted
  const bad = lib.assessQualification(wrap({ ...goodOutput, pest_type: 'ants jo.rivera@mail.example (904) 555-0188' }), THRESHOLD);
  assert.equal(bad.status, 'needs_review');
  assert.match(bad.reason, /^invalid_output: pest_type is not an allowed value/);
  assert.ok(!/jo\.rivera|555-0188|904/.test(bad.reason), bad.reason);
  // a long junk value is cut, not echoed whole
  assert.ok(lib.assessQualification(wrap({ ...goodOutput, urgency: 'y'.repeat(5000) }), THRESHOLD).reason.length < 200);
});

// ------------------------------------------------------------------ routing, pricing, approval

test('routing: ZIP to branch and out-of-area', () => {
  assert.equal(lib.findBranch(SERVICE_AREA, '32207').id, 'jacksonville');
  assert.equal(lib.findBranch(SERVICE_AREA, '31405').id, 'savannah');
  assert.equal(lib.findBranch(SERVICE_AREA, '36602').timezone, 'America/Chicago');
  assert.equal(lib.findBranch(SERVICE_AREA, '33139'), null);
  assert.equal(lib.findBranch(SERVICE_AREA, null), null);
});

test('routing: estimated deal value and approval triggers', () => {
  const q = overrides => ({ pest_type: 'ants', urgency: 'normal', property_type: 'residential', service_interest: 'recurring', ...overrides });
  assert.equal(lib.estimateDealValue(PRICING, SETTINGS, q()), 540);
  assert.equal(lib.estimateDealValue(PRICING, SETTINGS, q({ property_type: 'commercial', pest_type: 'rodents', service_interest: 'one_time', urgency: 'emergency' })), 975);
  assert.deepEqual(lib.decideApproval(q(), 480, SETTINGS), { required: false, reasons: [] });
  assert.deepEqual(lib.decideApproval(q({ pest_type: 'termites' }), 100, SETTINGS).reasons, ['pest_type:termites']);
  assert.deepEqual(lib.decideApproval(q({ pest_type: 'wildlife' }), 100, SETTINGS).reasons, ['pest_type:wildlife']);
  assert.deepEqual(lib.decideApproval(q({ property_type: 'commercial' }), 100, SETTINGS).reasons, ['commercial_property']);
  assert.deepEqual(lib.decideApproval(q({ property_type: 'commercial' }), 100, { ...SETTINGS, commercial_requires_approval: false }).reasons, [], 'the commercial rule is a setting');
  assert.deepEqual(lib.decideApproval(q(), 799, SETTINGS).required, false);
  assert.deepEqual(lib.decideApproval(q(), 800, SETTINGS).reasons, ['estimated_value>=800']);
});

test('routing: every pest/interest combination has a price', () => {
  for (const pest of lib.PEST_TYPES) for (const interest of lib.SERVICE_INTERESTS) {
    assert.ok(PRICING.first_year_value[pest][interest] > 0, `${pest}/${interest}`);
  }
});

test('routing: urgency windows are computed in the branch time zone', () => {
  const days = SETTINGS.urgency_window_days;
  assert.deepEqual(lib.urgencyWindow('emergency', NOW, 'America/Chicago', days), { start_date: '2026-10-12', end_date: '2026-10-13' });
  assert.deepEqual(lib.urgencyWindow('high', NOW, 'America/New_York', days), { start_date: '2026-10-12', end_date: '2026-10-15' });
  assert.deepEqual(lib.urgencyWindow('normal', NOW, 'America/New_York', days), { start_date: '2026-10-12', end_date: '2026-10-19' });
  // 02:00 UTC on the 13th is still the evening of the 12th in Chicago
  assert.equal(lib.urgencyWindow('normal', Date.parse('2026-10-13T02:00:00Z'), 'America/Chicago', days).start_date, '2026-10-12');
  // the number of days is a rule from the sheet
  assert.equal(lib.urgencyWindow('normal', NOW, 'America/New_York', { ...days, normal: 14 }).end_date, '2026-10-26');
  assert.throws(() => lib.urgencyWindow('normal', NOW, 'America/New_York'), /No urgency window/);
});

test('routing: contact match prefers email over phone', () => {
  const lead = { email: 'a@x.example', phone: '+19045550100' };
  const results = [{ id: '1', properties: { phone: '+19045550100', email: 'other@x.example' } }, { id: '2', properties: { email: 'A@x.example' } }];
  assert.equal(lib.pickContactMatch(results, lead).id, '2');
  assert.equal(lib.pickContactMatch([results[0]], lead).id, '1');
  assert.equal(lib.pickContactMatch([], lead), null);
});

test('routing: a deal created by an earlier attempt of the same event is read by its unique event id and reused', () => {
  const found = { statusCode: 200, body: { id: '12', properties: { ridgeway_event_id: 'evt-a-0001', dealstage: 'ridgeway_new_lead' } } };
  assert.deepEqual(lib.pickDealLookup(found, 'evt-a-0001'), { status: 200, found: true, record: found.body });
  assert.deepEqual(lib.pickDealLookup({ statusCode: 404, body: { category: 'OBJECT_NOT_FOUND' } }, 'evt-a-0001'), { status: 404, found: false, record: null }, '404 is an answer: no such deal');
  assert.equal(lib.pickDealLookup({ statusCode: 200, body: JSON.stringify(found.body) }, 'evt-a-0001').record.id, '12', 'a body n8n left as text is parsed');
  assert.throws(() => lib.pickDealLookup(found, 'evt-none-001'), /carries another ridgeway_event_id/, 'a deal of another event is never reused');
  assert.throws(() => lib.pickDealLookup({ statusCode: 429, body: { message: 'You have reached your ten secondly limit.' } }, 'evt-a-0001'), /answered 429: You have reached/, 'a rate limit fails the run (into the error workflow)');
  assert.throws(() => lib.pickDealLookup({ statusCode: 503 }, 'evt-a-0001'), /answered 503/);
  assert.throws(() => lib.readHubspotLookup({}), /no status/);
  assert.deepEqual(lib.hubspotDealLookupQuery(), { idProperty: 'ridgeway_event_id', properties: 'dealname,dealstage,pipeline,ridgeway_event_id' });
  assert.deepEqual(lib.hubspotContactLookupQuery().idProperty, 'email');
  assert.equal(lib.hubspotDealBody({ ...sampleCtx(), event_id: 'evt-a-0001' }).properties.ridgeway_event_id, 'evt-a-0001', 'the deal carries the property the lookup uses');
});

test('routing: a reused deal that already moved on keeps its stage; a new one, or one still in New lead, moves to Needs approval', () => {
  const required = { approval: { required: true, reasons: ['pest_type:termites'] } };
  const move = hubspot => lib.needsApprovalMove(sampleCtx({ ...required, hubspot: { contact_id: '10', deal_id: '11', ...hubspot } }));
  assert.equal(move({ deal_reused: false }), true);
  assert.equal(move({ deal_reused: true, deal_stage: 'ridgeway_new_lead' }), true, 'an earlier attempt stopped before the stage move');
  for (const stage of ['ridgeway_needs_approval', 'ridgeway_approved', 'ridgeway_on_hold']) assert.equal(move({ deal_reused: true, deal_stage: stage }), false, stage);
  assert.equal(lib.needsApprovalMove(sampleCtx()), false, 'no approval, no move');
});

// ------------------------------------------------------------------ time zones and slots

test('timeutil: wall-clock to instant across DST and zones', () => {
  assert.equal(new Date(lib.zonedToInstantMs('2026-10-12', '10:00:00', 'America/Chicago')).toISOString(), '2026-10-12T15:00:00.000Z');
  assert.equal(new Date(lib.zonedToInstantMs('2026-10-12', '10:00:00', 'America/New_York')).toISOString(), '2026-10-12T14:00:00.000Z');
  assert.equal(new Date(lib.zonedToInstantMs('2026-11-02', '10:00:00', 'America/New_York')).toISOString(), '2026-11-02T15:00:00.000Z', 'after DST ends');
  assert.equal(lib.addDaysToDateString('2026-10-30', 3), '2026-11-02');
  assert.equal(lib.formatSlotLabel('2026-10-13', '13:00:00', '15:00:00'), 'Tue, Oct 13, 1:00 PM to 3:00 PM');
});

const spot = (date, start, end, id) => ({ spotID: id ?? `${date}-${start}`, date, start, end });

test('slots: at most three, inside the window, not in the past', () => {
  const spots = [
    spot('2026-10-12', '08:00:00', '10:00:00'), // already started in Jacksonville (10:00 EDT now)
    spot('2026-10-12', '10:30:00', '12:00:00'), // starts inside the 60 minute lead time
    spot('2026-10-12', '13:00:00', '15:00:00'),
    spot('2026-10-13', '08:00:00', '10:00:00'),
    spot('2026-10-13', '10:00:00', '12:00:00'),
    spot('2026-10-14', '08:00:00', '10:00:00'),
    spot('2026-10-25', '08:00:00', '10:00:00'), // outside the window
  ];
  const window = { start_date: '2026-10-12', end_date: '2026-10-19' };
  const normal = lib.pickSlots(spots, { nowMs: NOW, timeZone: 'America/New_York', window, urgency: 'normal' });
  assert.deepEqual(normal.map(s => s.date), ['2026-10-12', '2026-10-13', '2026-10-14'], 'normal leads see different days');
  assert.equal(normal[0].start, '13:00:00');
  const emergency = lib.pickSlots(spots, { nowMs: NOW, timeZone: 'America/New_York', window: { start_date: '2026-10-12', end_date: '2026-10-13' }, urgency: 'emergency' });
  assert.deepEqual(emergency.map(s => `${s.date} ${s.start}`), ['2026-10-12 13:00:00', '2026-10-13 08:00:00', '2026-10-13 10:00:00'], 'emergency leads get the earliest slots');
  assert.deepEqual(lib.pickSlots([], { nowMs: NOW, timeZone: 'America/New_York', window, urgency: 'normal' }), []);
  assert.deepEqual(lib.pickSlots(undefined, { nowMs: NOW, timeZone: 'America/New_York', window, urgency: 'normal' }), []);
});

test('slots: a window several technicians have free is offered once', () => {
  const spots = [
    { ...spot('2026-10-12', '13:00:00', '15:00:00', 'T1-a'), routeID: 'R1' },
    { ...spot('2026-10-12', '15:00:00', '17:00:00', 'T1-b'), routeID: 'R1' },
    { ...spot('2026-10-12', '15:00:00', '17:00:00', 'T2-b'), routeID: 'R2' },
    { ...spot('2026-10-13', '15:00:00', '17:00:00', 'T1-c'), routeID: 'R1' },
    { ...spot('2026-10-13', '15:00:00', '17:00:00', 'T2-c'), routeID: 'R2' },
  ];
  const window = { start_date: '2026-10-12', end_date: '2026-10-13' };
  const emergency = lib.pickSlots(spots, { nowMs: NOW, timeZone: 'America/New_York', window, urgency: 'emergency' });
  assert.deepEqual(emergency.map(s => `${s.date} ${s.start}`), ['2026-10-12 13:00:00', '2026-10-12 15:00:00', '2026-10-13 15:00:00'], 'three different windows, not Monday 3 PM twice');
  assert.deepEqual(emergency.map(s => s.spot_id), ['T1-a', 'T1-b', 'T1-c'], 'the first route listed keeps the window');
  const normal = lib.pickSlots(spots, { nowMs: NOW, timeZone: 'America/New_York', window, urgency: 'normal' });
  assert.equal(new Set(normal.map(s => `${s.date} ${s.start}`)).size, normal.length);
  assert.equal(normal.length, 3);
});

// ------------------------------------------------------------------ idempotency

test('idempotency: the ledger answer decides the next step and anything odd fails the run', () => {
  assert.deepEqual(lib.interpretClaim({ outcome: 'claimed' }), { route: 'claimed', reason: null });
  assert.deepEqual(lib.interpretClaim({ outcome: 'claimed', reclaimed: 'after_failure' }), { route: 'claimed', reason: 'after_failure' });
  assert.deepEqual(lib.interpretClaim({ outcome: 'in_flight', retry_after_s: 30 }), { route: 'in_flight', reason: 'in_flight' });
  assert.deepEqual(lib.interpretClaim({ outcome: 'done', status: 'auto_proposed' }), { route: 'duplicate', reason: 'already_processed' });
  for (const odd of [null, undefined, {}, { outcome: 'maybe' }, { error: { message: 'boom' } }, 'claimed']) {
    assert.throws(() => lib.interpretClaim(odd), /event ledger/, `fails closed on ${JSON.stringify(odd)}`);
  }
  assert.deepEqual(lib.claimRequestBody('evt-a-0001', 42), { event_id: 'evt-a-0001', run_id: '42' });
  assert.deepEqual(lib.doneRequestBody('evt-a-0001', 42, 'auto_proposed'), { event_id: 'evt-a-0001', run_id: '42', status: 'auto_proposed' });
  const reason = lib.failRequestBody('HubSpot said no for jo.rivera@mail.example\n  call (904) 555-0188 '.repeat(20)).reason;
  assert.ok(reason.length <= 300 && !/@|555-0188|\n/.test(reason), 'the failure reason handed to the ledger carries no contact details');
  assert.equal(lib.RETRY_AFTER_SECONDS, 30);
});

const ledgerCall = (mock, path, body, token = 't') => fetch(`${mock.url}/ledger/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-run-id': String(body?.run_id ?? '1') }, body: JSON.stringify(body) }).then(res => res.json());

test('ledger: claim, in flight, done, failed and stale claims, and the 7-day TTL', async () => {
  let now = Date.parse('2026-10-12T14:00:00Z');
  const mock = await startMock({ clock: () => now });
  try {
    const claim = (event, run) => ledgerCall(mock, 'events/claim', { event_id: event, run_id: run });
    assert.deepEqual(await claim('evt-a-0001', 1), { outcome: 'claimed' });
    assert.deepEqual(await claim('evt-a-0001', 1), { outcome: 'claimed' }, 'the same run claiming again (an n8n retry) is not a conflict');
    assert.deepEqual(await claim('evt-a-0001', 2), { outcome: 'in_flight', retry_after_s: 30 }, 'another run while the first is going');
    assert.deepEqual(await ledgerCall(mock, 'events/complete', { event_id: 'evt-a-0001', run_id: 2, status: 'x' }), { ok: false, outcome: 'not_owner' }, 'only the owner completes');
    assert.deepEqual(await ledgerCall(mock, 'events/complete', { event_id: 'evt-a-0001', run_id: 1, status: 'auto_proposed' }), { ok: true });
    assert.deepEqual(await claim('evt-a-0001', 3), { outcome: 'done', status: 'auto_proposed' });
    // a failed run hands the claim back
    await claim('evt-b-0001', 10);
    assert.deepEqual(await ledgerCall(mock, 'runs/10/fail', { reason: 'boom' }), { event_id: 'evt-b-0001', state: 'failed' });
    assert.deepEqual(await ledgerCall(mock, 'runs/10/fail', { reason: 'again' }), { event_id: null, state: 'unknown_run' }, 'releasing twice does nothing');
    assert.deepEqual(await claim('evt-b-0001', 11), { outcome: 'claimed', reclaimed: 'after_failure' });
    // a crashed run that never reported goes stale after 10 minutes
    await claim('evt-c-0001', 20);
    now += 9 * 60 * 1000;
    assert.equal((await claim('evt-c-0001', 21)).outcome, 'in_flight');
    now += 61 * 1000;
    assert.deepEqual(await claim('evt-c-0001', 21), { outcome: 'claimed', reclaimed: 'stale_attempt' });
    const state = await (await fetch(`${mock.url}/__state`)).json();
    assert.equal(state.ledger.find(item => item.event_id === 'evt-b-0001').attempts, 2);
    // TTL
    now += 7 * 24 * 3600 * 1000 + 1;
    assert.deepEqual(await claim('evt-a-0001', 30), { outcome: 'claimed' }, 'expired after 7 days');
    assert.equal((await fetch(`${mock.url}/ledger/v1/events/claim`, { method: 'POST', body: '{}' })).status, 401, 'auth required');
    assert.equal((await ledgerCall(mock, 'events/claim', {})).error, 'event_id and run_id are required');
  } finally {
    await mock.close();
  }
});

test('ledger: the failure path records a timestamp and a fault before the commit changes nothing', async () => {
  const mock = await startMock({ seed: false });
  try {
    await ledgerCall(mock, 'events/claim', { event_id: 'evt-a-0001', run_id: 5 });
    await fetch(`${mock.url}/__control`, { method: 'POST', body: JSON.stringify({ faults: [{ op: 'ledger.fail', status: 503, times: 1 }] }) });
    const first = await fetch(`${mock.url}/ledger/v1/runs/5/fail`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{}' });
    assert.equal(first.status, 503);
    assert.equal((await (await fetch(`${mock.url}/__state`)).json()).ledger[0].state, 'in_flight', 'a rejected release changed nothing');
    await ledgerCall(mock, 'runs/5/fail', { reason: 'boom' });
    const entry = (await (await fetch(`${mock.url}/__state`)).json()).ledger[0];
    assert.equal(entry.state, 'failed');
    assert.match(entry.failed_at, /^\d{4}-\d\d-\d\dT/);
    const log = await (await fetch(`${mock.url}/__log`)).json();
    assert.deepEqual(log.map(item => [item.op, item.outcome ?? null]), [['ledger.claim', 'claimed'], ['ledger.fail', null], ['ledger.fail', 'failed']]);
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------------------------ ops rules sheet

test('rules: the ops rules sheet rows become lookup tables', () => {
  assert.deepEqual(SERVICE_AREA.branches.map(b => [b.id, b.timezone, b.fieldroutes_office_id]),
    [['jacksonville', 'America/New_York', 1], ['savannah', 'America/New_York', 2], ['mobile', 'America/Chicago', 3]]);
  assert.ok(SERVICE_AREA.branches[0].zips.includes('32207'));
  const { clickup_fields: clickupFields, hubspot, ...plain } = SETTINGS;
  // The mock's sheet keeps the invented ids of the seeded pipeline; a live portal's generated ids replace them.
  assert.deepEqual(hubspot, {
    pipeline_id: 'ridgeway_sales', stages: { new_lead: 'ridgeway_new_lead', needs_approval: 'ridgeway_needs_approval', approved: 'ridgeway_approved', on_hold: 'ridgeway_on_hold' },
    app_url: 'https://app.hubspot.example/contacts/0000000/record', email_fallback: 'off',
  });
  assert.deepEqual(plain, {
    commercial_multiplier: 2, emergency_surcharge: 75, approval_value_threshold: 800, approval_pest_types: ['termites', 'wildlife'],
    confidence_threshold: 0.6, urgency_window_days: { emergency: 1, high: 3, normal: 7 }, commercial_requires_approval: true,
    wdo_keywords: ['wdo', 'wood destroying', 'termite letter', 'termite clearance'], callback_hours: { emergency: 1, high: 4, normal: 24 },
  });
  assert.equal(PRICING.first_year_value.termites.inspection, 1200);
  assert.deepEqual(PRICING.first_year_value.wdo_letter, { inspection: 125, one_time: 125, recurring: 125 });
  // The ClickUp field and option ids in the sheet are the ones the seeded CSR Queue list really has.
  const list = fixture('clickup/csr-queue.json');
  const byName = Object.fromEntries(list.fields.map(field => [field.name, field]));
  assert.deepEqual(Object.fromEntries(Object.entries(clickupFields).map(([key, field]) => [key, field.id])),
    { branch: byName.Branch.id, pest: byName.Pest.id, urgency: byName.Urgency.id, deal_link: byName['HubSpot deal link'].id, callback_by: byName['Callback by'].id });
  const optionName = (field, id) => byName[field].type_config.options.find(option => option.id === id)?.name;
  for (const [branch, id] of Object.entries(clickupFields.branch.options)) assert.equal(optionName('Branch', id), SERVICE_AREA.branches.find(b => b.id === branch).name);
  for (const [pest, id] of Object.entries(clickupFields.pest.options)) assert.equal(optionName('Pest', id)?.toLowerCase(), pest.replace(/_/g, ' '));
  for (const [urgency, id] of Object.entries(clickupFields.urgency.options)) assert.equal(optionName('Urgency', id)?.toLowerCase(), urgency);
});

test('rules: the HubSpot pipeline, stage ids and record-link base are sheet rows, checked like every other rule', () => {
  const rows = OPS_RULES.tabs.Settings.rows;
  const withRow = (key, value) => ({ values: [...rows.filter(([name]) => name !== key), ...(value === undefined ? [] : [[key, value]])] });
  assert.throws(() => lib.parseSettings(withRow('hubspot_stage_approved')), /hubspot_stage_approved is missing/);
  assert.throws(() => lib.parseSettings(withRow('hubspot_pipeline_id', 'has spaces')), /hubspot_pipeline_id is missing or not a HubSpot id/);
  assert.throws(() => lib.parseSettings(withRow('hubspot_stage_on_hold', 'ridgeway_approved')), /four different stages/);
  assert.throws(() => lib.parseSettings(withRow('hubspot_app_url', 'https://evil.example/contacts/1/record')), /hubspot_app_url must look like/);
  assert.equal(lib.parseSettings(withRow('hubspot_app_url', 'https://app-na2.hubspot.com/contacts/247657707/record')).hubspot.app_url, 'https://app-na2.hubspot.com/contacts/247657707/record', 'a regional app host');
  assert.equal(lib.parseSettings(withRow('hubspot_email_fallback')).hubspot.email_fallback, 'off', 'no row means off');
  const ctx = sampleCtx({ settings: lib.parseSettings(withRow('hubspot_app_url', 'https://app-na2.hubspot.com/contacts/247657707/record')) });
  assert.equal(lib.dealLink(ctx.settings, '11'), 'https://app-na2.hubspot.com/contacts/247657707/record/0-3/11');
  assert.ok(lib.csrTaskDescription(ctx).includes('https://app-na2.hubspot.com/contacts/247657707/record/0-1/10'), 'the CSR task links into the portal');
});

test('rules: a broken sheet fails loudly instead of routing on bad rules', () => {
  assert.throws(() => lib.parseServiceArea({ error: 'boom' }), /missing or empty/);
  assert.throws(() => lib.parseServiceArea({ values: [['x', 'X', 'FL', '', '1', '32202']] }), /incomplete/);
  assert.throws(() => lib.parsePricing({ values: [['ants', '1', 'oops', '3']] }), /invalid/);
  assert.throws(() => lib.parsePricing(tab('Pricing').values ? { values: tab('Pricing').values.slice(1) } : null), /no row for/);
  assert.throws(() => lib.parseSettings({ values: [['commercial_multiplier', '2']] }), /emergency_surcharge/);
  const rows = tab('Settings').values;
  const without = key => ({ values: rows.filter(([name]) => name !== key) });
  const changed = (key, value) => ({ values: rows.map(row => (row[0] === key ? [key, value] : row)) });
  assert.throws(() => lib.parseSettings(without('confidence_threshold')), /confidence_threshold/);
  assert.throws(() => lib.parseSettings(changed('confidence_threshold', '1.5')), /confidence_threshold/);
  assert.throws(() => lib.parseSettings(without('urgency_window_days_high')), /urgency_window_days_high/);
  assert.throws(() => lib.parseSettings(changed('urgency_window_days_normal', 'a week')), /urgency_window_days_normal/);
  assert.throws(() => lib.parseSettings(without('commercial_requires_approval')), /commercial_requires_approval/);
  assert.throws(() => lib.parseSettings(changed('commercial_requires_approval', 'yes')), /commercial_requires_approval/);
  assert.equal(lib.parseSettings(changed('commercial_requires_approval', 'false')).commercial_requires_approval, false);
  assert.throws(() => lib.parseSettings(without('callback_hours_high')), /callback_hours_high/);
  assert.throws(() => lib.parseSettings(without('clickup_field_pest')), /clickup_field_pest/);
  assert.throws(() => lib.parseSettings(changed('clickup_options_urgency', 'emergency=u1,high=u2')), /no option for normal/);
  assert.throws(() => lib.parseSettings(changed('clickup_options_branch', 'jacksonville')), /malformed entry/);
  assert.deepEqual(lib.parseSettings(without('wdo_keywords')).wdo_keywords, [], 'no keywords: nothing is priced as a termite letter');
});

// ------------------------------------------------------------------ messages and vendor requests

function sampleCtx(overrides = {}) {
  const lead = lib.normalizeLead(scenarios[1].payload).lead; // Ayesha Rahman, SMS consent
  const slots = [
    { spot_id: '2-1', date: '2026-10-12', start: '15:00:00', end: '17:00:00', label: 'Mon, Oct 12, 3:00 PM to 5:00 PM' },
    { spot_id: '2-2', date: '2026-10-13', start: '08:00:00', end: '10:00:00', label: 'Tue, Oct 13, 8:00 AM to 10:00 AM' },
  ];
  return {
    event_id: lead.event_id, received_at: '2026-10-12T14:00:00.000Z', lead, slots,
    branch: lib.findBranch(SERVICE_AREA, lead.zip),
    qualification: { ...goodOutput, summary: 'Ants.' },
    approval: { required: false, reasons: [] }, estimated_value: 480,
    hubspot: { contact_id: '10', deal_id: '11' }, clickup_task_id: '86abc',
    outreach: { email: { omitted_reason: null }, sms: { proposed: true, text: 't', omitted_reason: null } },
    ai: { status: 'ok', reason: null, qualification: goodOutput },
    settings: SETTINGS,
    ...overrides,
  };
}

test('messages: SMS is proposed only with explicit consent', () => {
  const ctx = sampleCtx();
  const proposal = lib.proposeSms(ctx);
  assert.equal(proposal.proposed, true);
  assert.match(proposal.text, /Mon, Oct 12, 3:00 PM to 5:00 PM or Tue, Oct 13/);
  assert.match(proposal.text, /Reply STOP to opt out\.$/);
  assert.deepEqual(lib.proposeSms({ ...ctx, lead: { ...ctx.lead, sms_consent: false } }), { proposed: false, text: null, omitted_reason: 'no_sms_consent' });
  assert.equal(lib.proposeSms({ ...ctx, lead: { ...ctx.lead, sms_consent: true, phone: null } }).omitted_reason, 'no_phone');
  assert.match(lib.proposeSms({ ...ctx, slots: [] }).text, /call you shortly/);
});

test('messages: the email is a draft with proposed slots, and no email means no draft', () => {
  const ctx = sampleCtx();
  const email = lib.buildEmailDraft(ctx);
  assert.equal(email.to, 'ayesha.rahman@gmail.example');
  assert.match(email.body, /1\. Mon, Oct 12/);
  assert.match(email.body, /Demo draft: fictional company, not sent/);
  const raw = Buffer.from(lib.buildMimeRaw(email), 'base64url').toString('utf8');
  assert.match(raw, /^From: Ridgeway Pest Control <leads@ridgeway-pest\.example>\r\nTo: ayesha\.rahman@gmail\.example\r\n/);
  assert.deepEqual(lib.gmailDraftBody('abc'), { message: { raw: 'abc' } });
  assert.equal(lib.buildEmailDraft({ ...ctx, lead: { ...ctx.lead, email: null } }).omitted_reason, 'no_email');
  assert.match(lib.buildEmailDraft(sampleCtx({ approval: { required: true, reasons: ['x'] } })).body, /specialist will review/);
});

test('messages: Slack approval buttons only when approval is required', () => {
  const plain = lib.slackSummary(sampleCtx(), 'auto_proposed');
  assert.equal(plain.channel, '#leads');
  assert.ok(!plain.blocks.some(block => block.type === 'actions'));
  const gated = lib.slackSummary(sampleCtx({ approval: { required: true, reasons: ['commercial_property'] } }), 'approval_required');
  const actions = gated.blocks.find(block => block.type === 'actions');
  assert.deepEqual(actions.elements.map(e => e.action_id), ['approve_lead', 'hold_lead']);
  // The button carries the event id only: the approval workflow looks the deal up in the ledger.
  assert.deepEqual(actions.elements.map(e => e.value), [sampleCtx().event_id, sampleCtx().event_id]);
  assert.equal(lib.slackSummary(sampleCtx({ channels: lib.slackChannels({ SLACK_LEADS_CHANNEL: 'C0C867WL7AR' }) }), 'auto_proposed').channel, 'C0C867WL7AR', 'a channel id from the environment');
  assert.deepEqual(lib.slackChannels({}), { leads: '#leads', alerts: '#automation-alerts' }, 'unset means the mock channel names');
  assert.deepEqual(lib.slackChannels({ SLACK_LEADS_CHANNEL: ' ', SLACK_ALERTS_CHANNEL: 'C0C89HQ4VML' }), { leads: '#leads', alerts: 'C0C89HQ4VML' });
});

test('messages: the CSR task carries ids, links and the plan, not contact details', () => {
  const text = lib.csrTaskDescription(sampleCtx());
  for (const expected of ['Ayesha, ZIP 31405', 'Savannah, GA', 'record/0-1/10', 'record/0-3/11', '(New lead)', 'Estimated value: $480', 'Proposed slots:', 'Proposed SMS (customer opted in, not sent)']) {
    assert.ok(text.includes(expected), `missing "${expected}"`);
  }
});

test('messages: Slack, ClickUp and Sheets text never contains phone, email or last name', () => {
  const ctx = sampleCtx({ clickup_task_id: '86abc', fieldroutes: { customer_id: '48213' }, callback_task_id: '86def', path: 'qualified' });
  const approval = sampleCtx({ approval: { required: true, reasons: ['commercial_property'] } });
  const texts = [
    lib.csrTaskDescription(ctx), lib.reviewTaskDescription(ctx), lib.serviceRequestTaskDescription(ctx), lib.callbackTaskDescription(ctx),
    JSON.stringify(lib.slackSummary(approval, 'approval_required')), JSON.stringify(lib.slackOutOfArea(ctx)), JSON.stringify(lib.slackReview(ctx)),
    JSON.stringify(lib.slackServiceRequest(ctx)), JSON.stringify(lib.slackFieldRoutesWarning(ctx)),
    JSON.stringify(lib.sheetsSpeedRow(ctx, '2026-10-12T14:00:01.000Z', 'auto_proposed')), lib.leadRef(ctx),
  ].join('\n');
  for (const secret of ['ayesha.rahman@gmail.example', '+19125550163', '9125550163', '912-555-0163', 'Rahman', '614 Wexford Pond Ln']) assert.ok(!texts.includes(secret), `leaked ${secret}`);
  assert.ok(texts.includes('Ayesha'));
});

test('messages: model text is redacted again at every internal sink, and a failed draft is never reported as created', () => {
  const echoed = { ...goodOutput, summary: 'Call (904) 555-0188 or jo.rivera@mail.example', red_flags: ['tel_904-555-0188'] };
  const ctx = sampleCtx({ qualification: echoed, ai: { status: 'needs_review', reason: 'invalid_output: pest_type is not an allowed value: "jo.rivera@mail.example"', qualification: echoed },
    fieldroutes: { customer_id: '48213' }, approval: { required: true, reasons: ['commercial_property'] } });
  const texts = [lib.csrTaskDescription(ctx), lib.reviewTaskDescription(ctx), lib.serviceRequestTaskDescription(ctx), JSON.stringify(lib.slackSummary(ctx, 'approval_required')),
    JSON.stringify(lib.slackReview(ctx)), JSON.stringify(lib.buildResult(ctx, 'auto_proposed'))].join('\n');
  assert.ok(!/jo\.rivera|555-0188|\(904\)/.test(texts), 'no echoed contact detail reaches a task, a Slack message or the response');
  assert.ok(texts.includes('[phone removed]') && texts.includes('[email removed]'));
  const created = lib.csrTaskDescription(sampleCtx());
  assert.match(created, /Email draft: created in Gmail, not sent/);
  const failed = lib.csrTaskDescription(sampleCtx({ outreach: { email: { to: 'ayesha.rahman@gmail.example', draft_failed: true, omitted_reason: 'draft_failed', error: '503' }, sms: { proposed: false, text: null, omitted_reason: 'no_sms_consent' } } }));
  assert.match(failed, /Email draft: FAILED, no draft was created/);
  assert.ok(!/created in Gmail/.test(failed));
});

test('requests: HubSpot search matches email OR phone; properties tag the lead and keep the message', () => {
  const lead = sampleCtx().lead;
  const body = lib.hubspotSearchBody(lead, SETTINGS);
  // HubSpot's search matches phones on area code and local number (search docs), so the 10 digits are searched too.
  assert.deepEqual(body.filterGroups.map(group => group.filters[0].value), ['ayesha.rahman@gmail.example', '+19125550163', '9125550163'], 'separate filter groups are ORed by HubSpot');
  assert.equal(lib.hubspotSearchBody({ ...lead, email: null }, SETTINGS).filterGroups.length, 2);
  assert.equal(lib.hubspotSearchBody({ ...lead, phone: '+442079460958' }, SETTINGS).filterGroups.length, 2, 'only a +1 number gets the 10-digit search');
  const created = lib.hubspotContactProperties({ ...sampleCtx(), path: 'out_of_area' }, false);
  assert.equal(created.ridgeway_tags, 'out-of-area');
  assert.equal(created.firstname, 'Ayesha');
  assert.deepEqual([created.city, created.state, 'address' in created], ['Savannah', 'GA', false], 'a caller gives no street, only the carrier\'s city and state');
  const webCtx = { ...sampleCtx(), lead: lib.normalizeLead(scenarios[0].payload).lead, path: 'qualified' };
  const withAddress = lib.hubspotContactProperties(webCtx, false);
  assert.deepEqual([withAddress.address, withAddress.city, withAddress.state, withAddress.zip], ['2218 Cutler Marsh Rd', 'Jacksonville', 'FL', '32207'], 'the service address lives in the CRM');
  assert.ok(!('address' in lib.hubspotContactProperties(webCtx, true)), 'an existing contact keeps the address it has');
  assert.match(created.ridgeway_last_inquiry, /quarterly thing/, 'the original message lives in the CRM');
  const updated = lib.hubspotContactProperties({ ...sampleCtx(), path: 'qualified' }, true);
  assert.ok(!('firstname' in updated), 'existing contact names are not overwritten');
  const deal = lib.hubspotDealBody(sampleCtx());
  assert.deepEqual([deal.properties.dealstage, deal.properties.amount, deal.properties.pipeline], ['ridgeway_new_lead', '480', 'ridgeway_sales']);
  assert.equal(lib.hubspotDealStageBody(SETTINGS).properties.dealstage, 'ridgeway_needs_approval');
  const generated = { ...SETTINGS, hubspot: { ...SETTINGS.hubspot, pipeline_id: '880100001', stages: { new_lead: '1290000001', needs_approval: '1290000004', approved: '1290000005', on_hold: '1290000006' } } };
  assert.deepEqual([lib.hubspotDealBody(sampleCtx({ settings: generated })).properties.pipeline, lib.hubspotDealBody(sampleCtx({ settings: generated })).properties.dealstage], ['880100001', '1290000001'], 'a live portal\'s generated ids come from the sheet');
});

test('requests: the HubSpot email fallback maps only .example addresses, to example.com, and is off by default', () => {
  const on = { hubspot: { ...SETTINGS.hubspot, email_fallback: 'example_com' } };
  assert.equal(lib.hubspotEmail('ayesha.rahman@gmail.example', SETTINGS), 'ayesha.rahman@gmail.example', 'off: the address as given');
  assert.equal(lib.hubspotEmail('ayesha.rahman@gmail.example', on), 'ayesha.rahman+gmail@example.com');
  assert.equal(lib.hubspotEmail('Imani.Jefferson@HartwellPG.example', on), 'Imani.Jefferson+hartwellpg@example.com');
  assert.equal(lib.hubspotEmail('leads@ridgeway-pest.co.example', on), 'leads+ridgeway-pest-co@example.com');
  assert.equal(lib.hubspotEmail('someone@gmail.com', on), 'someone@gmail.com', 'never rewrites a real domain into anything');
  assert.equal(lib.hubspotEmail(null, on), null);
  // Every fixture address maps to example.com (reserved by RFC 2606), never to another domain.
  const emails = new Set(JSON.stringify([fixture('scenarios.json'), fixture('day/leads.json'), fixture('hubspot/contacts.json')]).match(/[\w.+-]+@[\w.-]+\.example\b/g));
  for (const email of emails) assert.match(lib.hubspotEmail(email, on), /^[^@\s]+\+[a-z0-9-]+@example\.com$/, email);
  const ctx = sampleCtx({ settings: { ...SETTINGS, ...on } });
  assert.equal(lib.hubspotContactProperties(ctx, false).email, 'ayesha.rahman+gmail@example.com', 'the contact is stored with the mapped address');
  assert.equal(lib.hubspotSearchBody(ctx.lead, ctx.settings).filterGroups[0].filters[0].value, 'ayesha.rahman+gmail@example.com', 'and searched by it, so a re-run finds it');
  assert.throws(() => lib.parseSettings({ values: [...OPS_RULES.tabs.Settings.rows.filter(([key]) => key !== 'hubspot_email_fallback'), ['hubspot_email_fallback', 'gmail_com']] }), /hubspot_email_fallback must be one of off, example_com/);
});

test('requests: FieldRoutes queries and the speed-to-lead row', () => {
  const ctx = sampleCtx({ window: { start_date: '2026-10-12', end_date: '2026-10-19' } });
  assert.deepEqual(lib.fieldRoutesCustomerQuery(ctx), { includeData: '1', phone: '9125550163' });
  assert.deepEqual(lib.fieldRoutesCustomerQuery({ lead: { phone: null, email: 'a@b.example' } }), { includeData: '1', email: 'a@b.example' });
  assert.deepEqual(lib.fieldRoutesSpotQuery(ctx), { officeIDs: '[2]', dateStart: '2026-10-12', dateEnd: '2026-10-19' });
  assert.deepEqual(lib.sheetsSpeedRow(ctx, '2026-10-12T14:00:01.000Z', 'auto_proposed').values[0],
    ['evt-ants-ga-002', '2026-10-12T14:00:00.000Z', '2026-10-12T14:00:01.000Z', 'call_tracking', 'savannah', 'ants', 'normal', 'auto_proposed']);
  assert.equal(lib.clickupTaskBody({ name: 'n', description: 'd', urgency: 'emergency', tags: [] }).priority, 1);
});

test('ctx: HTTP error items are described, results are shaped', () => {
  assert.deepEqual(lib.describeHttp({ id: 1 }), { ok: true, error: null });
  assert.equal(lib.describeHttp({ error: { message: '503 - boom' } }).error, '503 - boom');
  assert.equal(lib.describeHttp(null).ok, false);
  const result = lib.buildResult(sampleCtx(), 'auto_proposed');
  assert.deepEqual(Object.keys(result).slice(0, 9), ['status', 'event_id', 'branch', 'pest_type', 'urgency', 'slots', 'hubspot', 'clickup_task_id', 'approval_required']);
  const failure = lib.describeFailure({ execution: { id: '7', lastNodeExecuted: 'Search HubSpot contact', error: { message: 'x'.repeat(500) } }, workflow: { name: 'W' } }, 'now');
  assert.equal(failure.slack.channel, '#automation-alerts');
  assert.ok(failure.slack.text.length < 460);
  assert.ok(!failure.slack.text.includes(', event '), 'no event id when the failed run never claimed one');
  const known = lib.describeFailure({ execution: { id: '7', lastNodeExecuted: 'Create ClickUp CSR task', error: { message: 'bad request for jo.rivera@mail.example' } }, workflow: { name: 'W' } }, 'now', 'evt-a-0001');
  assert.match(known.slack.text, /execution 7, event evt-a-0001\)/);
  assert.deepEqual(known.sheet.values[0].slice(2), ['7', 'Create ClickUp CSR task', 'bad request for [email removed]', 'evt-a-0001'], 'the Errors row carries the event id as the sixth column');
});

// ------------------------------------------------------------------ module loading and workflow builder

const VERBS = ['Receive', 'Verify', 'Check', 'Respond', 'Normalize', 'Prepare', 'Qualify', 'Apply', 'Fetch', 'Route', 'Find', 'Branch', 'Create', 'Update', 'Post', 'Reuse',
  'Search', 'Record', 'Associate', 'Pick', 'Move', 'Compose', 'Append', 'Describe', 'Claim', 'Mark', 'Release', 'Validate', 'Add'];

test('modules: no duplicate top-level names, every file is loaded', () => {
  assert.ok(Object.keys(lib).length > 60);
  assert.equal(MODULE_FILES.length, 13);
});

test('builder: generated workflow JSON is up to date and well formed', () => {
  const built = buildAll();
  assert.deepEqual(Object.keys(built), ['book-new-lead.json', 'alert-on-errors.json', 'handle-approval.json']);
  for (const [file, workflow] of Object.entries(built)) {
    assert.equal(readFileSync(join(root, 'workflow', file), 'utf8'), `${JSON.stringify(workflow, null, 2)}\n`, `${file} is stale: run node workflow/build-workflow.mjs`);
    const names = workflow.nodes.map(node => node.name);
    assert.equal(new Set(names).size, names.length, 'unique node names');
    for (const [from, outputs] of Object.entries(workflow.connections)) {
      assert.ok(names.includes(from), `connection source ${from} exists`);
      for (const group of outputs.main) for (const link of group) assert.ok(names.includes(link.node), `${from} -> ${link.node} exists`);
    }
  }
  const main = built['book-new-lead.json'];
  assert.equal(main.settings.errorWorkflow, built['alert-on-errors.json'].id, 'error workflow wired');
  assert.equal(built['alert-on-errors.json'].settings.errorWorkflow, undefined, 'the error workflow has no error workflow');
  assert.equal(built['handle-approval.json'].settings.errorWorkflow, built['alert-on-errors.json'].id, 'the approval workflow has the error workflow too');
  const webhook = main.nodes.find(node => node.type === 'n8n-nodes-base.webhook');
  assert.equal(webhook.parameters.options.rawBody, true);
  assert.equal(webhook.parameters.path, 'ridgeway/lead');
});

test('builder: house style (ids, names, timezone, notes, stickies)', () => {
  const built = buildAll();
  for (const workflow of Object.values(built)) {
    assert.equal(workflow.id.length, 16, `${workflow.name}: fixed 16-character id`);
    assert.match(workflow.name, /^Pest Lead Agent · /, 'project prefix');
    assert.equal(workflow.settings.timezone, 'America/New_York');
    const stickies = workflow.nodes.filter(node => node.type === 'n8n-nodes-base.stickyNote').map(node => node.name);
    assert.equal(stickies[0], 'Read me');
    assert.ok(stickies.slice(1).every((name, i) => name.startsWith(`${i + 1}. `)), `numbered section stickies in order: ${stickies}`);
    for (const node of workflow.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote')) {
      assert.ok(VERBS.includes(node.name.split(' ')[0]), `${node.name}: node names start with a verb`);
      assert.ok(node.notes && node.notes.length > 10 && node.notes.length < 220, `${node.name}: short note`);
      assert.equal(node.notesInFlow, true, `${node.name}: notesInFlow`);
    }
  }
  const main = built['book-new-lead.json'];
  assert.ok(main.nodes.filter(n => n.type === 'n8n-nodes-base.stickyNote').length >= 11);
});

test('builder: every node reachable from the webhook and no orphan connections', () => {
  const main = buildAll()['book-new-lead.json'];
  const seen = new Set(['Receive lead']);
  const queue = ['Receive lead'];
  while (queue.length) {
    const current = queue.shift();
    for (const group of main.connections[current]?.main ?? []) for (const link of group) if (!seen.has(link.node)) { seen.add(link.node); queue.push(link.node); }
  }
  const unreachable = main.nodes.filter(node => !seen.has(node.name) && node.type !== 'n8n-nodes-base.stickyNote').map(node => node.name);
  assert.deepEqual(unreachable, []);
});

test('builder: Code nodes compile and bring every module function they reference', () => {
  const built = buildAll();
  const topLevel = Object.keys(lib);
  for (const workflow of Object.values(built)) {
    for (const node of workflow.nodes.filter(n => n.type === 'n8n-nodes-base.code')) {
      const code = node.parameters.jsCode;
      assert.doesNotThrow(() => new Function('$', '$input', '$env', '$getWorkflowStaticData', 'require', `return (async function () {\n${code}\n}).call({ helpers: {} });`), `${node.name} must compile`);
      const defined = new Set([...code.matchAll(/^(?:async\s+)?function\s+(\w+)|^const\s+(\w+)\s*=/gm)].map(m => m[1] ?? m[2]));
      const glue = code.slice(code.lastIndexOf(`// ---- ${node.name} ----`));
      for (const name of topLevel) {
        if (new RegExp(`(?<![\\w'"./])${name}\\s*\\(`).test(glue)) assert.ok(defined.has(name), `${node.name} calls ${name} but does not include its module`);
      }
    }
  }
});

const LEDGER_NODES = ['Claim event', 'Mark event done', 'Release failed event', 'Claim decision', 'Mark decision done'];

test('builder: HTTP nodes use env-driven URLs, 3 retries 5 seconds apart, keys and run ids, and no inline secrets', () => {
  const built = buildAll();
  const http = Object.values(built).flatMap(workflow => workflow.nodes).filter(node => node.type === 'n8n-nodes-base.httpRequest');
  assert.equal(http.length, 38, 'the 35 of the live-Slack pass, without the deal search, plus three HubSpot lookups and the approval workflow\'s settings read');
  // A refused HubSpot create goes on to a lookup (a conflict is an answer there); everything else about them is critical.
  const soft = ['Create HubSpot contact', 'Create HubSpot deal', 'Qualify lead with Claude', 'Find FieldRoutes customer', 'Search FieldRoutes availability', 'Create Gmail draft', 'Append speed-to-lead row',
    'Post Slack leads summary', 'Post Slack review alert', 'Post Slack out-of-area note', 'Post Slack service request alert', 'Post Slack FieldRoutes warning',
    'Post Slack automation alert', 'Append error log row', 'Mark event done', 'Release failed event',
    'Post Slack approver notice', 'Update Slack approval message', 'Mark decision done'];
  for (const node of http) {
    assert.match(node.parameters.url, /^=\{\{ \$env\.[A-Z_]+_BASE_URL \}\}/, `${node.name} URL comes from env`);
    assert.deepEqual([node.retryOnFail, node.maxTries, node.waitBetweenTries], [true, 4, 5000], `${node.name}: 3 retries (4 tries), 5 seconds apart`);
    const headers = Object.fromEntries((node.parameters.headerParameters?.parameters ?? []).map(h => [h.name, h.value]));
    for (const [name, value] of Object.entries(headers)) {
      if (/authorization|key|token/i.test(name) && name !== 'Idempotency-Key') assert.match(value, /\$env\./, `${node.name} ${name} is an env expression`);
    }
    const ledger = LEDGER_NODES.includes(node.name);
    const writes = ['POST', 'PATCH', 'PUT'].includes(node.parameters.method) && !/search|Qualify/i.test(node.name) && !ledger;
    if (writes) {
      const prefix = node.name === 'Post Slack automation alert' ? '$json.failed_run_id' : node.name === 'Append error log row' ? "$('Compose alert').first().json.failed_run_id" : '$json.event_id';
      assert.equal(headers['Idempotency-Key'], `={{ ${prefix} }}:${node.name}`, `${node.name}: Idempotency-Key is <event id>:<node name>, not the execution id`);
      assert.equal(headers['X-Run-Id'], '={{ $execution.id }}', `${node.name} sends the execution id for traceability`);
    } else if (ledger) {
      assert.ok(!('Idempotency-Key' in headers), `${node.name}: the ledger is the dedupe authority`);
      assert.equal(headers['X-Run-Id'], '={{ $execution.id }}');
    } else {
      assert.ok(!('Idempotency-Key' in headers) && !('X-Run-Id' in headers), `${node.name} is a read`);
    }
    assert.equal(node.onError, soft.includes(node.name) ? 'continueErrorOutput' : 'stopWorkflow', `${node.name} onError`);
    // Only the three HubSpot reads by a unique value answer 404 as data (never error, full response); they stay retried on network errors.
    const lookup = ['Find HubSpot contact by email', 'Find HubSpot deal', 'Find HubSpot deal after conflict'].includes(node.name);
    assert.deepEqual(node.parameters.options.response ?? null, lookup ? { response: { neverError: true, fullResponse: true } } : null, `${node.name}: never-error only on the lookups`);
    if (lookup) assert.deepEqual([node.parameters.method, node.parameters.url.includes('/crm/v3/objects/'), node.onError], ['GET', true, 'stopWorkflow']);
  }
  const claude = http.find(node => node.name === 'Qualify lead with Claude');
  assert.match(claude.parameters.url, /ANTHROPIC_BASE_URL \}\}\/v1\/messages$/);
  assert.deepEqual(Object.fromEntries(claude.parameters.headerParameters.parameters.map(h => [h.name, h.value])),
    { 'x-api-key': '={{ $env.ANTHROPIC_API_KEY }}', 'anthropic-version': lib.ANTHROPIC_VERSION });
  assert.ok(!/sk-ant|Bearer [A-Za-z0-9]{8}/.test(JSON.stringify(built)), 'no tokens in the workflow JSON');
});

test('builder: the event ledger replaces static data, with 409 in flight, a claim release on failure and a done mark', () => {
  const built = buildAll();
  const main = built['book-new-lead.json'];
  const errors = built['alert-on-errors.json'];
  assert.ok(!JSON.stringify(main).includes('getWorkflowStaticData'), 'static data is saved only when a run ends, so it cannot see a run in flight');
  const next = (workflow, name, output = 0) => workflow.connections[name].main[output].map(link => link.node);
  assert.deepEqual(next(main, 'Check lead is valid'), ['Prepare event claim']);
  assert.deepEqual(next(main, 'Claim event'), ['Check event claim']);
  assert.deepEqual([0, 1, 2].map(output => next(main, 'Route claim result', output)[0]), ['Fetch ops settings', 'Respond 409 in flight', 'Respond duplicate']);
  const inFlight = main.nodes.find(node => node.name === 'Respond 409 in flight');
  assert.equal(inFlight.parameters.options.responseCode, 409);
  assert.deepEqual(inFlight.parameters.options.responseHeaders.entries, [{ name: 'Retry-After', value: '30' }]);
  assert.match(inFlight.parameters.responseBody, /status: 'in_flight'/);
  assert.equal(main.nodes.find(node => node.name === 'Respond duplicate').parameters.options.responseCode, 200);
  assert.deepEqual(next(main, 'Append speed-to-lead row').slice(0, 1), ['Prepare event done']);
  assert.deepEqual(next(main, 'Mark event done'), ['Respond with result']);
  // a failed run: the error workflow releases the claim, then alerts with the event id
  assert.equal(main.settings.errorWorkflow, errors.id, 'the error workflow still fires');
  assert.deepEqual(['Receive error', 'Describe failure', 'Release failed event', 'Compose alert', 'Post Slack automation alert', 'Append error log row'].map((name, i, all) => (i ? next(errors, all[i - 1])[0] === name : true)), Array(6).fill(true));
  assert.match(errors.nodes.find(node => node.name === 'Release failed event').parameters.url, /\/v1\/runs\/\{\{ \$json\.failed_run_id \}\}\/fail$/);
  assert.match(errors.nodes.find(node => node.name === 'Append error log row').parameters.url, /Errors!A:F:append/);
});

test('builder: successful runs keep no lead data in execution history, failed runs stay saved', () => {
  const { settings } = buildAll()['book-new-lead.json'];
  assert.equal(settings.saveDataSuccessExecution, 'none');
  assert.equal(settings.saveDataErrorExecution, 'all');
});

test('builder: the deal is read by its unique event id before any create, and a refused create reads it again', () => {
  const main = buildAll()['book-new-lead.json'];
  const next = (name, output = 0) => main.connections[name].main[output].map(link => link.node);
  assert.deepEqual(next('Prepare HubSpot deal'), ['Find HubSpot deal']);
  assert.deepEqual(next('Find HubSpot deal'), ['Pick HubSpot deal']);
  assert.deepEqual(next('Pick HubSpot deal'), ['Branch on deal match']);
  assert.deepEqual([next('Branch on deal match', 0), next('Branch on deal match', 1)], [['Associate deal with contact'], ['Create HubSpot deal']], 'a match skips the create');
  for (const name of ['Find HubSpot deal', 'Find HubSpot deal after conflict']) {
    assert.equal(main.nodes.find(node => node.name === name).parameters.url, '={{ $env.HUBSPOT_BASE_URL }}/crm/v3/objects/deals/{{ encodeURIComponent($json.event_id) }}', 'GET by value, no search');
  }
  assert.deepEqual([next('Create HubSpot deal', 0), next('Create HubSpot deal', 1)], [['Record HubSpot deal'], ['Record HubSpot deal']], 'both outputs of the create go on');
  assert.deepEqual([next('Branch on deal create', 0), next('Branch on deal create', 1)], [['Find HubSpot deal after conflict'], ['Associate deal with contact']]);
  assert.deepEqual(next('Reuse HubSpot deal after conflict'), ['Associate deal with contact']);
  // The contact: a refused create reads the contact by email and updates it.
  assert.deepEqual([next('Create HubSpot contact', 0), next('Create HubSpot contact', 1)], [['Check HubSpot contact create'], ['Check HubSpot contact create']]);
  assert.deepEqual([next('Branch on contact create', 0), next('Branch on contact create', 1)], [['Find HubSpot contact by email'], ['Route lead after contact']]);
  assert.deepEqual(next('Prepare contact update after conflict'), ['Update HubSpot contact']);
  assert.match(main.nodes.find(node => node.name === 'Find HubSpot contact by email').parameters.url, /\/crm\/v3\/objects\/contacts\/\{\{ encodeURIComponent\(\$json\.lookup_email\) \}\}$/);
  assert.equal(main.nodes.find(node => node.name === 'Branch on approval').parameters.conditions.conditions[0].leftValue, '={{ $json.move_deal_stage }}');
});

// The Gmail draft node has two outputs wired to the same next node. Its real outcome is the item that node receives.
test('Gmail draft: a failed draft is reported as failed, a created one as created, no email as omitted', async () => {
  const main = buildAll()['book-new-lead.json'];
  const prepared = (email = 'dana@mail.example') => ({
    ...sampleCtx(), approval: { required: false, reasons: [] }, event_id: 'evt-a-0001',
    outreach: { email: { to: email, subject: 's', draft_id: null, omitted_reason: email ? null : 'no_email' }, sms: { proposed: false, text: null, omitted_reason: 'no_sms_consent' } },
  });
  const run = (input, nodes) => runCodeNode(main, 'Prepare ClickUp CSR task', { input, nodes: { 'Prepare Gmail draft': prepared(), ...nodes } });
  // Gmail refused: n8n sends an error item on the error output and nothing on output 0, so $('Create Gmail draft') has no item.
  const [failed] = await run({ error: { message: '503 - Service Unavailable', httpCode: '503' } }, {});
  assert.equal(failed.outreach.email.draft_failed, true);
  assert.equal(failed.outreach.email.draft_id, null);
  assert.deepEqual(failed.warnings, ['gmail_draft_failed']);
  assert.match(failed.req.body.description, /Email draft: FAILED, no draft was created/);
  assert.ok(!/created in Gmail/.test(failed.req.body.description), 'the CSR is not told a draft exists');
  assert.match(failed.outreach.email.error, /503/);
  // Gmail answered: the draft is on output 0 and is also the input.
  const draft = { id: 'r1001', message: { id: 'mr1001' } };
  const [created] = await run(draft, { 'Create Gmail draft': draft });
  assert.equal(created.outreach.email.draft_id, 'r1001');
  assert.ok(!created.outreach.email.draft_failed && !(created.warnings || []).length);
  assert.match(created.req.body.description, /Email draft: created in Gmail, not sent/);
  // An answer without an id is a failure too.
  const [empty] = await run({}, {});
  assert.equal(empty.outreach.email.draft_failed, true);
  // No email address: the branch skips Gmail, the input is the context itself, nothing failed.
  const [none] = await runCodeNode(main, 'Prepare ClickUp CSR task', { input: prepared(null), nodes: { 'Prepare Gmail draft': prepared(null) } });
  assert.equal(none.outreach.email.omitted_reason, 'no_email');
  assert.ok(!none.outreach.email.draft_failed && !(none.warnings || []).length);
  assert.match(none.req.body.description, /Email draft: not created \(no_email\)/);
});

test('builder: continueErrorOutput nodes lead on from both outputs', () => {
  const main = buildAll()['book-new-lead.json'];
  for (const node of main.nodes.filter(n => n.onError === 'continueErrorOutput')) {
    const outputs = main.connections[node.name].main;
    assert.equal(outputs.length, 2, `${node.name} wires success and error outputs`);
    assert.deepEqual(outputs[0], outputs[1]);
  }
});

test('builder: rules come from the sheet, not from Code nodes', () => {
  const main = buildAll()['book-new-lead.json'];
  const names = main.nodes.map(node => node.name);
  for (const expected of ['Fetch service area rules', 'Fetch pricing rules', 'Fetch ops settings']) assert.ok(names.includes(expected), expected);
  assert.ok(!names.includes('Fetch approval settings'), 'one settings read, before the Claude step');
  const rules = moduleSource(MODULE_FILES);
  assert.ok(!/CONFIDENCE_THRESHOLD|URGENCY_WINDOW_DAYS/.test(rules), 'no hard-coded threshold or window table in the modules');
  assert.ok(!/emergency: 1, high: 3/.test(rules), 'no hard-coded window table');
  const code = main.nodes.filter(n => n.type === 'n8n-nodes-base.code').map(n => n.parameters.jsCode.slice(n.parameters.jsCode.lastIndexOf('// ----'))).join('\n');
  assert.ok(!code.includes('32207') && !code.includes('1200'), 'no rule tables inlined in glue code');
  const fetches = main.nodes.filter(n => n.name.startsWith('Fetch ')).map(n => n.parameters.url);
  assert.ok(fetches.every(url => url.includes('$env.OPS_RULES_SHEET_ID')));
});

test('builder: canvas node names are verb-first business names', () => {
  const main = buildAll()['book-new-lead.json'];
  const names = main.nodes.map(node => node.name);
  for (const expected of ['Verify signature', 'Qualify lead with Claude', 'Check service area', 'Find FieldRoutes customer', 'Search HubSpot contact', 'Create HubSpot deal', 'Create Gmail draft', 'Create ClickUp CSR task', 'Append speed-to-lead row']) {
    assert.ok(names.includes(expected), `missing node ${expected}`);
  }
});

test('modules: source injected into Code nodes is exactly the tested source', () => {
  const main = buildAll()['book-new-lead.json'];
  const verify = main.nodes.find(node => node.name === 'Verify signature').parameters.jsCode;
  assert.ok(verify.includes(moduleSource(['signature.js'])));
});

// ------------------------------------------------------------------ fixtures

test('fixtures: every scenario is well formed, and the synthetic model replies are labelled synthetic', () => {
  assert.equal(scenarios.length, 21);
  for (const scenario of scenarios) {
    const payload = resolvePayload(scenario);
    assert.ok(scenario.expect.http_status, scenario.id);
    if (scenario.id !== 'invalid_payload' && scenario.id !== 'bad_signature') assert.equal(lib.normalizeLead(payload).valid, true, scenario.id);
    for (const value of JSON.stringify(payload).match(/[\w.+-]+@[\w.-]+/g) ?? []) assert.match(value, /\.example$/, `${scenario.id}: emails must use .example`);
    for (const phone of phonesIn(JSON.stringify(payload).replace(/CAL[0-9a-f]{32}/g, ''))) assert.ok(phone.exchange === '555' && phone.line >= '0100' && phone.line <= '0199', `${scenario.id}: ${phone.typed} is not in 555-0100..0199`);
  }
  const ids = new Set(scenarios.map(s => s.payload?.event_id).filter(Boolean));
  assert.equal(ids.size, scenarios.filter(s => s.payload).length, 'unique event ids');
  for (const file of ['evt-malformed-008', 'evt-pii-echo-015']) {
    const recording = JSON.parse(readFileSync(join(root, 'fixtures/llm', `${file}.json`), 'utf8'));
    assert.equal(recording.synthetic, true, file);
    assert.ok(recording.synthetic_reason.length > 60, `${file} says why it is synthetic`);
  }
  assert.equal(lib.assessQualification(JSON.parse(readFileSync(join(root, 'fixtures/llm/evt-malformed-008.json'), 'utf8')), THRESHOLD).status, 'needs_review');
  for (const check of Object.values(checks)) assert.ok(check.payload?.event_id || check.payload_from);
});

test('fixtures: forbidden strings are written out per fixture, cover every contact detail in the payload, and carry state expectations', () => {
  for (const def of [...scenarios, ...Object.entries(checks).map(([id, check]) => ({ id, ...check }))]) {
    const forbidden = def.expect?.forbidden;
    assert.ok(Array.isArray(forbidden), `${def.id}: forbidden strings are hardcoded in the fixture`);
    const raw = JSON.stringify(resolvePayload(def));
    // independent of normalizeLead: scan the raw payload text
    for (const email of raw.match(/[\w.+-]+@[\w.-]+\.example/g) ?? []) assert.ok(forbidden.includes(email), `${def.id}: ${email} is not in forbidden`);
    for (const phone of phonesIn(raw.replace(/CAL[0-9a-f]{32}/g, ''))) {
      const digits = `${phone.area}${phone.exchange}${phone.line}`;
      if (phone.line === '0100' || phone.line === '0101') continue; // the company's own tracking lines are not customer data
      for (const variant of [digits, `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`, `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`, `+1${digits}`, phone.typed]) {
        assert.ok(forbidden.includes(variant), `${def.id}: ${variant} is not in forbidden`);
      }
    }
    // the street address is customer data too
    const street = resolvePayload(def).fields?.['4.1'] ?? resolvePayload(def).fields?.find?.(f => f.name === 'address')?.value;
    if (street) assert.ok(forbidden.includes(street), `${def.id}: the street address is not in forbidden`);
    assert.ok(def.expect.state && Number.isInteger(def.expect.state.slack_messages) && 'ledger' in def.expect.state, `${def.id}: state expectations`);
  }
});

const allStrings = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => allStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => allStrings(item, out));
  return out;
};
const FICTION_FILES = ['scenarios.json', 'day/leads.json', 'ops-rules.json', 'fieldroutes/customers.json', 'fieldroutes/schedule.json', 'hubspot/contacts.json', 'hubspot/deals.json', 'hubspot/pipeline.json', 'clickup/csr-queue.json'];

test('fixtures: the demo data is fictional by construction (.example emails, 555-0100 to 555-0199 phones, real ZIPs only)', () => {
  const zips = new Set(SERVICE_AREA.branches.flatMap(branch => branch.zips));
  const outOfArea = new Set(['32301', '30303', '36104', '33602']);
  for (const file of FICTION_FILES) {
    for (const text of allStrings(fixture(file))) {
      if (/^(CAL[0-9a-f]{32}|[0-9a-f]{24,})$/.test(text)) continue; // call ids and tracking cookies
      for (const email of text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) assert.match(email, /\.example$/, `${file}: ${email}`);
      for (const phone of phonesIn(text)) assert.ok(phone.exchange === '555' && phone.line >= '0100' && phone.line <= '0199', `${file}: ${phone.typed} is not in the range reserved for fiction`);
    }
  }
  // every ZIP a lead or customer carries is a branch ZIP or one of the four named out-of-area ZIPs
  const seen = new Set();
  for (const lead of DAY.leads) {
    const payload = lead.payload;
    const zip = payload.fields?.['4.5'] ?? payload.fields?.find?.(f => f.name === 'zip')?.value ?? lib.zipFromSpeech(payload.transcription);
    assert.ok(zips.has(zip) || outOfArea.has(zip), `${payload.event_id}: ZIP ${zip}`);
    seen.add(zip);
  }
  for (const customer of fixture('fieldroutes/customers.json').customers) assert.ok(zips.has(customer.zip), `customer ${customer.customerID}: ZIP ${customer.zip}`);
  assert.ok(seen.size >= 25, 'the day uses many different ZIP codes');
});

test('fixtures: the ops rules carry the real service area, and every price says what it is based on', () => {
  const area = Object.fromEntries(SERVICE_AREA.branches.map(branch => [branch.id, branch.zips]));
  assert.deepEqual([area.jacksonville.length, area.savannah.length, area.mobile.length], [15, 11, 11]);
  for (const zip of ['32207', '32003', '31328', '31322', '36695', '36532']) assert.ok(Object.values(area).flat().includes(zip), zip);
  for (const zip of ['32301', '30303', '36104', '33602']) assert.equal(lib.findBranch(SERVICE_AREA, zip), null, `${zip} is out of area`);
  const BASIS = 'illustrative — pending sourced research';
  const list = OPS_RULES.tabs['Price list'];
  assert.ok(list.rows.length >= 20);
  for (const row of list.rows) {
    assert.equal(row[row.length - 1], BASIS, `${row[0]} carries its basis`);
    assert.ok(Number.isFinite(row[3]) && Number.isFinite(row[4]) && row[3] <= row[4], row[0]);
  }
  assert.equal(list.basis, BASIS);
  assert.equal(OPS_RULES.tabs.Pricing.basis, BASIS);
  const services = list.rows.map(row => row[0]).join(' | ');
  for (const needed of [/General pest, initial/, /quarterly/, /Fire ants/, /Roaches/, /Termite inspection/, /WDO/, /liquid/, /bait/, /Rodent trapping/, /exclusion/, /Mosquito/, /Bed bugs, chemical/, /heat/, /Wildlife/, /Stinging/, /Restaurant/]) {
    assert.match(services, needed);
  }
  assert.ok(list.rows.some(row => row[1] === 'commercial') && list.rows.some(row => row[1] === 'residential'));
});

test('fixtures: the FieldRoutes seed has 25 customers, 2 or 3 technicians per branch and the existing customer the scenario needs', () => {
  const { customers } = fixture('fieldroutes/customers.json');
  const schedule = fixture('fieldroutes/schedule.json');
  assert.equal(customers.length, 25);
  assert.equal(new Set(customers.map(c => c.customerID)).size, 25);
  assert.equal(new Set(customers.map(c => c.phone1)).size, 25, 'no two customers share a phone');
  for (const office of ['1', '2', '3']) {
    const techs = schedule.technicians.filter(tech => tech.officeID === office);
    assert.ok(techs.length >= 2 && techs.length <= 3, `office ${office} has ${techs.length} technicians`);
    assert.ok(customers.filter(c => c.officeID === office).length >= 7);
  }
  assert.equal(customers.filter(c => c.customerType === 'commercial').length, 1);
  assert.ok(customers.filter(c => /Termite Bond/.test(c.planName ?? '')).length >= 3);
  assert.ok(customers.filter(c => /Quarterly General Pest/.test(c.planName ?? '')).length >= 10);
  assert.equal(customers.filter(c => c.status === '0').length, 3, 'three cancelled accounts');
  for (const customer of customers.filter(c => c.status === '1')) {
    assert.ok(schedule.booked.some(item => item.customerID === customer.customerID), `${customer.customerID} has a booked next visit`);
  }
  assert.deepEqual(schedule.windows.weekday.map(window => window[0]), ['08:00:00', '10:00:00', '13:00:00', '15:00:00']);
  assert.deepEqual(schedule.windows.saturday.map(window => window[0]), ['08:00:00', '10:00:00']);
  assert.ok(schedule.windows.weekday.every(([start, end]) => (Date.parse(`1970-01-01T${end}Z`) - Date.parse(`1970-01-01T${start}Z`)) === 2 * 3600000), 'two-hour arrival windows');
  assert.ok(schedule.emergency_rule.reserved_window_start);
  const existing = lib.normalizeLead(scenarios.find(s => s.id === 'existing_customer_al').payload).lead;
  const match = customers.filter(c => c.status === '1' && `+1${c.phone1}` === existing.phone);
  assert.deepEqual(match.map(c => [c.customerID, c.officeID]), [['53002', '3']], 'existing_customer_al matches exactly one active customer, in Mobile');
});

test('fixtures: the HubSpot seed has a nine-stage pipeline, 15 contacts that overlap FieldRoutes, and a duplicate', () => {
  const pipeline = fixture('hubspot/pipeline.json');
  const { contacts } = fixture('hubspot/contacts.json');
  const { deals } = fixture('hubspot/deals.json');
  assert.deepEqual(pipeline.stages.map(stage => stage.label), ['New lead', 'Contacted', 'Inspection scheduled', 'Needs approval', 'Approved', 'On hold', 'Quote sent', 'Won', 'Lost']);
  assert.equal(SETTINGS.hubspot.pipeline_id, pipeline.id, 'the sheet names the seeded pipeline');
  for (const id of Object.values(SETTINGS.hubspot.stages)) assert.ok(pipeline.stages.some(stage => stage.id === id), `the stage ${id} the workflows write exists`);
  assert.equal(contacts.length, 15);
  const customers = fixture('fieldroutes/customers.json').customers;
  const overlap = contacts.filter(contact => customers.some(c => c.email === contact.properties.email));
  assert.ok(overlap.length >= 8, `${overlap.length} contacts are also FieldRoutes customers`);
  const byDigits = {};
  for (const contact of contacts) (byDigits[contact.properties.phone.replace(/\D/g, '').slice(-10)] ??= []).push(contact);
  const duplicates = Object.values(byDigits).filter(group => group.length > 1);
  assert.equal(duplicates.length, 1, 'one person entered twice');
  assert.notEqual(duplicates[0][0].properties.phone, duplicates[0][1].properties.phone, 'in two phone formats');
  assert.equal(new Set(contacts.map(contact => contact.id)).size, 15);
  assert.ok(deals.length >= 14);
  const stageIds = new Set(pipeline.stages.map(stage => stage.id));
  for (const deal of deals) {
    assert.ok(stageIds.has(deal.properties.dealstage), deal.id);
    assert.ok(contacts.some(contact => contact.id === deal.associations.contacts.results[0].id), `${deal.id} points at a seeded contact`);
  }
  assert.equal(new Set(deals.map(deal => deal.properties.dealstage)).size, 7, 'every stage has a deal');
  const queue = fixture('clickup/csr-queue.json');
  assert.equal(queue.list.name, 'CSR Queue');
  assert.deepEqual(queue.fields.map(field => field.name), ['Branch', 'Pest', 'Urgency', 'HubSpot deal link', 'Callback by']);
});

test('fixtures: the simulated day is 40 deliveries on Tuesday 13 October 2026 in each branch\'s own time zone', () => {
  const zoneOf = new Map(SERVICE_AREA.branches.flatMap(branch => branch.zips.map(zip => [zip, branch.timezone])));
  const branchOf = new Map(SERVICE_AREA.branches.flatMap(branch => branch.zips.map(zip => [zip, branch.id])));
  assert.equal(DAY.leads.length, 40);
  assert.deepEqual(DAY.leads.map(lead => lead.seq), Array.from({ length: 40 }, (_, i) => i + 1));
  const times = DAY.leads.map(lead => Date.parse(lead.received_at));
  assert.deepEqual([...times].sort((a, b) => a - b), times, 'in arrival order');
  const ids = DAY.leads.map(lead => lead.payload.event_id);
  assert.equal(new Set(ids).size, 39, '39 distinct events plus one redelivery');
  assert.equal(DAY.leads.filter(lead => lead.redelivery).length, 1);
  const counts = { jacksonville: 0, savannah: 0, mobile: 0, none: 0 };
  const sources = {};
  for (const lead of DAY.leads) {
    const payload = lead.payload;
    const normalized = lib.normalizeLead(payload);
    assert.equal(normalized.valid, true, payload.event_id);
    const zip = normalized.lead.zip;
    counts[branchOf.get(zip) ?? 'none']++;
    sources[payload.source] = (sources[payload.source] ?? 0) + 1;
    const zone = zoneOf.get(zip) ?? 'America/Chicago';
    const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(lead.received_at));
    assert.equal(localDay, '2026-10-13', `${payload.event_id} arrives on Tuesday in its own zone`);
    const offset = lead.received_at.slice(-6);
    assert.equal(offset, zone === 'America/Chicago' ? '-05:00' : '-04:00', `${payload.event_id}: ${lead.received_at} is written in the branch zone`);
    assert.ok(normalized.lead.source_received_at <= new Date(lead.received_at).toISOString(), 'the lead is submitted before it is forwarded');
  }
  assert.deepEqual(counts, { jacksonville: 18, savannah: 11, mobile: 10, none: 1 });
  assert.ok(sources.web_form > sources.call_tracking && sources.call_tracking > sources.hubspot_form && sources.hubspot_form >= 5, JSON.stringify(sources));
  // the edge cases the brief asks for are all present
  const notes = DAY.leads.map(lead => lead.note).join(' | ');
  for (const needle of [/existing customer/, /out of area/, /vague/, /sent twice/, /after-hours emergency/, /restaurant/, /HOA/, /property manager/, /realtor/, /wildlife|squirrels|raccoon/, /bed bugs/]) assert.match(notes, needle);
  const text = DAY.leads.map(lead => lead.payload.transcription ?? lead.payload.fields?.['5'] ?? lead.payload.fields?.find?.(f => f.name === 'message')?.value).join(' ').toLowerCase();
  for (const pest of ['ant', 'roach', 'rat', 'mouse', 'termite', 'mosquito', 'squirrel', 'raccoon', 'bed bug', 'hornet', 'yellow jacket', 'spider']) assert.ok(text.includes(pest), pest);
});

test('fixtures: every recording matches the exact request the workflow sends, synthetic ones are labelled', () => {
  for (const scenario of [...scenarios, ...Object.values(checks)].filter(s => ['record', 'synthetic', 'reuse'].includes(s.llm))) {
    const payload = resolvePayload(scenario);
    const recording = JSON.parse(readFileSync(join(root, 'fixtures/llm', `${payload.event_id}.json`), 'utf8'));
    if (recording.synthetic) { assert.ok(recording.synthetic_reason, `${payload.event_id}: synthetic recordings say why`); continue; }
    const lead = lib.normalizeLead(payload).lead;
    assert.deepEqual(recording.recorded_request, lib.buildQualificationRequest(lead), `${payload.event_id}: re-run scripts/record-llm.mjs`);
    assert.ok(recording.recorded_at && recording.via === 'claude-code-cli-bridge');
  }
});

test('fixtures: every distinct lead of the simulated day has a real recording that matches the request the workflow sends', () => {
  const payloads = new Map(DAY.leads.map(lead => [lead.payload.event_id, lead.payload]));
  assert.equal(payloads.size, 39);
  const redelivered = DAY.leads.filter(lead => lead.redelivery).map(lead => lead.payload.event_id);
  assert.equal(DAY.leads.filter(lead => lead.payload.event_id === redelivered[0]).length, 2, 'the redelivery repeats the same event id and bytes');
  assert.deepEqual(DAY.leads.filter(lead => lead.payload.event_id === redelivered[0]).map(lead => JSON.stringify(lead.payload)).filter((text, i, all) => text === all[0]).length, 2);
  for (const [eventId, payload] of payloads) {
    const recording = JSON.parse(readFileSync(join(root, 'fixtures/llm', `${eventId}.json`), 'utf8'));
    assert.ok(!recording.synthetic, `${eventId}: a real recording`);
    assert.equal(recording.via, 'claude-code-cli-bridge');
    assert.deepEqual(recording.recorded_request, lib.buildQualificationRequest(lib.normalizeLead(payload).lead), `${eventId}: re-run scripts/record-llm.mjs`);
    const assessed = lib.assessQualification(recording, THRESHOLD);
    assert.ok(['ok', 'needs_review'].includes(assessed.status), `${eventId}: ${assessed.reason}`);
  }
});

test('fixtures: the synthetic PII reply really echoes contact details, and redaction removes them', () => {
  const recording = JSON.parse(readFileSync(join(root, 'fixtures/llm/evt-pii-echo-015.json'), 'utf8'));
  const raw = recording.content[0].text;
  assert.ok(/555-0188/.test(raw) && /jo\.rivera@mail\.example/.test(raw) && /9045550188/.test(raw), 'the reply echoes phone and email');
  const result = lib.assessQualification(recording, THRESHOLD);
  assert.equal(result.status, 'ok');
  assert.ok(!/555|@|jo\.rivera/.test(JSON.stringify(result.qualification)), JSON.stringify(result.qualification));
});

// ------------------------------------------------------------------ mock server

const authHeaders = { authorization: 'Bearer t', 'content-type': 'application/json' };

test('mock: fault injection, request log and no side effects when a fault is injected', async () => {
  const mock = await startMock({ seed: false });
  try {
    const call = (path, body, headers = {}) => fetch(`${mock.url}${path}`, { method: 'POST', headers: { ...authHeaders, ...headers }, body: JSON.stringify(body) });
    await fetch(`${mock.url}/__control`, { method: 'POST', body: JSON.stringify({ faults: [{ op: 'hubspot.search_contacts', status: 429, times: 2 }, { op: 'hubspot.create_contact', status: 503, times: 1 }] }) });
    const search = { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: 'x@y.example' }] }] };
    assert.deepEqual([(await call('/hubspot/crm/v3/objects/contacts/search', search)).status, (await call('/hubspot/crm/v3/objects/contacts/search', search)).status, (await call('/hubspot/crm/v3/objects/contacts/search', search)).status], [429, 429, 200]);
    assert.equal((await call('/hubspot/crm/v3/objects/contacts', { properties: { email: 'x@y.example' } }, { 'idempotency-key': '1:Create' })).status, 503);
    const afterFault = await (await call('/hubspot/crm/v3/objects/contacts/search', search)).json();
    assert.equal(afterFault.total, 0, 'a 503 on create must not store the contact');
    assert.equal((await call('/hubspot/crm/v3/objects/contacts', { properties: { email: 'x@y.example' } }, { 'idempotency-key': '1:Create' })).status, 201);
    assert.equal((await (await call('/hubspot/crm/v3/objects/contacts/search', search)).json()).total, 1);
    assert.equal((await fetch(`${mock.url}/hubspot/crm/v3/objects/contacts/search`, { method: 'POST', body: '{}' })).status, 401, 'auth required');
    const log = await (await fetch(`${mock.url}/__log`)).json();
    assert.deepEqual(log.filter(e => e.op === 'hubspot.search_contacts').map(e => e.status).slice(0, 3), [429, 429, 200]);
    assert.ok(log.every(entry => !JSON.stringify(entry).includes('Bearer')), 'tokens are not logged');
    await fetch(`${mock.url}/__reset`, { method: 'POST' });
    assert.equal((await (await fetch(`${mock.url}/__log`)).json()).length, 0);
  } finally {
    await mock.close();
  }
});

test('mock: an Idempotency-Key replays the original answer instead of creating a second record', async () => {
  const mock = await startMock({ seed: false });
  try {
    const create = key => fetch(`${mock.url}/clickup/api/v2/list/1/task`, { method: 'POST', headers: { authorization: 't', 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify({ name: 'Book: x', tags: ['lead'] }) });
    const first = await (await create('7:Create ClickUp CSR task')).json();
    const again = await (await create('7:Create ClickUp CSR task')).json();
    const other = await (await create('7:Create ClickUp callback task')).json();
    assert.equal(first.id, again.id, 'same key, same task');
    assert.notEqual(first.id, other.id, 'a different node name is a different key');
    assert.equal((await (await fetch(`${mock.url}/__state`)).json()).tasks.length, 2);
    const log = await (await fetch(`${mock.url}/__log`)).json();
    assert.deepEqual(log.map(e => [e.idempotent_replay ?? false, e.fault]), [[false, null], [true, null], [false, null]]);
    await create(null);
    assert.equal((await (await fetch(`${mock.url}/__log`)).json()).at(-1).fault, 'missing_idempotency_key', 'writes without a key are flagged');
  } finally {
    await mock.close();
  }
});

test('mock: a fault after commit stores the change, answers late, and the retry is a replay', async () => {
  const mock = await startMock({ seed: false });
  try {
    await fetch(`${mock.url}/__control`, { method: 'POST', body: JSON.stringify({ faults: [{ op: 'clickup.create_task', status: 200, times: 1, after_commit: true, delay_ms: 300 }] }) });
    const create = () => fetch(`${mock.url}/clickup/api/v2/list/1/task`, { method: 'POST', headers: { authorization: 't', 'idempotency-key': '9:Create ClickUp CSR task' }, body: JSON.stringify({ name: 'x' }) });
    const started = Date.now();
    const late = await (await create()).json();
    assert.ok(Date.now() - started >= 280, 'the first answer is delayed');
    const retry = await (await create()).json();
    assert.equal(late.id, retry.id);
    assert.equal((await (await fetch(`${mock.url}/__state`)).json()).tasks.length, 1);
    const log = await (await fetch(`${mock.url}/__log`)).json();
    assert.deepEqual(log.map(e => e.fault), ['injected_after_commit', null]);
  } finally {
    await mock.close();
  }
});

test('mock: the ops rules sheet is served by values.get, and the log sheet is append-only', async () => {
  const mock = await startMock({ seed: false });
  try {
    const get = range => fetch(`${mock.url}/sheets/v4/spreadsheets/ridgeway-ops-rules/values/${encodeURIComponent(range)}`, { headers: { authorization: 't' } });
    const area = await (await get('Service area!A2:F')).json();
    assert.equal(area.values.length, 3);
    assert.equal(area.values[2][1], 'Mobile');
    assert.equal((await get('Nope!A2:B')).status, 404);
    assert.equal((await fetch(`${mock.url}/sheets/v4/spreadsheets/other/values/Pricing!A2:D`, { headers: { authorization: 't' } })).status, 404);
    assert.equal((await fetch(`${mock.url}/sheets/v4/spreadsheets/ridgeway-ops-rules/values/Pricing!A2:D`)).status, 401);
  } finally {
    await mock.close();
  }
});

test('mock: serves recordings by event id and fails loudly when one is missing, stale or invalid', async () => {
  const mock = await startMock({ seed: false });
  try {
    const post = body => fetch(`${mock.url}/anthropic/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const lead = lib.normalizeLead(scenarios.find(s => s.id === 'malformed_llm').payload).lead;
    const request = lib.buildQualificationRequest(lead);
    const ok = await post(request);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.type, 'message');
    assert.ok(!('synthetic' in body) && !('recorded_at' in body) && !('synthetic_reason' in body));
    const missing = await post({ ...request, metadata: { user_id: 'evt-does-not-exist' } });
    assert.equal(missing.status, 500);
    assert.match((await missing.json()).error.message, /no recorded Claude response/);
    const sampling = await post({ ...request, temperature: 0 });
    assert.equal(sampling.status, 400, 'sampling parameters are rejected like the real API does for this model');
    const noKey = await fetch(`${mock.url}/anthropic/v1/messages`, { method: 'POST', body: JSON.stringify(request) });
    assert.equal(noKey.status, 401);
    const log = await (await fetch(`${mock.url}/__log`)).json();
    assert.deepEqual(log.map(e => e.fault), [null, 'missing_recording', 'invalid_request', 'rejected']);
  } finally {
    await mock.close();
  }
});

test('mock: FieldRoutes spots follow route days, the booked list and the emergency rule, and are the same on every call', async () => {
  const mock = await startMock();
  try {
    const headers = { authenticationKey: 'k', authenticationToken: 't' };
    const schedule = fixture('fieldroutes/schedule.json');
    const search = async (office, from, to) => (await (await fetch(`${mock.url}/fieldroutes/spot/search?officeIDs=${encodeURIComponent(`[${office}]`)}&dateStart=${from}&dateEnd=${to}`, { headers })).json()).spots;
    const spots = await search(3, '2026-10-09', '2026-10-24');
    assert.ok(spots.length > 20, 'a busy fall season still leaves plenty of windows');
    assert.ok(spots.every(spot => spot.officeID === '3'));
    const weekday = date => new Date(`${date}T00:00:00Z`).getUTCDay();
    assert.ok(spots.every(spot => weekday(spot.date) !== 0), 'Sundays are closed');
    const saturdays = spots.filter(spot => weekday(spot.date) === 6);
    assert.ok(saturdays.length > 0 && saturdays.every(spot => spot.start < '12:00:00'), 'Saturday offices close at noon');
    const techs = Object.fromEntries(schedule.technicians.map(tech => [tech.routeID, tech]));
    for (const spot of spots) {
      assert.ok(techs[spot.routeID].route_days.includes(weekday(spot.date)), `${spot.spotID} is on the technician's route day`);
      assert.equal(spot.duration, '120');
    }
    assert.deepEqual(spots, await search(3, '2026-10-09', '2026-10-24'), 'the same query always answers the same');
    // an existing customer's next visit takes its window
    const booked = schedule.booked.find(item => item.technician === 'T-MOB-01');
    const day = await search(3, booked.date, booked.date);
    assert.ok(!day.some(spot => spot.routeID === 'R-MOB-1' && spot.start === booked.start), `booked window ${booked.date} ${booked.start} is not offered`);
    // the 3 PM window of a route is never pre-booked: it is open on every route day unless a customer's visit holds it
    const afternoon = spots.filter(spot => spot.start === schedule.emergency_rule.reserved_window_start);
    const expected = [...new Set(spots.map(spot => spot.date))].filter(date => weekday(date) !== 6).length;
    assert.ok(new Set(afternoon.map(spot => spot.date)).size >= expected - 1, 'emergency capacity exists on every weekday');
    const customers = await (await fetch(`${mock.url}/fieldroutes/customer/search?phone=2515550179&includeData=1`, { headers })).json();
    assert.deepEqual([customers.count, customers.customers[0].customerID], [1, '53002']);
    assert.equal((await fetch(`${mock.url}/fieldroutes/spot/search?officeIDs=%5B1%5D`)).status, 401);
  } finally {
    await mock.close();
  }
});

test('mock: the seeded CRM, CSR list and pipeline are served, and a reset brings the seed back', async () => {
  const mock = await startMock();
  try {
    const get = async (path, headers = {}) => (await fetch(`${mock.url}${path}`, { headers: { authorization: 'Bearer t', ...headers } })).json();
    const state = await get('/__state');
    assert.deepEqual(state.seeded, { contacts: 15, deals: 15, tasks: 5 });
    assert.equal(state.contacts.length, 15);
    const pipeline = (await get('/hubspot/crm/v3/pipelines/deals')).results[0];
    assert.deepEqual(pipeline.stages.map(stage => stage.label), ['New lead', 'Contacted', 'Inspection scheduled', 'Needs approval', 'Approved', 'On hold', 'Quote sent', 'Won', 'Lost']);
    const stageIds = new Set(pipeline.stages.map(stage => stage.id));
    assert.ok(state.deals.every(deal => stageIds.has(deal.properties.dealstage) && deal.properties.pipeline === pipeline.id), 'every seeded deal sits in a real stage');
    assert.ok(new Set(state.deals.map(deal => deal.properties.dealstage)).size === 7, 'the seed fills every stage');
    const list = await get('/clickup/api/v2/list/901100123');
    assert.equal(list.name, 'CSR Queue');
    const fields = (await get('/clickup/api/v2/list/901100123/field')).fields.map(field => field.name);
    assert.deepEqual(fields, ['Branch', 'Pest', 'Urgency', 'HubSpot deal link', 'Callback by']);
    // the duplicate-ish contact: the same phone stored in two formats, found only by the exact one
    const search = value => fetch(`${mock.url}/hubspot/crm/v3/objects/contacts/search`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value }] }] }) }).then(res => res.json());
    const toya = state.contacts.filter(contact => contact.properties.lastname.endsWith('Simmons'));
    assert.equal(toya.length, 2);
    assert.equal((await search(toya[0].properties.phone)).total, 1);
    assert.equal((await search(toya[1].properties.phone)).total, 1);
    assert.notEqual(toya[0].properties.phone, toya[1].properties.phone, 'two formats of one number');
    await fetch(`${mock.url}/hubspot/crm/v3/objects/contacts`, { method: 'POST', headers: { authorization: 'Bearer t', 'idempotency-key': 'e:Create' }, body: JSON.stringify({ properties: { email: 'x@y.example' } }) });
    assert.equal((await get('/__state')).contacts.length, 16);
    await fetch(`${mock.url}/__reset`, { method: 'POST' });
    assert.equal((await get('/__state')).contacts.length, 15, 'a reset restores the seed');
    // an unseeded mock starts empty
    const empty = await startMock({ seed: false });
    assert.deepEqual((await (await fetch(`${empty.url}/__state`)).json()).seeded, { contacts: 0, deals: 0, tasks: 0 });
    await empty.close();
  } finally {
    await mock.close();
  }
});

test('mock: the simulated time stamps new records, and an association links the deal to the contact', async () => {
  const mock = await startMock({ seed: false });
  try {
    await fetch(`${mock.url}/__control`, { method: 'POST', body: JSON.stringify({ sim_time: '2026-10-13T12:00:00Z' }) });
    const post = (path, body, key) => fetch(`${mock.url}${path}`, { method: path.includes('associations') ? 'PUT' : 'POST', headers: { authorization: 'Bearer t', 'idempotency-key': key }, body: JSON.stringify(body) }).then(res => res.json());
    const contact = await post('/hubspot/crm/v3/objects/contacts', { properties: { email: 'a@b.example' } }, 'e:c');
    const deal = await post('/hubspot/crm/v3/objects/deals', { properties: { dealname: 'x' } }, 'e:d');
    await fetch(`${mock.url}/hubspot/crm/v4/objects/deals/${deal.id}/associations/default/contacts/${contact.id}`, { method: 'PUT', headers: { authorization: 'Bearer t', 'idempotency-key': 'e:a' } });
    const slack = await post('/slack/api/chat.postMessage', { channel: '#leads', text: 'hi', blocks: [{ type: 'section' }] }, 'e:s');
    const state = await (await fetch(`${mock.url}/__state`)).json();
    assert.equal(state.contacts[0].createdAt, '2026-10-13T12:00:00.000Z');
    assert.equal(state.deals[0].properties.createdate, '2026-10-13T12:00:00.000Z');
    assert.deepEqual(state.deals[0].associations.contacts.results, [{ id: contact.id, type: 'deal_to_contact' }]);
    assert.ok(slack.ts.startsWith('1791892800.'), 'Slack timestamps follow the simulated clock');
    assert.deepEqual(state.slack_messages[0].blocks, [{ type: 'section' }], 'Slack blocks are kept so the posts can be replayed to a real workspace');
  } finally {
    await mock.close();
  }
});

test('mock: HubSpot deals are searchable by ridgeway_event_id', async () => {
  const mock = await startMock({ seed: false });
  try {
    const post = (path, body, key) => fetch(`${mock.url}/hubspot/crm/v3/objects/${path}`, { method: 'POST', headers: { authorization: 'Bearer t', 'idempotency-key': key ?? '', 'x-run-id': '1' }, body: JSON.stringify(body) }).then(res => res.json());
    const search = id => post('deals/search', { filterGroups: [{ filters: [{ propertyName: 'ridgeway_event_id', operator: 'EQ', value: id }] }] });
    assert.equal((await search('evt-a-0001')).total, 0);
    const deal = await post('deals', { properties: { dealname: 'x', ridgeway_event_id: 'evt-a-0001' } }, 'evt-a-0001:Create HubSpot deal');
    assert.deepEqual((await search('evt-a-0001')).results.map(item => item.id), [deal.id]);
    assert.equal((await search('evt-b-0001')).total, 0);
  } finally {
    await mock.close();
  }
});

test('mock: a reused Idempotency-Key with a different body is refused, and the log carries the evidence the runner needs', async () => {
  const mock = await startMock({ seed: false });
  try {
    const create = (body, run) => fetch(`${mock.url}/clickup/api/v2/list/1/task`, { method: 'POST', headers: { authorization: 't', 'idempotency-key': 'evt-a-0001:Create ClickUp CSR task', 'x-run-id': run }, body: JSON.stringify(body) });
    assert.equal((await create({ name: 'a' }, '5')).status, 200);
    assert.equal((await create({ name: 'a' }, '6')).status, 200, 'same bytes, another run: replayed');
    assert.equal((await create({ name: 'b' }, '6')).status, 422, 'same key, other bytes: refused, never silently replayed');
    assert.equal((await (await fetch(`${mock.url}/__state`)).json()).tasks.length, 1);
    const log = await (await fetch(`${mock.url}/__log`)).json();
    assert.deepEqual(log.map(entry => [entry.run_id, entry.idempotent_replay ?? false, entry.fault]), [['5', false, null], ['6', true, null], ['6', false, 'idempotency_key_body_mismatch']]);
    assert.equal(log[0].raw_sha256, log[1].raw_sha256);
    assert.notEqual(log[0].raw_sha256, log[2].raw_sha256);
  } finally {
    await mock.close();
  }
});

test('mock: operations marked as ignoring Idempotency-Key behave like HubSpot (a repeat creates a second record)', async () => {
  const mock = await startMock({ seed: false });
  try {
    await fetch(`${mock.url}/__control`, { method: 'POST', body: JSON.stringify({ ignore_idempotency: ['hubspot.create_deal'] }) });
    const create = () => fetch(`${mock.url}/hubspot/crm/v3/objects/deals`, { method: 'POST', headers: { authorization: 'Bearer t', 'idempotency-key': 'evt-a-0001:Create HubSpot deal' }, body: JSON.stringify({ properties: { ridgeway_event_id: 'evt-a-0001' } }) });
    await create();
    await create();
    assert.equal((await (await fetch(`${mock.url}/__state`)).json()).deals.length, 2);
    await fetch(`${mock.url}/__reset`, { method: 'POST' });
    await create();
    await create();
    assert.equal((await (await fetch(`${mock.url}/__state`)).json()).deals.length, 1, 'a reset clears the setting: the key is honored again');
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------------------------ the key-reuse assertions (non-vacuous)

const entry = (key, body, extra = {}) => ({ op: 'clickup.create_task', idempotency_key: key, raw_sha256: body, run_id: '5', fault: null, idempotent_replay: false, ...extra });

test('key reuse: a legitimate retry passes; a changed body, an unexplained reuse and a surprise redelivery fail', () => {
  const key = 'evt-a-0001:Create ClickUp CSR task';
  // first use lost its answer after the commit, the retry carries identical bytes
  assertKeyReuse('retry', [entry(key, 'h1', { fault: 'injected_after_commit' }), entry(key, 'h1', { idempotent_replay: true })]);
  // an injected error before the commit is a reason too
  assertKeyReuse('retry503', [entry(key, 'h1', { fault: 'injected_503' }), entry(key, 'h1')]);
  assert.throws(() => assertKeyReuse('body', [entry(key, 'h1', { fault: 'injected_after_commit' }), entry(key, 'h2', { idempotent_replay: true })]), /different request body/);
  assert.throws(() => assertKeyReuse('why', [entry(key, 'h1'), entry(key, 'h1', { idempotent_replay: true })]), /no injected fault/);
  assert.throws(() => assertKeyReuse('surprise', [entry(key, 'h1'), entry(key, 'h1', { run_id: '6', idempotent_replay: true })]), /different run/);
  assertKeyReuse('redelivery', [entry(key, 'h1'), entry(key, 'h1', { run_id: '6', idempotent_replay: true })], { allowCrossRun: true });
  assert.throws(() => assertKeyReuse('redelivery body', [entry(key, 'h1'), entry(key, 'h2', { run_id: '6' })], { allowCrossRun: true }), /different request body/, 'a redelivery must not change the body either');
});

test('key reuse: the previous check (the mock\'s own replay flag) would have passed every bad log above', () => {
  const legacy = log => {
    const first = new Map();
    for (const item of log) {
      if (first.has(item.idempotency_key)) assert.ok(item.idempotent_replay);
      else first.set(item.idempotency_key, item);
    }
  };
  const key = 'k:Create ClickUp CSR task';
  legacy([entry(key, 'h1'), entry(key, 'h2', { idempotent_replay: true })]);
  assert.throws(() => assertKeyReuse('x', [entry(key, 'h1'), entry(key, 'h2', { idempotent_replay: true })]));
});

test('key headers: writes carry <event id>:<node name> and a run id, ledger calls a run id only, reads nothing', () => {
  const write = { op: 'slack.post_message', idempotency_key: 'evt-a-0001:Post Slack leads summary', run_id: '12' };
  const ledger = { op: 'ledger.claim', idempotency_key: null, run_id: '12' };
  const read = { op: 'hubspot.search_deals', idempotency_key: null, run_id: null };
  assertWriteHeaders('ok', [write, ledger, read], ['evt-a-0001']);
  assert.throws(() => assertWriteHeaders('old scheme', [{ ...write, idempotency_key: '12:Post Slack leads summary' }], ['evt-a-0001']), /<event id>:<node name>/);
  assert.throws(() => assertWriteHeaders('no run id', [{ ...write, run_id: null }], ['evt-a-0001']), /X-Run-Id/);
  assert.throws(() => assertWriteHeaders('ledger key', [{ ...ledger, idempotency_key: 'x:Claim event' }], ['evt-a-0001']), /dedupe authority/);
  assert.throws(() => assertWriteHeaders('read key', [{ ...read, idempotency_key: 'x' }], ['evt-a-0001']), /reads do not need a key/);
});

// ------------------------------------------------------------------ WDO pricing, ClickUp custom fields, ledger refs

test('routing: a termite letter request is priced on the wdo_letter row and needs no approval; a termite job still does', () => {
  const termites = { ...goodOutput, pest_type: 'termites', service_interest: 'inspection' };
  const wdo = "Closing on a house on 10/30 and the buyer's agent needs a termite letter (WDO).";
  assert.equal(lib.pricedService(termites, wdo, SETTINGS), 'wdo_letter');
  assert.equal(lib.pricedService({ ...termites, pest_type: 'other' }, 'Need a WDO inspection (the FL 13645 form) for a closing.', SETTINGS), 'wdo_letter', 'whatever pest the model named');
  assert.equal(lib.pricedService(termites, 'Mud tubes on the foundation, can you inspect?', SETTINGS), 'termites');
  assert.equal(lib.pricedService(termites, 'Got the termite bond renewal letter in the mail', SETTINGS), 'termites', '"termite bond renewal letter" is not a termite letter');
  assert.equal(lib.pricedService(termites, 'wdo123 is my username', SETTINGS), 'termites', 'whole words only');
  assert.equal(lib.pricedService({ ...termites, service_interest: 'one_time' }, wdo, SETTINGS), 'termites', 'only an inspection request is a letter');
  const value = lib.estimateDealValue(PRICING, SETTINGS, termites, 'wdo_letter');
  assert.equal(value, 125);
  assert.deepEqual(lib.decideApproval(termites, value, SETTINGS, 'wdo_letter'), { required: false, reasons: [] });
  assert.deepEqual(lib.decideApproval(termites, 1200, SETTINGS), { required: true, reasons: ['pest_type:termites', 'estimated_value>=800'] });
  assert.throws(() => lib.estimateDealValue(PRICING, SETTINGS, termites, 'gold_plating'), /no row for gold_plating/);
  const deal = lib.hubspotDealBody({ ...sampleCtx(), qualification: termites, service: 'wdo_letter', branch: { name: 'Savannah' }, estimated_value: 125 });
  assert.match(deal.properties.dealname, / - WDO letter \(Savannah\)$/);
  assert.match(lib.csrTaskDescription({ ...sampleCtx(), qualification: termites, service: 'wdo_letter', estimated_value: 125 }), /Estimated value: \$125 \(priced as wdo letter\)/);
});

test('requests: ClickUp custom fields carry option ids, the deal link and a callback deadline, never contact details', () => {
  const ctx = sampleCtx({ settings: SETTINGS, now_ms: NOW, qualification: { ...goodOutput, pest_type: 'bed_bugs' } });
  const fields = lib.clickupCustomFields(ctx, 'high');
  assert.deepEqual(fields, [
    { id: 'cf-branch-7a1', value: 'b2' }, { id: 'cf-pest-7a2', value: 'p6' }, { id: 'cf-urgency-7a3', value: 'u2' },
    { id: 'cf-deal-link-7a4', value: 'https://app.hubspot.example/contacts/0000000/record/0-3/11' }, { id: 'cf-callback-by-7a5', value: NOW + 4 * 3600000 },
  ]);
  const review = lib.clickupCustomFields({ ...ctx, qualification: null, hubspot: { contact_id: '10' }, branch: null }, 'normal');
  assert.deepEqual(review.map(field => field.id), ['cf-urgency-7a3', 'cf-callback-by-7a5'], 'what is unknown is left out');
  assert.deepEqual(lib.clickupCustomFields({ ...ctx, settings: undefined }, 'high'), [], 'no field map, no fields');
  const body = lib.clickupTaskBody({ name: 'n', description: 'd', urgency: 'high', tags: [], custom_fields: fields });
  assert.equal(body.custom_fields.length, 5);
  assert.ok(!('custom_fields' in lib.clickupTaskBody({ name: 'n', description: 'd', urgency: 'high', tags: [] })));
  const text = JSON.stringify(fields);
  for (const value of [ctx.lead.email, ctx.lead.phone, ctx.lead.last_name]) assert.ok(!text.includes(value));
});

test('idempotency: the done mark stores ids for later steps and the summary without its buttons, only when posted', () => {
  const ctx = sampleCtx({ approval: { required: true, reasons: ['commercial_property'] } });
  const summary = lib.slackSummary(ctx, 'approval_required');
  const refs = lib.ledgerRefs(ctx, { ok: true, channel: 'C0C867WL7AR', ts: '1791686146.000001' }, summary);
  assert.deepEqual([refs.branch, refs.timezone, refs.contact_id, refs.deal_id, refs.clickup_task_id, refs.slack.channel, refs.slack.ts], ['savannah', 'America/New_York', '10', '11', '86abc', 'C0C867WL7AR', '1791686146.000001']);
  assert.equal(refs.slack.blocks.length, summary.blocks.length - 1);
  assert.ok(!refs.slack.blocks.some(block => block.type === 'actions'));
  assert.equal(lib.ledgerRefs(ctx, { ok: false, error: 'not_in_channel' }, summary).slack, null, 'a failed post leaves no message to update');
  assert.equal(lib.ledgerRefs(sampleCtx(), { ok: true, channel: 'C1', ts: '1.2' }, lib.slackSummary(sampleCtx(), 'auto_proposed')).slack.blocks, undefined, 'blocks only for a lead that waits for approval');
  assert.deepEqual(lib.doneRequestBody('evt-a-0001', 9, 'auto_proposed'), { event_id: 'evt-a-0001', run_id: '9', status: 'auto_proposed' });
  assert.equal(lib.doneRequestBody('evt-a-0001', 9, 'approval_required', refs).refs, refs);
});

// ------------------------------------------------------------------ Approve / Hold (workflow "Handle approval")

const goodClick = { team_id: 'T0C88V52NGN', action_id: 'approve_lead', value: 'evt-termite-fl-001', user_id: 'U0C84MF082F', channel_id: 'C0C867WL7AR', message_ts: '1791686146.000001', action_ts: '1791811762.000100', retry_attempt: 0 };

test('approval: the relay payload is ids only, in a fixed shape', () => {
  const ok = lib.validateSlackAction(goodClick);
  assert.equal(ok.valid, true);
  assert.deepEqual([ok.action.decision, ok.action.event_id], ['approved', 'evt-termite-fl-001']);
  assert.equal(lib.validateSlackAction({ ...goodClick, action_id: 'hold_lead' }).action.decision, 'on_hold');
  const bad = (patch, pattern) => {
    const result = lib.validateSlackAction({ ...goodClick, ...patch });
    assert.equal(result.valid, false, JSON.stringify(patch));
    assert.match(result.errors.join(' '), pattern);
  };
  bad({ action_id: 'delete_lead' }, /approve_lead or hold_lead/);
  bad({ action_id: 'toString' }, /approve_lead or hold_lead/);
  bad({ value: '{"deal_id":"70216"}' }, /event id/);
  bad({ user_id: 'christopher' }, /user id/);
  bad({ channel_id: '#leads' }, /channel id/);
  bad({ message_ts: 'yesterday' }, /message ts/);
  bad({ retry_attempt: '1' }, /retry_attempt/);
  bad({ team_id: '' }, /team id/);
  bad({ blocks: [] }, /unexpected fields .*blocks/);
  for (const payload of [null, [], 'approve']) assert.equal(lib.validateSlackAction(payload).valid, false);
});

test('approval: the approver list fails closed, and the ledger answer decides the route', () => {
  assert.deepEqual(lib.parseApproverIds(' U0C84MF082F, ,bob,W0ABC123 '), ['U0C84MF082F', 'W0ABC123']);
  assert.deepEqual(lib.parseApproverIds(undefined), []);
  assert.equal(lib.isApprover('U0C84MF082F', lib.parseApproverIds('')), false, 'empty means nobody');
  assert.equal(lib.isApprover('U0C84MF082F', ['U0C84MF082F']), true);
  const refs = { deal_id: '70216', clickup_task_id: '86a4qd000', slack: { channel: 'C1', ts: '1.2', blocks: [] } };
  assert.deepEqual(lib.interpretDecisionClaim({ outcome: 'claimed', refs }), { route: 'claimed', reason: null, refs });
  assert.deepEqual(lib.interpretDecisionClaim({ outcome: 'decided', decision: 'on_hold' }).reason, 'already_on_hold');
  assert.equal(lib.interpretDecisionClaim({ outcome: 'in_flight' }).route, 'already_decided');
  assert.equal(lib.interpretDecisionClaim({ outcome: 'unknown_event' }).route, 'not_awaiting');
  assert.equal(lib.interpretDecisionClaim({ outcome: 'not_awaiting_approval' }).route, 'not_awaiting');
  assert.throws(() => lib.interpretDecisionClaim({ outcome: 'claimed', refs: { deal_id: '1' } }), /no deal or CSR task/);
  assert.throws(() => lib.interpretDecisionClaim({ outcome: 'maybe' }), /unknown decision outcome/);
  assert.throws(() => lib.interpretDecisionClaim({ error: { message: '503' } }), /did not answer/);
  assert.deepEqual(lib.decisionClaimBody(lib.validateSlackAction(goodClick).action, 12), { run_id: '12', decision: 'approved', user_id: 'U0C84MF082F', action_ts: '1791811762.000100' });
  assert.deepEqual(lib.hubspotDecisionStageBody('approved', SETTINGS), { properties: { dealstage: 'ridgeway_approved' } });
  assert.deepEqual(lib.hubspotDecisionStageBody('on_hold', SETTINGS), { properties: { dealstage: 'ridgeway_on_hold' } });
  assert.throws(() => lib.hubspotDecisionStageBody('new_lead', SETTINGS), /Unknown approval decision/);
  const generated = { hubspot: { ...SETTINGS.hubspot, stages: { new_lead: '1290000001', needs_approval: '1290000004', approved: '1290000005', on_hold: '1290000006' } } };
  assert.deepEqual(lib.hubspotDecisionStageBody('approved', generated), { properties: { dealstage: '1290000005' } }, 'a live portal\'s generated stage id comes from the sheet');
});

test('approval: the updated message keeps the summary, drops the buttons and says who decided when, in the branch time zone', () => {
  const ctx = sampleCtx({ approval: { required: true, reasons: ['commercial_property'] } });
  const refs = lib.ledgerRefs({ ...ctx, branch: { id: 'mobile', timezone: 'America/Chicago' } }, { ok: true, channel: 'C0C867WL7AR', ts: '1791686146.000001' }, lib.slackSummary(ctx, 'approval_required'));
  const action = lib.validateSlackAction(goodClick).action; // 1791811762 = Oct 12 2026, 13:29:22 UTC
  const update = lib.decidedMessage(refs, action);
  assert.deepEqual([update.channel, update.ts], ['C0C867WL7AR', '1791686146.000001']);
  assert.deepEqual(update.blocks.slice(0, -1), refs.slack.blocks);
  assert.equal(update.blocks.at(-1).text.text, '*Approved* by <@U0C84MF082F> at Oct 12, 8:29 AM CDT');
  assert.ok(!update.blocks.some(block => block.type === 'actions'));
  assert.equal(lib.decidedMessage(refs, { ...action, decision: 'on_hold' }).blocks.at(-1).text.text, '*Put on hold* by <@U0C84MF082F> at Oct 12, 8:29 AM CDT');
  const comment = lib.clickupDecisionComment(action, { ...refs, timezone: 'America/New_York' });
  assert.equal(comment, 'Approved in Slack by user U0C84MF082F at Oct 12, 9:29 AM EDT.\nHubSpot deal 11 moved to Approved. Book the visit with the customer.\nEvent: evt-termite-fl-001');
  assert.deepEqual(lib.clickupCommentBody('x'), { comment_text: 'x', notify_all: false });
  assert.deepEqual(lib.approverOnlyNotice(action), { channel: 'C0C867WL7AR', user: 'U0C84MF082F', text: 'Only approvers can approve or hold a lead. Nothing was changed; ask a manager to decide.' });
});

test('builder: the approval workflow verifies, validates, checks the approver, claims, then applies, with no shortcut', () => {
  const approvalFlow = buildAll()['handle-approval.json'];
  assert.equal(approvalFlow.id, 'pestLeadApprove1');
  const next = (name, output = 0) => approvalFlow.connections[name].main[output].map(link => link.node);
  assert.deepEqual(next('Check relay signature result', 1), ['Respond 401 unauthorized']);
  assert.deepEqual(next('Check action is valid', 1), ['Respond 400 invalid']);
  assert.deepEqual(next('Branch on approver', 1), ['Prepare approver notice']);
  assert.deepEqual(next('Post Slack approver notice'), ['Respond not an approver'], 'a non-approver only gets the notice');
  assert.deepEqual([0, 1, 2].map(output => next('Route decision claim', output)[0]), ['Fetch ops settings', 'Respond already decided', 'Respond not awaiting approval'], 'only a claimed decision reads the sheet');
  const order = ['Fetch ops settings', 'Prepare deal decision', 'Move deal to decided stage', 'Prepare ClickUp decision comment', 'Add ClickUp decision comment', 'Prepare Slack message update', 'Update Slack approval message', 'Prepare decision done', 'Mark decision done', 'Respond with decision'];
  for (let i = 1; i < order.length; i++) assert.ok(next(order[i - 1]).includes(order[i]), `${order[i - 1]} -> ${order[i]}`);
  const webhook = approvalFlow.nodes.find(node => node.type === 'n8n-nodes-base.webhook');
  assert.deepEqual([webhook.parameters.path, webhook.parameters.options.rawBody], ['ridgeway/slack-action', true]);
  assert.match(approvalFlow.nodes.find(node => node.name === 'Verify relay signature').parameters.jsCode, /verifySignature\(\$env\.SLACK_RELAY_SECRET/);
  assert.match(approvalFlow.nodes.find(node => node.name === 'Check approver').parameters.jsCode, /parseApproverIds\(\$env\.SLACK_APPROVER_IDS\)/);
  assert.match(approvalFlow.nodes.find(node => node.name === 'Move deal to decided stage').parameters.url, /deals\/\{\{ \$json\.refs\.deal_id \}\}$/, 'the deal id comes from the ledger refs, not the button');
});

test('mock: chat.update, chat.postEphemeral and ClickUp comments, with Slack-style errors', async () => {
  const mock = await startMock();
  try {
    let n = 0;
    const call = (path, body) => fetch(`${mock.url}${path}`, { method: 'POST', headers: { ...authHeaders, 'idempotency-key': `k${++n}` }, body: JSON.stringify(body) }).then(res => res.json());
    const posted = await call('/slack/api/chat.postMessage', { channel: '#leads', text: 'hi', blocks: [{ type: 'actions', elements: [] }] });
    assert.equal(posted.channel, 'C0MOCKLEADS', 'Slack answers with the channel id');
    assert.equal((await call('/slack/api/chat.update', { channel: 'C0MOCKLEADS', ts: 'nope', text: 'x' })).error, 'message_not_found');
    const updated = await call('/slack/api/chat.update', { channel: posted.channel, ts: posted.ts, text: 'decided', blocks: [] });
    assert.deepEqual([updated.ok, updated.ts], [true, posted.ts]);
    assert.equal((await call('/slack/api/chat.postEphemeral', { channel: 'C0MOCKLEADS', user: 'U0X1', text: 'only approvers' })).ok, true);
    const task = (await (await fetch(`${mock.url}/__state`)).json()).tasks[0];
    const comment = await call(`/clickup/api/v2/task/${task.id}/comment`, { comment_text: 'Approved', notify_all: false });
    assert.ok(comment.id);
    assert.equal((await call('/clickup/api/v2/task/nope/comment', { comment_text: 'x' })).ECODE, 'ITEM_013');
    const bad = await fetch(`${mock.url}/clickup/api/v2/list/901100123/task`, { method: 'POST', headers: { ...authHeaders, 'idempotency-key': 'k:bad' }, body: JSON.stringify({ name: 'x', custom_fields: [{ id: 'cf-made-up', value: 1 }] }) });
    assert.equal(bad.status, 400, 'a field the list does not have is refused');
    const state = await (await fetch(`${mock.url}/__state`)).json();
    assert.deepEqual([state.slack_messages[0].text, state.slack_messages[0].blocks], ['decided', []]);
    assert.equal(state.slack_ephemeral[0].user, 'U0X1');
    assert.equal(state.tasks[0].comments[0].comment_text, 'Approved');
    assert.ok(state.log === undefined);
  } finally {
    await mock.close();
  }
});

test('ledger: one decision per lead, first wins; a failed decision run hands it back; a snapshot restores everything', async () => {
  let now = Date.parse('2026-10-12T14:00:00Z');
  const mock = await startMock({ clock: () => now });
  try {
    const decide = (body, runId) => ledgerCall(mock, 'events/evt-a-0001/decision', { run_id: runId, decision: 'approved', user_id: 'U0A1', action_ts: '1.2', ...body });
    assert.equal((await decide({}, '1')).outcome, 'unknown_event');
    await ledgerCall(mock, 'events/claim', { event_id: 'evt-a-0001', run_id: '1' });
    await ledgerCall(mock, 'events/complete', { event_id: 'evt-a-0001', run_id: '1', status: 'auto_proposed', refs: { deal_id: '7', clickup_task_id: 't' } });
    assert.equal((await decide({}, '2')).outcome, 'not_awaiting_approval', 'an auto-proposed lead has nothing to decide');
    await ledgerCall(mock, 'events/claim', { event_id: 'evt-b-0002', run_id: '3' });
    await ledgerCall(mock, 'events/complete', { event_id: 'evt-b-0002', run_id: '3', status: 'approval_required', refs: { deal_id: '8', clickup_task_id: 't8' } });
    const claimB = (runId, decision = 'approved') => ledgerCall(mock, 'events/evt-b-0002/decision', { run_id: runId, decision, user_id: 'U0A1', action_ts: '1.2' });
    const first = await claimB('4');
    assert.deepEqual([first.outcome, first.refs.deal_id], ['claimed', '8']);
    assert.equal((await claimB('4')).outcome, 'claimed', 'the same run may ask again (an n8n retry)');
    assert.equal((await claimB('5', 'on_hold')).outcome, 'in_flight', 'another run while the first is going');
    assert.deepEqual(await ledgerCall(mock, 'runs/4/fail', { reason: 'HubSpot 503 for jo@x.example' }), { event_id: 'evt-b-0002', state: 'decision_failed' });
    assert.equal((await claimB('6', 'on_hold')).outcome, 'claimed', 'after a failure the next click is processed');
    assert.deepEqual(await ledgerCall(mock, 'events/evt-b-0002/decision/complete', { run_id: '5' }), { ok: false, outcome: 'not_owner' });
    assert.deepEqual(await ledgerCall(mock, 'events/evt-b-0002/decision/complete', { run_id: '6' }), { ok: true });
    assert.deepEqual(await claimB('7'), { outcome: 'decided', decision: 'on_hold', user_id: 'U0A1', decided_at: new Date(now).toISOString() });
    // A stale in-flight decision (an n8n crash) can be reclaimed after 10 minutes.
    await ledgerCall(mock, 'events/claim', { event_id: 'evt-c-0003', run_id: '8' });
    await ledgerCall(mock, 'events/complete', { event_id: 'evt-c-0003', run_id: '8', status: 'approval_required', refs: { deal_id: '9', clickup_task_id: 't9' } });
    await ledgerCall(mock, 'events/evt-c-0003/decision', { run_id: '9', decision: 'approved', user_id: 'U0A1' });
    now += 11 * 60 * 1000;
    assert.equal((await ledgerCall(mock, 'events/evt-c-0003/decision', { run_id: '10', decision: 'approved', user_id: 'U0A1' })).outcome, 'claimed');
    const saved = mock.snapshot();
    const copy = await startMock({ clock: () => now, restore: JSON.parse(JSON.stringify(saved)) });
    try {
      assert.equal((await ledgerCall(copy, 'events/evt-b-0002/decision', { run_id: '11', decision: 'approved', user_id: 'U0A1' })).outcome, 'decided', 'the restored ledger remembers the decision');
      const state = await (await fetch(`${copy.url}/__state`)).json();
      assert.equal(state.deals.length, 15);
      assert.equal(state.ledger.find(item => item.event_id === 'evt-b-0002').decision.state, 'done');
    } finally {
      await copy.close();
    }
  } finally {
    await mock.close();
  }
});

test('mock: a 429 fault sends the Retry-After it was given', async () => {
  const mock = await startMock();
  try {
    await fetch(`${mock.url}/__control`, { method: 'POST', body: JSON.stringify({ faults: [{ op: 'slack.post_message', status: 429, retry_after: 1, body: { ok: false, error: 'ratelimited' } }] }) });
    const res = await fetch(`${mock.url}/slack/api/chat.postMessage`, { method: 'POST', headers: { ...authHeaders, 'idempotency-key': 'k' }, body: JSON.stringify({ channel: '#leads', text: 'x' }) });
    assert.deepEqual([res.status, res.headers.get('retry-after'), (await res.json()).error], [429, '1', 'ratelimited']);
  } finally {
    await mock.close();
  }
});

// ------------------------------------------------------------------ n8n runs with an allowlisted environment

test('n8n environment: only the allowlist reaches n8n, nothing is inherited from the caller', () => {
  const caller = { PATH: '/bin', HOME: '/home/u', TMPDIR: '/tmp', LANG: 'en_US.UTF-8', AWS_SECRET_ACCESS_KEY: 'canary', ANTHROPIC_API_KEY: 'canary', GITHUB_TOKEN: 'canary', N8N_ENCRYPTION_KEY: 'canary-from-caller' };
  const env = buildN8nEnv({ N8N_PORT: 5688, LEAD_WEBHOOK_SECRET: 'demo', HUBSPOT_TOKEN: 'demo' }, caller);
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'HUBSPOT_TOKEN', 'LANG', 'LEAD_WEBHOOK_SECRET', 'N8N_PORT', 'PATH', 'TMPDIR']);
  assert.ok(!JSON.stringify(env).includes('canary'), 'no variable from the caller leaks in, not even an N8N_ one');
  assert.throws(() => buildN8nEnv({ AWS_SECRET_ACCESS_KEY: 'x' }, caller), /not on the n8n environment allowlist/);
  assert.deepEqual(SYSTEM_VARIABLES, ['PATH', 'HOME', 'TMPDIR', 'LANG']);
});

test('n8n environment: start.sh applies the same allowlist with env -i', () => {
  const script = readFileSync(join(root, 'start.sh'), 'utf8');
  assert.match(script, /exec env -i /);
  for (const name of [...SYSTEM_VARIABLES, ...DEMO_VARIABLES]) assert.ok(new RegExp(`\\b${name}\\b`).test(script), `start.sh allowlists ${name}`);
  assert.match(script, /N8N_\*|N8N_/, 'N8N_ settings are passed');
  assert.ok(!/exec n8n start/.test(script), 'n8n is never started with the full environment');
  assert.match(readFileSync(join(root, 'env.sh'), 'utf8'), /WARNING[\s\S]*N8N_BLOCK_ENV_ACCESS_IN_NODE/, 'env.sh warns about N8N_BLOCK_ENV_ACCESS_IN_NODE=false');
});

test('n8n environment: start.sh really starts n8n with env -i (stubbed n8n prints what it received)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pest-start-test-'));
  try {
    writeFileSync(join(dir, 'n8n'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2.42.6; else env; fi\n');
    chmodSync(join(dir, 'n8n'), 0o755);
    const run = spawnSync('/bin/sh', [join(root, 'start.sh')], {
      encoding: 'utf8',
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, TMPDIR: dir, LANG: 'en_US.UTF-8', CANARY_SECRET: 'canary-1', AWS_SECRET_ACCESS_KEY: 'canary-2', ANTHROPIC_API_KEY: 'allowed-by-name', N8N_CANARY_SETTING: 'n8n-prefixed' },
    });
    assert.equal(run.status, 0, run.stderr);
    const received = Object.fromEntries(run.stdout.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    assert.ok(!('CANARY_SECRET' in received) && !('AWS_SECRET_ACCESS_KEY' in received), 'variables outside the allowlist are not passed');
    assert.equal(received.HOME, dir);
    assert.equal(received.N8N_PORT, '5688');
    assert.equal(received.N8N_CANARY_SETTING, 'n8n-prefixed', 'N8N_ settings pass');
    assert.ok(received.HUBSPOT_TOKEN && received.LEAD_WEBHOOK_SECRET && received.EVENT_LEDGER_BASE_URL, 'demo settings pass');
    const names = Object.keys(received).filter(name => !['PWD', 'SHLVL', '_'].includes(name)); // the stub's own shell adds these
    assert.ok(names.every(name => SYSTEM_VARIABLES.includes(name) || DEMO_VARIABLES.includes(name) || name.startsWith('N8N_')), `unexpected variables: ${names.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ live HubSpot: setup script, token, portal file, mock parity

const { runSetup, checkHubspotToken, checkPortal, settingsFromPortal, emailFallbackFromArgs, uiHost, REQUIRED_SCOPES } = await import('../scripts/hubspot-setup.mjs');
const FAKE_TOKEN = 'pat-' + 'na2-1b2c3d4e-0000-4000-8000-00000000abcd' /* fake, split so secret scanners don't flag it */;
const hubspotCall = (mock, method, path, body, key) => fetch(`${mock.url}/hubspot${path}`, {
  method, headers: { authorization: 'Bearer t', 'content-type': 'application/json', ...(key ? { 'idempotency-key': key, 'x-run-id': '1' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
}).then(async res => ({ status: res.status, body: await res.json() }));

test('live HubSpot: the token check accepts a service key and never repeats the token', () => {
  assert.equal(FAKE_TOKEN.length, 44, 'the shape of the real key: pat-na2- plus a UUID, 44 characters');
  assert.equal(checkHubspotToken(FAKE_TOKEN), FAKE_TOKEN);
  assert.equal(checkHubspotToken('pat-' + 'eu1-1b2c3d4e-0000-4000-8000-00000000abcd' /* fake, split so secret scanners don't flag it */).length, 44);
  assert.throws(() => checkHubspotToken(undefined), /RIDGEWAY_HUBSPOT_TOKEN is missing/);
  for (const bad of ['xoxb-123-456', 'pat-na2-not-a-uuid', `Bearer ${FAKE_TOKEN}`, `${FAKE_TOKEN} `]) {
    assert.throws(() => checkHubspotToken(bad), error => /does not look like a HubSpot service key/.test(error.message) && !error.message.includes(bad.trim()), bad);
  }
  assert.deepEqual(REQUIRED_SCOPES, ['crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.objects.deals.read', 'crm.objects.deals.write',
    'crm.schemas.contacts.read', 'crm.schemas.contacts.write', 'crm.schemas.deals.read', 'crm.schemas.deals.write'], 'exactly the eight scopes the key was given');
});

test('live HubSpot: record links use the portal\'s regional app host, and the portal file is checked', () => {
  assert.equal(uiHost({ dataHostingLocation: 'na2', uiDomain: 'app.hubspot.com' }), 'app-na2.hubspot.com', 'the data hosting location decides, not a hard-coded host');
  assert.equal(uiHost({ dataHostingLocation: 'na1' }), 'app.hubspot.com');
  assert.equal(uiHost({ dataHostingLocation: 'eu1' }), 'app-eu1.hubspot.com');
  assert.equal(uiHost({ uiDomain: 'app.hubspot.example', dataHostingLocation: 'na1' }), 'app.hubspot.example', 'the mock keeps .example links');
  assert.throws(() => uiHost({}), /dataHostingLocation/);
  const portal = { portal_id: '247657707', account_type: 'DEVELOPER_TEST', app_url: 'https://app-na2.hubspot.com/contacts/247657707/record', pipeline: { id: '880100001' }, stages: { new_lead: '1', needs_approval: '4', approved: '5', on_hold: '6' } };
  assert.deepEqual(settingsFromPortal(portal), {
    hubspot_pipeline_id: '880100001', hubspot_stage_new_lead: '1', hubspot_stage_needs_approval: '4', hubspot_stage_approved: '5', hubspot_stage_on_hold: '6',
    hubspot_app_url: 'https://app-na2.hubspot.com/contacts/247657707/record', hubspot_email_fallback: 'off',
  });
  assert.equal(settingsFromPortal(portal, { emailFallback: true }).hubspot_email_fallback, 'example_com');
  assert.equal(emailFallbackFromArgs(['--live-hubspot']), true, 'live HubSpot uses the example.com fallback by default');
  assert.equal(emailFallbackFromArgs(['--live-hubspot', '--hubspot-email-fallback']), true, 'the old switch is a no-op');
  assert.equal(emailFallbackFromArgs(['--live-hubspot', '--no-hubspot-email-fallback']), false, 'and can be turned off');
  const settings = lib.parseSettings({ values: [...OPS_RULES.tabs.Settings.rows.filter(([key]) => !key.startsWith('hubspot_')), ...Object.entries(settingsFromPortal(portal))] });
  assert.deepEqual(settings.hubspot.stages, { new_lead: '1', needs_approval: '4', approved: '5', on_hold: '6' }, 'the rows the runner injects parse as rules');
  assert.throws(() => checkPortal({ ...portal, account_type: 'STANDARD' }), /account_type/);
  assert.throws(() => checkPortal({ ...portal, stages: { new_lead: '1' } }), /stages.needs_approval/);
});

test('live HubSpot: setup plans with reads only, creates what is missing with generated ids, and a second run creates nothing', async () => {
  const mock = await startMock();
  try {
    await fetch(`${mock.url}/__control`, { method: 'POST', body: JSON.stringify({ hubspot_portal: 'fresh' }) });
    const setup = options => runSetup({ baseUrl: `${mock.url}/hubspot`, token: FAKE_TOKEN, paceMs: 0, ...options });
    const lines = [];
    const dry = await setup({ dryRun: true, log: line => lines.push(line) });
    assert.equal(dry.portal, null);
    assert.equal(dry.plan.length, 9, 'two groups, six properties, one pipeline');
    assert.ok(lines.some(line => /would create pipeline: Ridgeway Sales/.test(line)));
    const log = await (await fetch(`${mock.url}/__log`)).json();
    assert.ok(log.every(entry => entry.method === 'GET'), 'the dry run only reads');
    assert.ok(!JSON.stringify(lines).includes(FAKE_TOKEN), 'the token is never logged');
    const { portal } = await setup({});
    assert.equal(portal.portal_id, '4242424');
    assert.equal(portal.app_url, 'https://app.hubspot.example/contacts/4242424/record');
    assert.deepEqual(Object.keys(portal.stages), ['new_lead', 'contacted', 'inspection_scheduled', 'needs_approval', 'approved', 'on_hold', 'quote_sent', 'won', 'lost'], 'the nine stages of the seeded pipeline');
    assert.ok(Object.values(portal.stages).every(id => /^\d+$/.test(id)) && /^\d+$/.test(portal.pipeline.id), 'HubSpot generates the ids');
    const writes = (await (await fetch(`${mock.url}/__log`)).json()).filter(entry => entry.method === 'POST');
    assert.ok(writes.every(entry => /^ridgeway-setup:/.test(entry.idempotency_key) && entry.run_id), 'writes carry a key and a run id');
    const state = await (await fetch(`${mock.url}/__state`)).json();
    assert.equal(state.hubspot.properties.deals.find(def => def.name === 'ridgeway_event_id').hasUniqueValue, true);
    assert.equal(state.hubspot.pipelines.length, 2, 'HubSpot\'s own pipeline is left alone');
    const again = await setup({});
    assert.deepEqual([again.plan, again.portal.stages, again.portal.pipeline.id], [[], portal.stages, portal.pipeline.id], 'idempotent');
  } finally { await mock.close(); }
});

test('live HubSpot: setup refuses a standard account and a mismatched property, and writes nothing', async () => {
  const mock = await startMock();
  try {
    const setup = () => runSetup({ baseUrl: `${mock.url}/hubspot`, token: FAKE_TOKEN, paceMs: 0 });
    const seeded = await setup();
    assert.deepEqual([seeded.plan, seeded.portal.pipeline.id, seeded.portal.stages.needs_approval], [[], 'ridgeway_sales', 'ridgeway_needs_approval'], 'the seeded mock is an already set-up portal');
    await fetch(`${mock.url}/__control`, { method: 'POST', body: JSON.stringify({ hubspot_account: { accountType: 'STANDARD' } }) });
    await assert.rejects(setup(), /refusing to set up: account 4242424 is STANDARD/);
    await fetch(`${mock.url}/__reset`, { method: 'POST' });
    await fetch(`${mock.url}/__control`, { method: 'POST', body: JSON.stringify({ hubspot_portal: 'fresh' }) });
    await hubspotCall(mock, 'POST', '/crm/v3/properties/deals', { groupName: 'dealinformation', name: 'ridgeway_event_id', label: 'x', type: 'string', fieldType: 'text' }, 'k:1');
    const before = (await (await fetch(`${mock.url}/__log`)).json()).length;
    await assert.rejects(setup(), /deals property ridgeway_event_id exists as string\/text, expected string\/text \(unique\)/);
    const after = await (await fetch(`${mock.url}/__log`)).json();
    assert.ok(after.slice(before).every(entry => entry.method === 'GET'), 'nothing was written');
  } finally { await mock.close(); }
});

test('mock parity: deals are read by the unique ridgeway_event_id, a second create conflicts, and unknown stages or properties are refused', async () => {
  const mock = await startMock();
  try {
    const props = { dealname: 'x', amount: '100', pipeline: 'ridgeway_sales', dealstage: 'ridgeway_new_lead', ridgeway_event_id: 'evt-par-0001' };
    assert.equal((await hubspotCall(mock, 'GET', '/crm/v3/objects/deals/evt-par-0001?idProperty=ridgeway_event_id')).status, 404);
    const created = await hubspotCall(mock, 'POST', '/crm/v3/objects/deals', { properties: props }, 'a:1');
    assert.equal(created.status, 201);
    const read = await hubspotCall(mock, 'GET', '/crm/v3/objects/deals/evt-par-0001?idProperty=ridgeway_event_id&properties=dealstage,ridgeway_event_id');
    assert.deepEqual([read.status, read.body.id, read.body.properties.dealstage], [200, created.body.id, 'ridgeway_new_lead']);
    const again = await hubspotCall(mock, 'POST', '/crm/v3/objects/deals', { properties: props }, 'a:2');
    assert.deepEqual([again.status, again.body.category], [409, 'CONFLICT'], 'ridgeway_event_id is unique');
    assert.equal((await hubspotCall(mock, 'POST', '/crm/v3/objects/deals', { properties: { ...props, ridgeway_event_id: 'evt-par-0002', dealstage: 'ridgeway_needs_approvl' } }, 'a:3')).status, 400, 'an unknown stage is refused, as in HubSpot');
    assert.equal((await hubspotCall(mock, 'PATCH', `/crm/v3/objects/deals/${created.body.id}`, { properties: { dealstage: '123' } }, 'a:4')).status, 400);
    const unknown = await hubspotCall(mock, 'POST', '/crm/v3/objects/contacts', { properties: { email: 'n@x.example', ridgeway_favourite: 'y' } }, 'a:5');
    assert.match(unknown.body.message, /PROPERTY_DOESNT_EXIST/);
    assert.equal((await hubspotCall(mock, 'GET', '/crm/v3/objects/deals/x?idProperty=dealname')).status, 400, 'idProperty needs a unique property');
    const association = await hubspotCall(mock, 'PUT', `/crm/v4/objects/deals/${created.body.id}/associations/default/contacts/40101`, undefined, 'a:6');
    assert.deepEqual([association.body.status, association.body.results[0].to.id, association.body.results[0].associationSpec.associationCategory], ['COMPLETE', '40101', 'HUBSPOT_DEFINED'], 'the documented BatchResponsePublicDefaultAssociation shape');
  } finally { await mock.close(); }
});

test('mock parity: a contact with an existing email is refused with 409, search can lag, .example emails can be refused, and sheet rows can be overridden', async () => {
  const mock = await startMock();
  try {
    const dup = await hubspotCall(mock, 'POST', '/crm/v3/objects/contacts', { properties: { email: 'RENEE.castellanos@gmail.example' } }, 'b:1');
    assert.deepEqual([dup.status, dup.body.category, dup.body.message], [409, 'CONFLICT', 'Contact already exists. Existing ID: 40101']);
    const byEmail = await hubspotCall(mock, 'GET', `/crm/v3/objects/contacts/${encodeURIComponent('renee.castellanos@gmail.example')}?idProperty=email`);
    assert.deepEqual([byEmail.status, byEmail.body.id], [200, '40101']);
    const search = () => hubspotCall(mock, 'POST', '/crm/v3/objects/contacts/search', { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: 'renee.castellanos@gmail.example' }] }] });
    assert.equal((await search()).body.total, 1);
    await fetch(`${mock.url}/__control`, { method: 'POST', body: JSON.stringify({ hubspot_search_hidden: ['40101'], hubspot_reject_example_emails: true, sheet_settings: { hubspot_stage_approved: '1290000005', hubspot_new_row: 'x' } }) });
    assert.equal((await search()).body.total, 0, 'not indexed yet: the search misses it, the read by email does not');
    assert.equal((await hubspotCall(mock, 'GET', `/crm/v3/objects/contacts/renee.castellanos@gmail.example?idProperty=email`)).status, 200);
    const refused = await hubspotCall(mock, 'POST', '/crm/v3/objects/contacts', { properties: { email: 'new.person@outlook.example' } }, 'b:2');
    assert.match(refused.body.message, /INVALID_EMAIL/);
    assert.equal((await hubspotCall(mock, 'POST', '/crm/v3/objects/contacts', { properties: { email: 'new.person+outlook@example.com' } }, 'b:3')).status, 201, 'the fallback address is accepted');
    const sheet = await (await fetch(`${mock.url}/sheets/v4/spreadsheets/ridgeway-ops-rules/values/Settings!A2:B`, { headers: { authorization: 'Bearer t' } })).json();
    const rows = Object.fromEntries(sheet.values);
    assert.deepEqual([rows.hubspot_stage_approved, rows.hubspot_new_row, rows.hubspot_stage_on_hold], ['1290000005', 'x', 'ridgeway_on_hold']);
    await fetch(`${mock.url}/__reset`, { method: 'POST' });
    assert.equal(Object.fromEntries((await (await fetch(`${mock.url}/sheets/v4/spreadsheets/ridgeway-ops-rules/values/Settings!A2:B`, { headers: { authorization: 'Bearer t' } })).json()).values).hubspot_stage_approved, 'ridgeway_approved', 'a reset drops the overrides');
  } finally { await mock.close(); }
});

test('live HubSpot: simulate-day refuses to start without a well-formed token, before anything starts, and never prints it', () => {
  const run = env => spawnSync(process.execPath, [join(root, 'scripts/simulate-day.mjs'), '--live-hubspot'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, timeout: 20000 });
  const missing = run({});
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /RIDGEWAY_HUBSPOT_TOKEN is missing/);
  const secretish = 'pat-na2-NOT-A-REAL-KEY-but-secret-looking';
  const wrong = run({ RIDGEWAY_HUBSPOT_TOKEN: secretish });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /does not look like a HubSpot service key/);
  assert.ok(!`${wrong.stdout}${wrong.stderr}`.includes(secretish), 'the token is not echoed');
  const fallback = spawnSync(process.execPath, [join(root, 'scripts/simulate-day.mjs'), '--hubspot-email-fallback'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(fallback.status, 2, 'the fallback is a live-HubSpot switch only');
  const noFallback = spawnSync(process.execPath, [join(root, 'scripts/simulate-day.mjs'), '--no-hubspot-email-fallback'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(noFallback.status, 2, 'so is turning it off');
});
