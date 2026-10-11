// Full end-to-end verification against a real n8n 2.42.6 server.
//   node tests/verify.mjs              replay mode: Claude answers come from fixtures/llm via the vendor mock
//   node tests/verify.mjs --live-llm   live mode: Claude answers come from the local Claude Code bridge
//                                       (dedicated sign-in folder CLAUDE_BRIDGE_CONFIG_DIR, default ~/.claude-n8n-bridge)
//   node tests/verify.mjs --only gmail_down,stale_timestamp   run just these scenarios or checks
// Starts the vendor mock (and, in live mode, the bridge), imports and publishes both workflows with the
// n8n CLI, starts `n8n start` on a free port with a temp user folder and an allowlisted environment, POSTs
// signed payloads to the production webhook and asserts on the HTTP response, the mock's request log AND the
// mock's state (what actually exists: contacts, deals, tasks, drafts, Slack posts, sheet rows, ledger).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertKeyReuse, assertWriteHeaders } from './key-reuse.mjs';
import { DEMO_VARIABLES, buildN8nEnv } from './n8n-env.mjs';
import { APPROVAL_ID, ERROR_ID, MAIN_ID, N8N_VERSION, createHarness, n8nCommand, root, sleep } from './harness.mjs';
import { loadModules } from '../workflow/modules.mjs';
import { runSetup, settingsFromPortal } from '../scripts/hubspot-setup.mjs';

const lib = loadModules();
// With the live-HubSpot email fallback on, HubSpot holds <local>+<domain>@example.com: that form is customer data too.
const withFallbackEmails = values => [...values, ...values.filter(value => /@[\w.-]+\.example$/.test(value)).map(value => lib.hubspotEmail(value, { hubspot: { email_fallback: 'example_com' } }))];

const live = process.argv.includes('--live-llm');
const onlyArg = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const only = onlyArg ? new Set(onlyArg.split(',')) : null;
const selected = id => !only || only.has(id);
const prefix = live ? 'live-llm-' : '';
const resultsDir = join(root, 'results');
const { test_now: TEST_NOW, scenarios, checks } = JSON.parse(readFileSync(join(root, 'fixtures/scenarios.json'), 'utf8'));
mkdirSync(join(resultsDir, live ? 'live-llm-request-logs' : 'request-logs'), { recursive: true });

const h = createHarness({ live, resultsDir, prefix, defaultNow: TEST_NOW });
const { secrets, userFolder, n8nCli, control, mockLog, mockState, bridgeSnapshot, bridgeEntries, settle, ports, sendLead } = h;
const outcomes = [];

function matchPartial(actual, expected, path = 'body') {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    assert.ok(actual !== null && typeof actual === 'object', `${path}: expected an object, got ${JSON.stringify(actual)}`);
    for (const [key, value] of Object.entries(expected)) matchPartial(actual[key], value, `${path}.${key}`);
  } else {
    assert.deepEqual(actual, expected, `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const decodeDraft = entry => Buffer.from(entry.body.message.raw, 'base64url').toString('utf8');
const opsOf = (log, op) => log.filter(entry => entry.op === op);
// A scenario has its own payload, or reuses another one (payload_from names a scenario or a check) with optional
// field changes (payload_patch). Reusing a payload reuses its recorded Claude answer: the request is identical.
const baseOf = def => def.payload ? def : (scenarios.find(s => s.id === def.payload_from) ?? checks[def.payload_from]);
const payloadOf = def => {
  const base = baseOf(def)?.payload;
  assert.ok(base, `${def.id}: no payload`);
  return { ...base, ...(def.payload_patch ?? {}) };
};
// The instant the test clock reads for a scenario: its own, its source's, or the suite default.
const nowOf = def => def.now ?? baseOf(def)?.now ?? TEST_NOW;
const isoOf = value => new Date(value).toISOString();
const localDate = (instant, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ scenario execution

async function runScenario(def) {
  await control('/__reset');
  if (def.mock) await control('/__control', def.mock);
  const before = bridgeSnapshot();
  const payload = payloadOf(def);
  const pretty = def.body_format === 'pretty';
  const timestampOffset = def.timestamp_offset_seconds ?? 0;
  const now = nowOf(def);
  const signature = def.signature === 'wrong' ? h.sign(JSON.stringify(payload), 'not-the-secret', Math.floor(Date.parse(now) / 1000) + timestampOffset) : undefined;
  const started = Date.now();
  const res = await sendLead(payload, { now, signature, pretty, timestampOffset });
  await settle();
  const log = [...(await mockLog()), ...bridgeEntries(before)];
  return { res, log, state: await mockState(), elapsed_ms: Date.now() - started, payload, now };
}

function summarizeCalls(log) {
  const counts = {};
  for (const entry of log) counts[entry.op] = (counts[entry.op] ?? 0) + 1;
  return counts;
}

// Internal sinks that must never carry contact details (the ledger's done mark now carries the Slack summary's blocks).
const INTERNAL_OPS = ['slack.post_message', 'slack.update_message', 'slack.post_ephemeral', 'clickup.create_task', 'clickup.create_comment', 'sheets.append', 'ledger.complete'];

// scope: { eventId } for a scenario that processes one event; keyPrefixes lists the ids that may prefix an
// Idempotency-Key (the event id, plus the failed run id for the error workflow's own writes).
function assertGlobalSafety(id, log, def, { keyPrefixes, allowCrossRun = false, responses = [] } = {}) {
  for (const entry of log) {
    assert.ok(!['missing_recording', 'stale_recording', 'forbidden_send', 'unknown_route', 'rejected', 'invalid_request', 'bridge_error', 'missing_idempotency_key', 'idempotency_key_body_mismatch'].includes(entry.fault),
      `${id}: unexpected mock fault ${entry.fault} on ${entry.op}`);
  }
  assert.equal(opsOf(log, 'gmail.send').length, 0, `${id}: nothing may ever be sent by email`);
  for (const entry of log) assert.ok(!/sms|twilio/i.test(entry.path ?? ''), `${id}: no SMS endpoint may be called`);

  // Every state-changing call: Idempotency-Key = <event id>:<node name> and X-Run-Id; ledger calls X-Run-Id only; reads neither.
  const eventId = payloadOf(def)?.event_id;
  assertWriteHeaders(id, log, keyPrefixes ?? [eventId]);
  // A key may repeat only as a retry after an injected fault (same run) or a redelivery (other run, where allowed),
  // always with a byte-identical body.
  assertKeyReuse(id, log, { allowCrossRun });

  // Slack, ClickUp and Sheets get ids, links, first name and ZIP only. The forbidden strings are written out per
  // fixture in scenarios.json (not derived from the code under test).
  assert.ok(Array.isArray(def.expect.forbidden), `${id}: the fixture lists its forbidden strings`);
  const forbidden = withFallbackEmails(def.expect.forbidden);
  for (const entry of log.filter(e => INTERNAL_OPS.includes(e.op))) {
    const text = JSON.stringify(entry.body);
    for (const value of forbidden) assert.ok(!text.includes(value), `${id}: ${entry.op} leaked personal data (${value.length > 6 ? `${value.slice(0, 3)}...` : value})`);
  }
  // Text the model wrote, in the response sent back to the caller, must not echo a phone number or an email either.
  for (const res of responses) {
    const modelText = JSON.stringify({ q: res.json?.qualification, reason: res.json?.reason });
    for (const value of forbidden.filter(item => /[@\d]/.test(item))) assert.ok(!modelText.includes(value), `${id}: the response carries model text with ${value.slice(0, 3)}...`);
  }
}

// Records the run created, not counting the seed (the mock starts with 15 contacts, 15 deals and 5 CSR tasks).
const createdTasks = state => state.tasks.slice(state.seeded.tasks);
const createdDeals = state => state.deals.slice(state.seeded.deals);

// What actually exists in the mock after a scenario, not just which calls were made.
// Contacts, deals and tasks are counted beyond the seed (the mock starts with 15 contacts, 15 deals and 5 CSR tasks).
function assertState(id, expectedState, state, eventId) {
  const actual = {
    contacts: state.contacts.length - state.seeded.contacts, deals: state.deals.length - state.seeded.deals, tasks: state.tasks.length - state.seeded.tasks, drafts: state.drafts.length,
    slack_messages: state.slack_messages.length, sheet_rows: state.sheet_rows.length,
  };
  const wanted = { ...expectedState };
  const ledgerState = wanted.ledger;
  delete wanted.ledger;
  assert.deepEqual(actual, wanted, `${id}: the mock's state (records that exist)`);
  const entries = state.ledger.filter(item => item.event_id === eventId);
  if (ledgerState === null) assert.equal(state.ledger.length, 0, `${id}: no ledger entry expected`);
  else assert.deepEqual(entries.map(item => item.state), [ledgerState], `${id}: the ledger holds the event as ${ledgerState}`);
}

// Scenario-specific deep assertions on the vendor requests (the declarative part lives in scenarios.json).
const deepChecks = {
  termite_fl_new({ res, log, payload, state, now }) {
    const deal = opsOf(log, 'hubspot.create_deal')[0].body.properties;
    assert.equal(deal.dealstage, 'ridgeway_new_lead', 'deal is created in the New lead stage');
    assert.equal(deal.amount, '1200');
    const patch = opsOf(log, 'hubspot.update_deal')[0];
    assert.equal(patch.body.properties.dealstage, 'ridgeway_needs_approval');
    assert.equal(patch.path, `/hubspot/crm/v3/objects/deals/${res.json.hubspot.deal_id}`);
    const slack = opsOf(log, 'slack.post_message')[0].body;
    assert.equal(slack.channel, '#leads');
    const actions = slack.blocks.find(block => block.type === 'actions');
    assert.deepEqual(actions.elements.map(e => e.action_id), ['approve_lead', 'hold_lead'], 'Approve/Hold buttons');
    assert.deepEqual(actions.elements.map(e => e.value), [payload.event_id, payload.event_id], 'the buttons carry the event id and nothing else');
    // ClickUp custom fields, ids from the Settings tab of the rules sheet: Jacksonville, termites, high, the deal link, callback by.
    const fields = Object.fromEntries((opsOf(log, 'clickup.create_task')[0].body.custom_fields ?? []).map(field => [field.id, field.value]));
    assert.deepEqual(fields, {
      'cf-branch-7a1': 'b1', 'cf-pest-7a2': 'p4', 'cf-urgency-7a3': 'u2',
      'cf-deal-link-7a4': `https://app.hubspot.example/contacts/0000000/record/0-3/${res.json.hubspot.deal_id}`,
      'cf-callback-by-7a5': Date.parse(now) + 4 * 3600000,
    }, 'the CSR task fills the five custom fields with option ids, the deal link and the callback deadline');
    const stored = state.tasks.find(task => task.id === res.json.clickup_task_id);
    assert.deepEqual(stored.custom_fields.map(field => field.name), ['Branch', 'Pest', 'Urgency', 'HubSpot deal link', 'Callback by'], 'the mock stored them against the list\'s fields');
    // The ledger keeps the ids the Approve / Hold workflow looks up, and the summary without its buttons.
    const refs = state.ledger.find(item => item.event_id === payload.event_id).refs;
    assert.deepEqual([refs.deal_id, refs.clickup_task_id, refs.timezone, refs.slack.channel], [res.json.hubspot.deal_id, res.json.clickup_task_id, 'America/New_York', 'C0MOCKLEADS']);
    assert.ok(refs.slack.blocks.length > 0 && !refs.slack.blocks.some(block => block.type === 'actions'), 'stored blocks have no buttons');
    const draft = decodeDraft(opsOf(log, 'gmail.create_draft')[0]);
    assert.match(draft, /^To: malik\.hendricks@gmail\.example/m);
    assert.deepEqual(res.json.outreach.sms, { proposed: false, text: null, omitted_reason: 'no_sms_consent' });
    assert.ok(res.json.slots.length > 0 && res.json.slots.length <= 3);
    const task = opsOf(log, 'clickup.create_task')[0].body;
    assert.match(task.description, /Approval needed because: .*pest_type:termites/);
    assert.match(task.description, /SMS: not proposed \(no_sms_consent\)/);
    assert.match(task.description, /app\.hubspot\.example\/contacts\/0000000\/record\/0-1\/\d+/, 'CSR task links to the HubSpot contact');
    const contact = opsOf(log, 'hubspot.create_contact')[0].body.properties;
    assert.equal(contact.ridgeway_last_inquiry.slice(0, 22), payload.fields['5'].slice(0, 22), 'original message stays in the CRM');
    assert.deepEqual([contact.address, contact.city, contact.state, contact.zip], ['2218 Cutler Marsh Rd', 'Jacksonville', 'FL', '32207'], 'the service address lives in the CRM');
  },
  ants_ga_recurring({ res, log, now }) {
    const today = localDate(now, 'America/New_York');
    assert.equal(res.json.slots.length, 3);
    assert.equal(new Set(res.json.slots.map(slot => slot.date)).size, 3, 'slots spread over three different days');
    for (const slot of res.json.slots) assert.ok(slot.date >= today && slot.date <= addDays(today, 7), `slot ${slot.date} outside the 7-day window`);
    assert.equal(res.json.outreach.sms.proposed, true);
    assert.match(res.json.outreach.sms.text, /Reply STOP to opt out\.$/);
    const spotQuery = opsOf(log, 'fieldroutes.search_spots')[0].query;
    assert.deepEqual([spotQuery.dateStart, spotQuery.dateEnd, spotQuery.officeIDs], [today, addDays(today, 7), '[2]']);
    assert.match(decodeDraft(opsOf(log, 'gmail.create_draft')[0]), new RegExp(res.json.slots[0].label));
    assert.equal(opsOf(log, 'hubspot.update_deal').length, 0, 'auto-proposed deals stay in New lead');
    assert.equal(opsOf(log, 'clickup.create_task')[0].body.tags.join(), 'lead');
    assert.deepEqual(opsOf(log, 'sheets.get_values').map(e => e.path.split('/values/')[1]), ['Settings!A2:B', 'Service area!A2:F', 'Pricing!A2:D'], 'every rule is read from the ops rules sheet, settings first');
    const lookup = opsOf(log, 'hubspot.get_deal');
    assert.equal(lookup.length, 1, 'the deal is read by ridgeway_event_id before it is created');
    assert.deepEqual([lookup[0].path, lookup[0].query.idProperty, lookup[0].status], ['/hubspot/crm/v3/objects/deals/evt-ants-ga-002', 'ridgeway_event_id', 404], 'a GET by the unique property, 404 when there is none (no search)');
    assert.equal(opsOf(log, 'hubspot.search_deals').length, 0);
    assert.equal(res.json.hubspot.deal_reused, false);
    const search = opsOf(log, 'hubspot.search_contacts')[0].body.filterGroups.map(group => group.filters[0].value);
    assert.deepEqual(search, ['ayesha.rahman@gmail.example', '+19125550163', '9125550163'], 'email, then the phone as typed and without the country code');
  },
  existing_customer_al({ res, log }) {
    assert.equal(res.json.hubspot.deal_id, null);
    assert.equal(res.json.hubspot.contact_id, null);
    const task = opsOf(log, 'clickup.create_task')[0].body;
    assert.match(task.name, /existing customer #53002/);
    assert.deepEqual(task.tags, ['service-request']);
    assert.equal(opsOf(log, 'fieldroutes.search_customers')[0].query.phone, '2515550179');
  },
  out_of_area({ res, log }) {
    assert.equal(opsOf(log, 'hubspot.create_contact')[0].body.properties.ridgeway_tags, 'out-of-area');
    assert.equal(res.json.hubspot.deal_id, null);
    assert.match(opsOf(log, 'slack.post_message')[0].body.text, /Out-of-area lead \(ZIP 32301\)/);
  },
  bad_signature({ log }) {
    assert.equal(log.length, 0, 'an unauthenticated request must cause no vendor calls, including Anthropic');
  },
  invalid_payload({ res, log }) {
    assert.equal(log.length, 0);
    assert.match(res.json.errors.join(' '), /phone number or email/);
  },
  vague_low_confidence({ res, log }) {
    assert.match(res.json.reason, /^low_confidence/);
    assert.match(opsOf(log, 'clickup.create_task')[0].body.name, /^Review lead: Brianna, ZIP 32216/);
    assert.match(opsOf(log, 'clickup.create_task')[0].body.description, /original message are here/);
  },
  malformed_llm({ res, log }) {
    assert.match(res.json.reason, /^invalid_output: .*pest_type is not an allowed value/);
    assert.match(opsOf(log, 'clickup.create_task')[0].body.name, /^Review lead: Odalys, ZIP 31401/);
    assert.equal(opsOf(log, 'anthropic.messages')[0].recording.synthetic, true);
  },
  gmail_down({ res, log }) {
    assert.deepEqual(opsOf(log, 'gmail.create_draft').map(entry => entry.status), [503, 503, 503, 503], 'Gmail was tried 4 times');
    const task = opsOf(log, 'clickup.create_task')[0].body.description;
    assert.match(task, /Email draft: FAILED, no draft was created/);
    assert.ok(!/created in Gmail/.test(task), 'the CSR task must not claim a draft exists');
    assert.equal(res.json.outreach.email.draft_id, null);
    assert.match(res.json.outreach.email.error, /503/);
    assert.ok(res.json.clickup_task_id, 'the booking completed');
  },
  stale_timestamp({ log }) {
    assert.equal(log.length, 0, 'a stale request causes no vendor calls, not even the ledger');
  },
  future_timestamp({ log }) {
    assert.equal(log.length, 0);
  },
  async pretty_printed_unicode_body({ log, payload, now }) {
    const contact = opsOf(log, 'hubspot.create_contact')[0].body.properties;
    assert.equal(contact.lastname, 'Peña', 'the non-ASCII name arrived intact');
    // The same pretty-printed bytes, but signed over the compact re-serialization: the hash covers the raw bytes.
    const before = (await mockLog()).length;
    const wrong = await sendLead(payload, { now, pretty: true, signedBody: JSON.stringify(payload) });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error, 'signature_mismatch');
    assert.equal((await mockLog()).length, before, 'the refused request caused no vendor calls');
  },
  pii_in_model_output({ res, log }) {
    assert.equal(res.json.qualification.summary, 'Caller can be reached at [phone removed] or [email removed] about ants on the kitchen counter and wants a one-time treatment.');
    assert.deepEqual(res.json.qualification.red_flags, ['[email removed]', 'call_[phone removed]', '[phone removed]']);
    const csr = opsOf(log, 'clickup.create_task')[0].body.description;
    assert.match(csr, /Summary: Caller can be reached at \[phone removed\] or \[email removed\]/);
    assert.match(csr, /Red flags: \[email removed\], call_\[phone removed\], \[phone removed\]/);
    const slack = JSON.stringify(opsOf(log, 'slack.post_message')[0].body);
    assert.ok(slack.includes('[phone removed]') && slack.includes('[email removed]'), 'the Slack summary shows the redacted text');
    // the customer's own message, with their number and email, is still stored in the CRM where it belongs
    assert.match(opsOf(log, 'hubspot.create_contact')[0].body.properties.ridgeway_last_inquiry, /\(904\) 555-0188 or email jo\.rivera@mail\.example/);
  },
  hubspot_429({ res, log }) {
    assert.deepEqual(opsOf(log, 'hubspot.search_contacts').map(entry => entry.status), [429, 429, 200], 'two rate limits then success');
    assert.equal(opsOf(log, 'hubspot.update_contact')[0].path, '/hubspot/crm/v3/objects/contacts/5001');
    assert.equal(opsOf(log, 'hubspot.create_contact').length, 0);
    assert.equal(res.json.hubspot.contact_id, '5001');
  },
  fieldroutes_down({ res, log }) {
    assert.deepEqual(opsOf(log, 'fieldroutes.search_spots').map(entry => entry.status), [503, 503, 503, 503], '3 retries after the first try');
    assert.deepEqual(res.json.slots, []);
    assert.ok(res.json.warnings.includes('fieldroutes_availability_unavailable'));
    const tasks = opsOf(log, 'clickup.create_task').map(entry => entry.body);
    assert.ok(tasks.some(task => /^Call back to book/.test(task.name) && task.tags.includes('callback-to-book')), 'callback task');
    const slackTexts = opsOf(log, 'slack.post_message').map(entry => entry.body.text);
    assert.ok(slackTexts.some(text => /FieldRoutes availability search failed/.test(text)), 'Slack warning');
    assert.equal(opsOf(log, 'hubspot.update_deal').length, 0);
  },
  clickup_timeout_after_commit({ res, log, state, elapsed_ms }) {
    const attempts = opsOf(log, 'clickup.create_task');
    assert.equal(attempts.length, 2, 'the first answer arrived after the node timeout, so n8n retried');
    assert.equal(attempts[0].idempotency_key, attempts[1].idempotency_key, 'the retry carries the same Idempotency-Key');
    assert.equal(attempts[0].idempotency_key, 'evt-clickup-timeout-014:Create ClickUp CSR task', 'the key is <event id>:<node name>');
    assert.equal(attempts[0].run_id, attempts[1].run_id, 'both attempts belong to the same execution');
    assert.equal(attempts[0].fault, 'injected_after_commit', 'the first use carried the injected after-commit fault');
    assert.equal(attempts[1].idempotent_replay, true, 'the mock answered the repeat from the original commit');
    assert.equal(createdTasks(state).length, 1, 'exactly one ClickUp task exists');
    assert.equal(res.json.clickup_task_id, createdTasks(state)[0].id, 'the run continued with the original task');
    assert.ok(elapsed_ms >= 14000, `a timeout plus a 5 second wait is expected (${elapsed_ms} ms)`);
  },
  slack_rate_limited({ log }) {
    const posts = opsOf(log, 'slack.post_message');
    assert.deepEqual(posts.map(entry => entry.status), [429, 200], 'one 429, then the retry posts');
    assert.equal(posts[0].idempotency_key, posts[1].idempotency_key, 'the retry carries the same key (Slack ignores it; the mock honors it)');
    assert.ok(posts[1].at_ms - posts[0].at_ms >= 4500, `n8n waited its fixed 5 s, longer than Retry-After: 1 (${posts[1].at_ms - posts[0].at_ms} ms)`);
  },
  deal_create_conflict_after_timeout({ res, log, state, elapsed_ms }) {
    const creates = opsOf(log, 'hubspot.create_deal');
    assert.deepEqual(creates.map(entry => entry.status), [201, 409, 409, 409], 'the first create committed (answer lost), the retries conflict on ridgeway_event_id');
    assert.equal(creates[0].fault, 'injected_after_commit');
    assert.equal(new Set(creates.map(entry => entry.idempotency_key)).size, 1, 'every try carries the same key (HubSpot ignores it, like the mock here)');
    assert.deepEqual(opsOf(log, 'hubspot.get_deal').map(entry => entry.status), [404, 200], 'read before the create (none), and after the conflict (the committed one)');
    assert.equal(createdDeals(state).length, 1, 'exactly one deal');
    assert.equal(res.json.hubspot.deal_id, createdDeals(state)[0].id, 'the run went on with the deal the first try created');
    assert.equal(opsOf(log, 'hubspot.associate_deal_contact')[0].path, `/hubspot/crm/v4/objects/deals/${res.json.hubspot.deal_id}/associations/default/contacts/${res.json.hubspot.contact_id}`);
    assert.ok(elapsed_ms >= 20000, `a timeout plus three 5-second waits is expected (${elapsed_ms} ms)`);
  },
  existing_email_contact_create({ res, log, state }) {
    assert.equal(opsOf(log, 'hubspot.search_contacts')[0].status, 200);
    assert.deepEqual(opsOf(log, 'hubspot.create_contact').map(entry => entry.status), [409, 409, 409, 409], 'refused: the email exists (n8n retries a 409 like any error)');
    const read = opsOf(log, 'hubspot.get_contact')[0];
    assert.deepEqual([read.path, read.query.idProperty, read.status], ['/hubspot/crm/v3/objects/contacts/malik.hendricks@gmail.example', 'email', 200], 'read by email, a unique identifier');
    const update = opsOf(log, 'hubspot.update_contact')[0];
    assert.equal(update.path, '/hubspot/crm/v3/objects/contacts/5002');
    assert.ok(!('firstname' in update.body.properties), 'an existing contact keeps its name and address');
    assert.equal(state.contacts.filter(contact => contact.properties.email === 'malik.hendricks@gmail.example').length, 1, 'no second contact');
    assert.equal(res.json.hubspot.contact_id, '5002');
  },
  emergency_commercial({ res, log, now }) {
    const today = localDate(now, 'America/Chicago');
    assert.ok(res.json.slots.length > 0, 'emergency leads get slots');
    for (const slot of res.json.slots) assert.ok([today, addDays(today, 1)].includes(slot.date), `emergency slot ${slot.date} is not today/tomorrow`);
    // The test clock reads 08:33 in Mobile (America/Chicago). The earliest open slot at least an hour away is 10:00 local.
    // Read as Eastern, 10:00 would be 09:00 Mobile time, inside the hour, and be skipped, so the first slot would be later.
    assert.deepEqual([res.json.slots[0].date, res.json.slots[0].start], [today, '10:00:00'], 'the Chicago window is applied end to end');
    const query = opsOf(log, 'fieldroutes.search_spots')[0].query;
    assert.deepEqual([query.dateStart, query.dateEnd, query.officeIDs], [today, addDays(today, 1), '[3]']);
    assert.equal(opsOf(log, 'hubspot.update_deal')[0].body.properties.dealstage, 'ridgeway_needs_approval');
    assert.match(opsOf(log, 'clickup.create_task')[0].body.description, /commercial_property/);
  },
};

function assertSheetsRow(def, res, log) {
  const rows = opsOf(log, 'sheets.append');
  if (!rows.length) return;
  const row = rows[0].body.values[0];
  assert.equal(row[0], res.json.event_id);
  assert.equal(row[1], isoOf(nowOf(def)));
  assert.ok(row[2] >= row[1], 'finished_at is not before received_at');
  assert.equal(row[7], res.json.status);
  assert.equal(row[3], payloadOf(def).source);
}

async function verifyScenario(def) {
  if (!selected(def.id)) return;
  const outcome = { id: def.id, description: def.description, passed: false, notes: [] };
  outcomes.push(outcome);
  if (live && def.llm === 'synthetic') {
    outcome.skipped = 'hand-written fault injection (needs a synthetic model reply); covered in replay mode only';
    return;
  }
  let run;
  try {
    run = await runScenario(def);
  } catch (error) {
    outcome.error = `request failed before any assertion: ${error.message}`;
    throw error;
  }
  const { res, log } = run;
  outcome.http_status = res.status;
  outcome.state = {
    contacts: run.state.contacts.length - run.state.seeded.contacts, deals: run.state.deals.length - run.state.seeded.deals, tasks: run.state.tasks.length - run.state.seeded.tasks, drafts: run.state.drafts.length,
    slack_messages: run.state.slack_messages.length, sheet_rows: run.state.sheet_rows.length, ledger: run.state.ledger.map(item => item.state),
  };
  outcome.response = res.json;
  outcome.calls = summarizeCalls(log);
  outcome.elapsed_ms = run.elapsed_ms;
  writeFileSync(join(resultsDir, live ? 'live-llm-request-logs' : 'request-logs', `${def.id}.json`), `${JSON.stringify(log, null, 2)}\n`);
  try {
    const llmDependent = live && def.expect.llm_dependent;
    assert.equal(res.status, def.expect.http_status, `${def.id}: HTTP status (body: ${res.text.slice(0, 300)})`);
    assertGlobalSafety(def.id, log, def, { responses: [res] });
    if (llmDependent) {
      outcome.notes.push(`LLM-dependent scenario: observed status ${res.json?.status}`);
    } else {
      matchPartial(res.json, def.expect.body, `${def.id}.body`);
      assert.deepEqual(outcome.calls, def.expect.calls, `${def.id}: vendor call counts`);
      assertState(def.id, def.expect.state, run.state, payloadOf(def).event_id);
      assertSheetsRow(def, res, log);
      await deepChecks[def.id]?.({ ...run, def });
    }
    for (const [field, value] of Object.entries(def.expect.llm_fields ?? {})) {
      if (res.json?.[field] !== value) {
        const message = `LLM field ${field}: expected ${value}, got ${res.json?.[field]}`;
        if (live) outcome.notes.push(message); else assert.fail(`${def.id}: ${message}`);
      }
    }
    outcome.passed = true;
  } catch (error) {
    outcome.error = error.message;
    throw error;
  }
}

async function verifyMissingSignature() {
  if (!selected('missing_signature')) return;
  const outcome = { id: 'missing_signature', description: 'No signature header at all.', passed: false, notes: [] };
  outcomes.push(outcome);
  await control('/__reset');
  const before = bridgeSnapshot();
  const payload = scenarios.find(s => s.id === 'termite_fl_new').payload;
  const now = isoOf(nowOf({ id: 'termite_fl_new', payload_from: 'termite_fl_new' }));
  const res = await fetch(`http://127.0.0.1:${ports.n8n}/webhook/ridgeway/lead`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ridgeway-test-now': now }, body: JSON.stringify(payload),
  });
  await settle();
  const log = [...(await mockLog()), ...bridgeEntries(before)];
  outcome.http_status = res.status;
  outcome.response = await res.json();
  outcome.calls = summarizeCalls(log);
  assert.equal(res.status, 401);
  assert.equal(outcome.response.status, 'unauthorized');
  assert.equal(outcome.response.error, 'missing_signature');
  assert.equal(log.length, 0, 'no vendor calls');
  // A signature without a timestamp header is refused too.
  const body = JSON.stringify(payload);
  const noTimestamp = await fetch(`http://127.0.0.1:${ports.n8n}/webhook/ridgeway/lead`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ridgeway-signature': h.sign(body, secrets.webhook, Math.floor(Date.parse(now) / 1000)), 'x-ridgeway-test-now': now }, body,
  });
  assert.equal(noTimestamp.status, 401);
  assert.equal((await noTimestamp.json()).error, 'missing_timestamp');
  assert.equal((await mockLog()).length, 0, 'still no vendor calls');
  outcome.passed = true;
}

async function verifyReplay() {
  if (!selected('replay_two_deliveries')) return;
  const outcome = { id: 'replay_two_deliveries', description: 'The same signed event is delivered twice in a row.', passed: false, notes: [] };
  outcomes.push(outcome);
  const def = { id: 'replay', payload: checks.replay.payload, expect: checks.replay.expect };
  await control('/__reset');
  const before = bridgeSnapshot();
  const now = nowOf(checks.replay);
  const first = await sendLead(checks.replay.payload, { now });
  await settle();
  const afterFirst = [...(await mockLog()), ...bridgeEntries(before)];
  const second = await sendLead(checks.replay.payload, { now });
  await settle();
  const afterSecond = [...(await mockLog()), ...bridgeEntries(before)];
  outcome.first = { http_status: first.status, status: first.json?.status };
  outcome.second = { http_status: second.status, body: second.json };
  outcome.calls_after_first = summarizeCalls(afterFirst);
  outcome.calls_after_second = summarizeCalls(afterSecond);
  assert.equal(first.status, 200, `replay first delivery: ${first.text.slice(0, 300)}`);
  assert.ok(['auto_proposed', 'approval_required'].includes(first.json.status), `unexpected first status ${first.json.status}`);
  assert.equal(second.status, 200);
  assert.equal(second.json.status, 'duplicate');
  assert.equal(second.json.event_id, checks.replay.payload.event_id);
  assert.deepEqual(afterSecond.slice(afterFirst.length).map(entry => entry.op), ['ledger.claim'], 'the second delivery adds one ledger claim and nothing else');
  assert.equal(opsOf(afterSecond, 'hubspot.create_deal').length, 1, 'exactly one deal');
  assert.equal(opsOf(afterSecond, 'clickup.create_task').length, 1, 'exactly one CSR task');
  assert.equal(opsOf(afterSecond, 'gmail.create_draft').length, 1, 'exactly one Gmail draft');
  assertGlobalSafety('replay', afterSecond, def, { responses: [first, second] });
  assertState('replay', checks.replay.expect.state, await mockState(), checks.replay.payload.event_id);
  outcome.passed = true;
  writeFileSync(join(resultsDir, `${prefix}replay-result.json`), `${JSON.stringify(outcome, null, 2)}\n`);
}

// Polls the mock until `test(state, log)` holds.
async function waitFor(description, test, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [state, log] = await Promise.all([mockState(), mockLog()]);
    if (test(state, log)) return { state, log };
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await sleep(250);
  }
}

async function verifyErrorHandler() {
  if (!selected('error_handler_fires')) return;
  const outcome = { id: 'error_handler_fires', description: 'HubSpot is down for good: the run fails, the error workflow releases the claim, alerts Slack (with the event id) and logs to Sheets.', passed: false, notes: [] };
  outcomes.push(outcome);
  const def = { id: 'error_handler', payload: checks.error_handler.payload, expect: checks.error_handler.expect };
  const eventId = checks.error_handler.payload.event_id;
  await control('/__reset');
  await control('/__control', checks.error_handler.mock);
  const before = bridgeSnapshot();
  const res = await sendLead(checks.error_handler.payload, { now: nowOf(checks.error_handler) });
  await waitFor('the error workflow to post its alert and Errors row', (state, log) => opsOf(log, 'sheets.append').length >= 1 && opsOf(log, 'slack.post_message').length >= 1 && opsOf(log, 'ledger.fail').length >= 1, 60000);
  await settle();
  const log = [...(await mockLog()), ...bridgeEntries(before)];
  const state = await mockState();
  outcome.http_status = res.status;
  outcome.calls = summarizeCalls(log);
  writeFileSync(join(resultsDir, live ? 'live-llm-request-logs' : 'request-logs', 'error_handler_fires.json'), `${JSON.stringify(log, null, 2)}\n`);
  assert.equal(res.status, 500, 'a failed required step surfaces as HTTP 500');
  assert.deepEqual(opsOf(log, 'hubspot.search_contacts').map(entry => entry.status), [500, 500, 500, 500], 'four tries (3 retries) against the failing vendor');
  assert.equal(opsOf(log, 'hubspot.create_contact').length, 0);
  assert.equal(opsOf(log, 'hubspot.create_deal').length, 0);
  // the claim is handed back: failed, with a timestamp, so a redelivery is processed again
  const [claim] = opsOf(log, 'ledger.claim');
  const [release] = opsOf(log, 'ledger.fail');
  assert.equal(release.path, `/ledger/v1/runs/${claim.run_id}/fail`, 'the error workflow releases the claim of the run that failed');
  assert.equal(release.outcome, 'failed');
  const ledgerEntry = state.ledger.find(item => item.event_id === eventId);
  assert.equal(ledgerEntry.state, 'failed');
  assert.match(ledgerEntry.failed_at, /^\d{4}-\d\d-\d\dT/, 'failed with a timestamp');
  assert.ok(!/@|555-0188/.test(ledgerEntry.reason), 'the reason stored in the ledger carries no contact details');
  const slack = opsOf(log, 'slack.post_message');
  assert.equal(slack.length, 1, 'exactly one alert');
  assert.equal(slack[0].body.channel, '#automation-alerts');
  assert.match(slack[0].body.text, /Search HubSpot contact/);
  assert.ok(slack[0].body.text.includes(`event ${eventId}`), 'the alert names the event id');
  assert.ok(!slack[0].body.text.includes(checks.error_handler.payload.email), 'alert carries no customer PII');
  const sheets = opsOf(log, 'sheets.append');
  assert.equal(sheets.length, 1);
  assert.match(sheets[0].path, /values\/Errors!A:F:append$/);
  assert.equal(sheets[0].body.values[0][3], 'Search HubSpot contact');
  assert.equal(sheets[0].body.values[0][5], eventId, 'the Errors row carries the event id');
  assert.equal(opsOf(log, 'gmail.create_draft').length, 0);
  // the error workflow's own writes are keyed by the failed run id
  assertGlobalSafety('error_handler', log, def, { keyPrefixes: [claim.run_id] });
  assertState('error_handler', checks.error_handler.expect.state, state, eventId);
  outcome.passed = true;
  writeFileSync(join(resultsDir, `${prefix}error-handler-result.json`), `${JSON.stringify(outcome, null, 2)}\n`);
}

// A redelivery that arrives while the first run is still going.
async function verifyRedeliveryWhileInFlight() {
  const id = 'redelivery_while_in_flight';
  if (!selected(id)) return;
  const outcome = { id, description: checks[id].description, passed: false, notes: [] };
  outcomes.push(outcome);
  if (live) { outcome.skipped = 'needs the mock to delay the Claude answer; covered in replay mode only'; return; }
  const def = { id, payload: payloadOf(checks[id]), expect: checks[id].expect };
  await control('/__reset');
  await control('/__control', checks[id].mock);
  const now = nowOf(checks[id]);
  const first = sendLead(def.payload, { now }); // not awaited: the Claude answer is held back 5 seconds
  await waitFor('the first run to reach the Claude call', (state, log) => opsOf(log, 'anthropic.messages').length >= 1, 30000);
  const startedSecond = Date.now();
  const second = await sendLead(def.payload, { now });
  outcome.second = { http_status: second.status, body: second.json, retry_after: second.headers['retry-after'], elapsed_ms: Date.now() - startedSecond };
  assert.equal(second.status, 409, `redelivery while in flight: ${second.text.slice(0, 200)}`);
  assert.equal(second.json.status, 'in_flight');
  assert.equal(second.json.event_id, def.payload.event_id);
  assert.equal(second.headers['retry-after'], '30', 'the sender is told when to try again');
  assert.ok(Date.now() - startedSecond < 4000, 'the 409 does not wait for the first run');
  const done = await first;
  assert.equal(done.status, 200, `first run: ${done.text.slice(0, 200)}`);
  assert.ok(['auto_proposed', 'approval_required'].includes(done.json.status));
  await settle();
  const third = await sendLead(def.payload, { now });
  outcome.third = { http_status: third.status, body: third.json };
  assert.equal(third.status, 200);
  assert.equal(third.json.status, 'duplicate');
  await settle();
  const log = await mockLog();
  const state = await mockState();
  outcome.calls = summarizeCalls(log);
  writeFileSync(join(resultsDir, 'request-logs', `${id}.json`), `${JSON.stringify(log, null, 2)}\n`);
  assert.deepEqual(opsOf(log, 'ledger.claim').map(entry => entry.outcome), ['claimed', 'in_flight', 'done'], 'claimed, then in flight, then done');
  assert.equal(opsOf(log, 'anthropic.messages').length, 1, 'only the first run asked Claude');
  assert.equal(opsOf(log, 'hubspot.create_deal').length, 1);
  assert.equal(opsOf(log, 'clickup.create_task').length, 1);
  assertGlobalSafety(id, log, def, { responses: [done, second, third] });
  assertState(id, def.expect.state, state, def.payload.event_id);
  outcome.passed = true;
}

// The first run fails after the deal exists; the redelivery must finish the job without a second deal.
async function verifyRedeliveryAfterFailure() {
  const id = 'redelivery_after_failure';
  if (!selected(id)) return;
  const outcome = { id, description: checks[id].description, passed: false, notes: [] };
  outcomes.push(outcome);
  if (live) { outcome.skipped = 'two live Claude answers would differ and change the keyed request bodies; covered in replay mode only'; return; }
  const def = { id, payload: payloadOf(checks[id]), expect: checks[id].expect };
  const eventId = def.payload.event_id;
  await control('/__reset');
  await control('/__control', checks[id].mock);
  const now = nowOf(checks[id]);
  const first = await sendLead(def.payload, { now });
  outcome.first = { http_status: first.status };
  assert.equal(first.status, 500, `the first run fails at the ClickUp CSR task: ${first.text.slice(0, 200)}`);
  // the error workflow gives the claim back (failed, with a timestamp) before the sender retries
  await waitFor('the claim to be released', (state, log) => state.ledger.some(item => item.event_id === eventId && item.state === 'failed') && opsOf(log, 'sheets.append').length >= 1 && opsOf(log, 'slack.post_message').length >= 1, 60000);
  await settle();
  const afterFailure = await mockState();
  assert.equal(createdDeals(afterFailure).length, 1, 'the deal already exists when the first run dies');
  assert.equal(createdTasks(afterFailure).length, 0);
  const second = await sendLead(def.payload, { now });
  outcome.second = { http_status: second.status, status: second.json?.status, hubspot: second.json?.hubspot };
  assert.equal(second.status, 200, `the redelivery succeeds: ${second.text.slice(0, 200)}`);
  assert.equal(second.json.status, 'approval_required');
  await settle();
  assert.equal(createdDeals(await mockState()).length, 1, 'still exactly one deal after the redelivery (the mock ignores the key on deal creation, so only the lookup prevents a second)');
  assert.equal(second.json.hubspot.deal_reused, true, 'the deal was read by ridgeway_event_id and reused');
  const log = await mockLog();
  const state = await mockState();
  outcome.calls = summarizeCalls(log);
  writeFileSync(join(resultsDir, 'request-logs', `${id}.json`), `${JSON.stringify(log, null, 2)}\n`);
  assert.deepEqual(opsOf(log, 'ledger.claim').map(entry => entry.outcome), ['claimed', 'claimed'], 'the second claim succeeds');
  assert.equal(opsOf(log, 'ledger.claim')[1].run_id === opsOf(log, 'ledger.claim')[0].run_id, false, 'a different execution');
  assert.deepEqual(opsOf(log, 'hubspot.get_deal').map(entry => entry.status), [404, 200], 'read by ridgeway_event_id in both runs: none, then the first run\'s deal');
  assert.equal(opsOf(log, 'hubspot.update_deal').length, 1, 'the second run leaves the deal in Needs approval, where the first run put it');
  assert.equal(opsOf(log, 'hubspot.create_deal').length, 1, 'the deal is created once, in the first run only');
  assert.equal(opsOf(log, 'clickup.create_task').length, 5, 'four failed tries, then the one task');
  assert.equal(createdDeals(state).length, 1);
  assert.equal(createdTasks(state).length, 1);
  // steps the first run completed are replayed by key in the second run, with the same bytes
  const crossRun = opsOf(log, 'gmail.create_draft').filter(entry => entry.idempotent_replay);
  assert.equal(crossRun.length, 1, 'the Gmail draft of the first run was replayed, not created again');
  assert.equal(state.drafts.length, 1);
  const alert = opsOf(log, 'slack.post_message').find(entry => entry.body.channel === '#automation-alerts');
  assert.ok(alert.body.text.includes(`event ${eventId}`), 'the alert for the failed run names the event id');
  assertGlobalSafety(id, log, def, { allowCrossRun: true, keyPrefixes: [eventId, opsOf(log, 'ledger.claim')[0].run_id], responses: [second] });
  assertState(id, def.expect.state, state, eventId);
  outcome.passed = true;
}

// ------------------------------------------------------------------ Approve / Hold from Slack (workflow "Handle approval")

// Each check books the termite lead (approval_required) through the lead workflow, then POSTs signed clicks to
// /webhook/ridgeway/slack-action exactly as slack-relay/relay.mjs forwards them: ids only.
const approval = checks.approval;
const approvalLead = () => payloadOf(approval);

async function bookApprovalLead() {
  await control('/__reset');
  const res = await sendLead(approvalLead(), { now: nowOf(approval) });
  assert.equal(res.status, 200, `booking the lead: ${res.text.slice(0, 200)}`);
  assert.equal(res.json.status, 'approval_required');
  await settle();
  const entry = (await mockState()).ledger.find(item => item.event_id === approvalLead().event_id);
  assert.equal(entry.state, 'done');
  assert.ok(entry.refs?.slack?.ts, 'the ledger knows the Slack message');
  return { res, refs: entry.refs, logLength: (await mockLog()).length };
}

function clickOf(refs, overrides = {}) {
  const at = Date.parse(nowOf(approval)) + approval.click_after_minutes * 60000;
  return {
    team_id: approval.team_id, action_id: 'approve_lead', value: approvalLead().event_id, user_id: approval.approvers[0],
    channel_id: refs.slack.channel, message_ts: refs.slack.ts, action_ts: `${Math.floor(at / 1000)}.000100`, retry_attempt: 0, ...overrides,
  };
}

const clickTime = () => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
  .format(new Date(Date.parse(nowOf(approval)) + approval.click_after_minutes * 60000));

async function approvalCheck(id, description, body) {
  if (!selected(id)) return;
  const outcome = { id, description, passed: false, notes: [] };
  outcomes.push(outcome);
  try {
    const booked = await bookApprovalLead();
    await body(booked, outcome);
    const log = await mockLog();
    writeFileSync(join(resultsDir, 'request-logs', `${id}.json`), `${JSON.stringify(log, null, 2)}\n`);
    outcome.calls = summarizeCalls(log.slice(booked.logLength));
    outcome.passed = true;
  } catch (error) {
    outcome.error = error.message;
    throw error;
  }
}

// What one decision must leave behind: the deal stage, one comment on the CSR task, the message without buttons.
async function assertDecided(id, booked, { stage, verb, decision }) {
  const state = await mockState();
  const log = await mockLog();
  const delta = log.slice(booked.logLength);
  assert.equal(state.deals.find(deal => deal.id === booked.refs.deal_id).properties.dealstage, stage, `${id}: deal stage`);
  const task = state.tasks.find(item => item.id === booked.refs.clickup_task_id);
  assert.equal(task.comments?.length, 1, `${id}: one comment on the CSR task`);
  assert.match(task.comments[0].comment_text, new RegExp(`^${verb} in Slack by user ${approval.approvers[0]} at ${clickTime()}\\.`));
  const message = state.slack_messages.find(item => item.ts === booked.refs.slack.ts);
  assert.ok(!message.blocks.some(block => block.type === 'actions'), `${id}: the buttons are gone`);
  assert.equal(message.blocks.at(-1).text.text, `*${verb}* by <@${approval.approvers[0]}> at ${clickTime()}`);
  assert.deepEqual(message.blocks.slice(0, -1), booked.refs.slack.blocks, `${id}: the rest of the summary is unchanged`);
  const entry = state.ledger.find(item => item.event_id === approvalLead().event_id);
  assert.deepEqual([entry.decision.state, entry.decision.decision, entry.decision.user_id], ['done', decision, approval.approvers[0]]);
  // n8n passes ids: the deal and task come from the ledger, the writes carry <event id>:<node name> and X-Run-Id.
  assert.equal(opsOf(delta, 'hubspot.update_deal')[0].path, `/hubspot/crm/v3/objects/deals/${booked.refs.deal_id}`);
  assert.equal(opsOf(delta, 'clickup.create_comment')[0].path, `/clickup/api/v2/task/${booked.refs.clickup_task_id}/comment`);
  assertGlobalSafety(id, delta, approval, {});
  assertState(id, approval.expect.state, state, approvalLead().event_id);
  return { state, delta };
}

async function verifyApprovals() {
  await approvalCheck('approve_lead', 'An approver clicks Approve: deal Needs approval to Approved, a CSR task comment, the message updated without buttons.', async (booked, outcome) => {
    const res = await h.sendAction(clickOf(booked.refs));
    outcome.http_status = res.status;
    outcome.response = res.json;
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.deepEqual([res.json.status, res.json.deal_id, res.json.decided_by, res.json.slack_message_updated], ['approved', booked.refs.deal_id, approval.approvers[0], true]);
    await settle();
    const { delta } = await assertDecided('approve_lead', booked, { stage: 'ridgeway_approved', verb: 'Approved', decision: 'approved' });
    assert.deepEqual(delta.map(entry => entry.op), ['ledger.claim_decision', 'sheets.get_values', 'hubspot.update_deal', 'clickup.create_comment', 'slack.update_message', 'ledger.complete_decision']);
    assert.equal(opsOf(delta, 'sheets.get_values')[0].path.split('/values/')[1], 'Settings!A2:B', 'the stage ids come from the rules sheet');
    assert.deepEqual(opsOf(delta, 'hubspot.update_deal')[0].body, { properties: { dealstage: 'ridgeway_approved' } });
    assert.equal(opsOf(delta, 'hubspot.update_deal')[0].idempotency_key, `${approvalLead().event_id}:Move deal to decided stage`);
  });

  await approvalCheck('hold_lead', 'An approver clicks Hold: deal to On hold, a CSR task comment, the message updated without buttons.', async (booked, outcome) => {
    const res = await h.sendAction(clickOf(booked.refs, { action_id: 'hold_lead' }));
    outcome.http_status = res.status;
    outcome.response = res.json;
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.json.status, 'on_hold');
    await settle();
    const { state } = await assertDecided('hold_lead', booked, { stage: 'ridgeway_on_hold', verb: 'Put on hold', decision: 'on_hold' });
    assert.match(state.tasks.find(item => item.id === booked.refs.clickup_task_id).comments[0].comment_text, /Do not book until a manager follows up/);
  });

  await approvalCheck('approval_repeat_click', 'A second click, a Slack redelivery of the first and a late Hold change nothing: the first decision wins.', async (booked, outcome) => {
    const first = await h.sendAction(clickOf(booked.refs));
    assert.equal(first.json.status, 'approved');
    await settle();
    const afterFirst = (await mockLog()).length;
    const again = await h.sendAction(clickOf(booked.refs));
    const redelivered = await h.sendAction(clickOf(booked.refs, { retry_attempt: 1 }));
    const lateHold = await h.sendAction(clickOf(booked.refs, { action_id: 'hold_lead' }));
    outcome.responses = [again.json, redelivered.json, lateHold.json];
    for (const res of [again, redelivered, lateHold]) {
      assert.equal(res.status, 200);
      assert.deepEqual([res.json.status, res.json.reason], ['already_decided', 'already_approved']);
    }
    await settle();
    const extra = (await mockLog()).slice(afterFirst);
    assert.deepEqual(extra.map(entry => entry.op), ['ledger.claim_decision', 'ledger.claim_decision', 'ledger.claim_decision'], 'the repeats only ask the ledger');
    await assertDecided('approval_repeat_click', booked, { stage: 'ridgeway_approved', verb: 'Approved', decision: 'approved' });
  });

  await approvalCheck('approval_non_approver', 'Someone not on SLACK_APPROVER_IDS clicks Approve: an ephemeral notice to them, nothing else.', async (booked, outcome) => {
    const res = await h.sendAction(clickOf(booked.refs, { user_id: approval.non_approver }));
    outcome.http_status = res.status;
    assert.equal(res.status, 403, res.text.slice(0, 200));
    assert.equal(res.json.status, 'not_approver');
    await settle();
    const state = await mockState();
    const delta = (await mockLog()).slice(booked.logLength);
    assert.deepEqual(delta.map(entry => entry.op), ['slack.post_ephemeral'], 'only the ephemeral notice');
    assert.deepEqual(state.slack_ephemeral.map(item => [item.channel, item.user]), [[booked.refs.slack.channel, approval.non_approver]]);
    assert.equal(state.deals.find(deal => deal.id === booked.refs.deal_id).properties.dealstage, 'ridgeway_needs_approval', 'the deal still waits');
    assert.ok(!state.ledger.find(item => item.event_id === approvalLead().event_id).decision, 'no decision claimed');
    assert.ok(state.slack_messages[0].blocks.some(block => block.type === 'actions'), 'the buttons are still there');
    assertGlobalSafety('approval_non_approver', delta, approval, {});
  });

  await approvalCheck('approval_bad_signature', 'A click signed with the wrong secret, or with a stale timestamp: 401 and no call of any kind.', async (booked, outcome) => {
    const wrong = await h.sendAction(clickOf(booked.refs), { secret: 'not-the-relay-secret' });
    const stale = await h.sendAction(clickOf(booked.refs), { timestampOffset: -400 });
    outcome.responses = [wrong.json, stale.json];
    assert.deepEqual([wrong.status, wrong.json.error], [401, 'signature_mismatch']);
    assert.deepEqual([stale.status, stale.json.error], [401, 'stale_timestamp']);
    await settle();
    assert.equal((await mockLog()).length, booked.logLength, 'zero vendor or ledger calls');
  });

  await approvalCheck('approval_malformed_payload', 'An unknown action, a payload that carries message content, and a missing event id: 400 and no call of any kind.', async (booked, outcome) => {
    const unknown = await h.sendAction(clickOf(booked.refs, { action_id: 'delete_lead' }));
    const content = await h.sendAction({ ...clickOf(booked.refs), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'copied message' } }] });
    const { value, ...noValue } = clickOf(booked.refs);
    const missing = await h.sendAction(noValue);
    outcome.responses = [unknown.json, content.json, missing.json];
    for (const res of [unknown, content, missing]) assert.equal(res.status, 400, res.text.slice(0, 200));
    assert.match(unknown.json.errors.join(' '), /approve_lead or hold_lead/);
    assert.match(content.json.errors.join(' '), /unexpected fields .*blocks/);
    assert.match(missing.json.errors.join(' '), /event id/);
    await settle();
    assert.equal((await mockLog()).length, booked.logLength, 'zero vendor or ledger calls');
  });

  await approvalCheck('approval_after_failure', 'HubSpot is down when the approver clicks: the run fails, the error workflow releases the decision, and the next click completes it once.', async (booked, outcome) => {
    await control('/__control', { faults: [{ op: 'hubspot.update_deal', status: 503, times: 4 }] });
    const first = await h.sendAction(clickOf(booked.refs));
    outcome.first = { http_status: first.status };
    assert.equal(first.status, 500, `the decision run fails at the deal update: ${first.text.slice(0, 200)}`);
    await waitFor('the decision to be released', state => state.ledger.some(item => item.event_id === approvalLead().event_id && item.decision?.state === 'failed'), 60000);
    await settle();
    const released = await mockLog();
    const failedRun = opsOf(released, 'ledger.claim_decision')[0].run_id;
    const alert = opsOf(released, 'slack.post_message').find(entry => entry.body.channel === '#automation-alerts');
    assert.match(alert.body.text, /Handle approval" failed at "Move deal to decided stage"/);
    assert.ok(alert.body.text.includes(`event ${approvalLead().event_id}`), 'the alert names the event id');
    assert.equal(opsOf(released, 'clickup.create_comment').length, 0, 'nothing after the failed step ran');
    const second = await h.sendAction(clickOf(booked.refs));
    outcome.second = { http_status: second.status, status: second.json?.status };
    assert.equal(second.status, 200, second.text.slice(0, 200));
    assert.equal(second.json.status, 'approved');
    await settle();
    const log = await mockLog();
    const delta = log.slice(booked.logLength);
    assert.deepEqual(opsOf(delta, 'ledger.claim_decision').map(entry => entry.outcome), ['claimed', 'claimed']);
    assert.deepEqual(opsOf(delta, 'hubspot.update_deal').map(entry => entry.status), [503, 503, 503, 503, 200]);
    const state = await mockState();
    assert.equal(state.deals.find(deal => deal.id === booked.refs.deal_id).properties.dealstage, 'ridgeway_approved');
    assert.equal(state.tasks.find(item => item.id === booked.refs.clickup_task_id).comments.length, 1);
    assert.equal(state.ledger.find(item => item.event_id === approvalLead().event_id).decision.attempts, 2);
    assertGlobalSafety('approval_after_failure', delta, approval, { allowCrossRun: true, keyPrefixes: [approvalLead().event_id, failedRun] });
    assertState('approval_after_failure', { ...approval.expect.state, slack_messages: 2, sheet_rows: 2 }, state, approvalLead().event_id);
  });
}

// ------------------------------------------------------------------ live-HubSpot parity, against the mock

// What the live-HubSpot mode does, with every HubSpot behaviour the mock knows switched on: a fresh portal (HubSpot's
// own pipeline only, default properties only, unknown properties and stages refused, ridgeway_event_id unique),
// Idempotency-Key ignored on HubSpot writes, .example emails refused. scripts/hubspot-setup.mjs prepares it (dry run
// first, then for real, then again to show it is idempotent); its generated ids go into the rules sheet as in
// simulate-day.mjs --live-hubspot, with the email fallback on. Then the approval lead is booked and approved, and the
// day is "re-run" against the same portal (every other vendor and the ledger start over) with the contact not yet in
// the search index: no second contact, no second deal, and the manager's decision stays.
const HUBSPOT_WRITE_OPS = ['hubspot.create_contact', 'hubspot.update_contact', 'hubspot.create_deal', 'hubspot.update_deal', 'hubspot.associate_deal_contact'];

async function verifyLiveHubspotParity() {
  const id = 'live_hubspot_parity';
  if (!selected(id)) return;
  const outcome = { id, description: 'The live-HubSpot path against a fresh mock portal: setup with generated ids, the email fallback, Approve, and a re-run of the same lead against the same portal without duplicates.', passed: false, notes: [] };
  outcomes.push(outcome);
  try {
    const lead = approvalLead();
    await control('/__reset');
    await control('/__control', { hubspot_portal: 'fresh', hubspot_reject_example_emails: true, ignore_idempotency: HUBSPOT_WRITE_OPS });
    const setup = options => runSetup({ baseUrl: `${h.mock.url}/hubspot`, token: 'pat-' + 'na1-00000000-0000-4000-8000-000000000000' /* fake, split so secret scanners don't flag it */, paceMs: 0, ...options });
    const dry = await setup({ dryRun: true });
    assert.deepEqual(dry.plan.map(item => `${item.kind}:${item.name}`), [
      'group:ridgeway_lead_agent', 'property:ridgeway_lead_status', 'property:ridgeway_tags', 'property:ridgeway_lead_source', 'property:ridgeway_last_inquiry', 'property:ridgeway_pest_type',
      'group:ridgeway_lead_agent', 'property:ridgeway_event_id', 'pipeline:Ridgeway Sales'], 'the dry run plans the group, six properties and the pipeline');
    assert.ok((await mockLog()).every(entry => entry.method === 'GET'), 'the dry run only reads');
    const { portal } = await setup({});
    const again = await setup({});
    assert.deepEqual(again.plan, [], 'a second run creates nothing');
    assert.deepEqual(again.portal.stages, portal.stages, 'and reads back the same ids');
    assert.match(portal.pipeline.id, /^\d+$/, 'the pipeline id is generated');
    for (const stage of Object.values(portal.stages)) assert.match(stage, /^\d+$/, 'stage ids are generated');
    assert.equal(portal.app_url, 'https://app.hubspot.example/contacts/4242424/record');
    const unique = (await mockState()).hubspot.properties.deals.find(def => def.name === 'ridgeway_event_id');
    assert.equal(unique.hasUniqueValue, true, 'ridgeway_event_id is a unique-value property');
    outcome.portal = { pipeline: portal.pipeline.id, stages: portal.stages };
    await control('/__control', { sheet_settings: settingsFromPortal(portal, { emailFallback: true }) });

    const afterSetup = (await mockLog()).length; // the setup script's own calls are not the workflow's
    const first = await sendLead(lead, { now: nowOf(approval) });
    assert.equal(first.status, 200, `booking against the fresh portal: ${first.text.slice(0, 300)}`);
    assert.equal(first.json.status, 'approval_required');
    await settle();
    let state = await mockState();
    const deal = state.deals.find(item => item.id === first.json.hubspot.deal_id);
    assert.deepEqual([deal.properties.pipeline, deal.properties.dealstage], [portal.pipeline.id, portal.stages.needs_approval], 'the deal sits in the generated pipeline, in the generated Needs approval stage');
    const contact = state.contacts.find(item => item.id === first.json.hubspot.contact_id);
    assert.equal(contact.properties.email, 'malik.hendricks+gmail@example.com', 'the email fallback stores an example.com address');
    const task = state.tasks.find(item => item.id === first.json.clickup_task_id);
    assert.ok(task.description.includes(`${portal.app_url}/0-3/${deal.id}`) && task.description.includes(`${portal.app_url}/0-1/${contact.id}`), 'the CSR task links to the portal');
    const firstLog = (await mockLog()).slice(afterSetup);
    assertGlobalSafety(id, firstLog, approval, { responses: [first] });
    assert.ok(!JSON.stringify(opsOf(firstLog, 'slack.post_message').map(entry => entry.body)).includes('example.com'), 'the mapped address stays in HubSpot');

    const refs = state.ledger.find(item => item.event_id === lead.event_id).refs;
    const click = await h.sendAction(clickOf(refs));
    assert.equal(click.status, 200, click.text.slice(0, 300));
    state = await mockState();
    assert.equal(state.deals.find(item => item.id === deal.id).properties.dealstage, portal.stages.approved, 'Approve moves the deal to the generated Approved stage');

    // The day again, against the same portal: a new ledger and new mocks for everything else, the contact not yet searchable.
    const before = (await mockLog()).length;
    await control('/__control', { new_day: true, hubspot_search_hidden: [contact.id] });
    const rerun = await sendLead(lead, { now: nowOf(approval) });
    assert.equal(rerun.status, 200, `the re-run: ${rerun.text.slice(0, 300)}`);
    await settle();
    state = await mockState();
    const delta = (await mockLog()).slice(before);
    outcome.rerun = { status: rerun.json.status, warnings: rerun.json.warnings, calls: summarizeCalls(delta) };
    assert.deepEqual([state.contacts.length, state.deals.length], [1, 1], 'no second contact and no second deal in the portal');
    assert.deepEqual([rerun.json.hubspot.contact_id, rerun.json.hubspot.deal_id, rerun.json.hubspot.deal_reused], [contact.id, deal.id, true]);
    assert.deepEqual(opsOf(delta, 'hubspot.create_contact').map(entry => entry.status), [409, 409, 409, 409], 'the contact create conflicts on the email');
    assert.ok(rerun.json.warnings.includes('hubspot_contact_create_conflict'));
    assert.equal(opsOf(delta, 'hubspot.create_deal').length, 0, 'the deal is read by ridgeway_event_id, never created again');
    assert.equal(state.deals[0].properties.dealstage, portal.stages.approved, 'the manager\'s decision stays: the re-run does not move the deal back');
    assertGlobalSafety(id, delta, approval, { allowCrossRun: true, responses: [rerun] });
    writeFileSync(join(resultsDir, 'request-logs', `${id}.json`), `${JSON.stringify(await mockLog(), null, 2)}\n`);
    outcome.passed = true;
  } catch (error) {
    outcome.error = error.message;
    throw error;
  }
}

// With saveDataSuccessExecution "none", n8n 2.42.6 still writes the first row of every execution (the webhook
// payload, so the lead) and soft-deletes it when the run succeeds; the pruner hard-deletes it later. Failed runs
// stay saved, with their data. Reads n8n's SQLite file after n8n has stopped.
async function verifyExecutionHistory() {
  if (only) return;
  const outcome = { id: 'execution_history_has_no_lead_data', description: 'saveDataSuccessExecution is none: no successful run of the main workflow is left visible in the execution history (all are soft-deleted, most already hard-deleted by the pruner); the failed runs are kept with their data.', passed: false, notes: [] };
  outcomes.push(outcome);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(userFolder, '.n8n', 'database.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT e.id AS id, e.status AS status, e.workflowId AS workflow, e.deletedAt AS deleted_at, d.data AS data FROM execution_entity e LEFT JOIN execution_data d ON d.executionId = e.id').all();
    const highestId = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'execution_entity'").get().seq;
    const main = rows.filter(row => row.workflow === MAIN_ID);
    const visible = main.filter(row => row.deleted_at === null);
    const leftovers = main.filter(row => row.deleted_at !== null);
    outcome.executions = {
      created: highestId, remaining_rows: rows.length, main_workflow_rows: main.length, visible_rows: visible.length,
      visible_statuses: Object.fromEntries([...new Set(visible.map(row => row.status))].map(status => [status, visible.filter(row => row.status === status).length])),
      soft_deleted_leftovers: leftovers.length, hard_deleted_by_pruner: highestId - rows.length,
    };
    assert.deepEqual([...new Set(visible.map(row => row.status))], ['error'], `only failed runs of the main workflow are visible (saw ${JSON.stringify(outcome.executions.visible_statuses)})`);
    assert.ok(visible.length >= 2, `the failed runs are kept (found ${visible.length}: the error handler check and the first run of redelivery_after_failure)`);
    assert.ok(visible.every(row => /@[\w-]+\.example/.test(row.data ?? '')), 'with their data, so they can be debugged');
    assert.ok(highestId - rows.length >= 1, 'the pruner hard-deleted at least one soft-deleted execution during the run');
    outcome.notes.push(`${leftovers.length} soft-deleted leftovers not yet pruned when n8n stopped`);
  } finally {
    db.close();
  }
  outcome.passed = true;
}

// A throwaway workflow, imported into the temp n8n only (it is not part of the demo), whose Code node reports which
// of the given environment variable names a workflow can read. That is the exposure N8N_BLOCK_ENV_ACCESS_IN_NODE=false
// creates, observed from inside n8n. We ask about every variable this process has (and a canary): none outside the
// allowlist may be visible.
const PROBE_ID = 'pestEnvProbe0001';
const probeWorkflow = {
  id: PROBE_ID, name: 'Env probe (test only)', active: false, pinData: {}, tags: [], settings: { executionOrder: 'v1' },
  nodes: [
    { id: '5c1d2f60-0000-4000-8000-000000000001', name: 'Receive probe', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: '5c1d2f60-0000-4000-8000-000000000002',
      parameters: { httpMethod: 'GET', path: 'probe/env', responseMode: 'lastNode', options: {} } },
    { id: '5c1d2f60-0000-4000-8000-000000000003', name: 'List visible variables', type: 'n8n-nodes-base.code', typeVersion: 2, position: [240, 0],
      parameters: { mode: 'runOnceForAllItems', jsCode: "const asked = String($input.first().json.query.names || '').split(',').filter(Boolean);\nreturn [{ json: { visible: asked.filter(name => $env[name] !== undefined) } }];" } },
  ],
  connections: { 'Receive probe': { main: [[{ node: 'List visible variables', type: 'main', index: 0 }]] } },
};

async function assertAllowlistedEnvironment() {
  const allowed = new Set([...Object.keys(buildN8nEnv({}, { PATH: 1, HOME: 1, TMPDIR: 1, LANG: 1 })), ...DEMO_VARIABLES]);
  const asked = [...new Set([...Object.keys(process.env), ...DEMO_VARIABLES, 'PEST_DEMO_ENV_CANARY'])];
  const res = await fetch(`http://127.0.0.1:${ports.n8n}/webhook/probe/env?names=${encodeURIComponent(asked.join(','))}`, { signal: AbortSignal.timeout(60000) });
  assert.equal(res.status, 200, `the env probe answers (${res.status})`);
  const { visible } = await res.json();
  // PWD and SHLVL are set by the sh shim that launches n8n, __CF_USER_TEXT_ENCODING by macOS on exec: not inherited.
  const addedByTheLauncher = ['PWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING'];
  const leaked = visible.filter(name => !allowed.has(name) && !name.startsWith('N8N_') && !addedByTheLauncher.includes(name));
  assert.deepEqual(leaked, [], 'a workflow can read variables that are not on the allowlist');
  assert.ok(!visible.includes('PEST_DEMO_ENV_CANARY'), 'the canary set in the runner reached n8n');
  assert.ok(visible.includes('LEAD_WEBHOOK_SECRET') && visible.includes('HUBSPOT_TOKEN'), 'sanity: the probe does see the allowlisted secrets (the exposure the README warns about)');
  outcomes.push({ id: 'n8n_environment_allowlist', description: 'A workflow can read only allowlisted variables: of the runner process\'s variables and a canary, none outside the allowlist is visible to n8n.', passed: true, notes: [`asked about ${asked.length} variable names, ${visible.length} visible`] });
}

const tally = list => ({ passed: list.filter(o => o.passed).length, skipped: list.filter(o => o.skipped).length, failed: list.filter(o => !o.passed && !o.skipped).length, total: list.length });

// ------------------------------------------------------------------ main

let failure = null;
try {
  const version = h.prepareWorkflows();
  const pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
  const claudeVersion = live ? spawnSync(process.env.CLAUDE_BRIDGE_CLI || 'claude', ['--version'], { encoding: 'utf8' }).stdout.trim() : null;
  writeFileSync(join(resultsDir, `${prefix}runtime-version.txt`), `n8n ${version} (${n8nCommand.label})\nNode ${process.version}\npnpm ${pnpmVersion}\n${claudeVersion ? `Claude Code CLI ${claudeVersion}\n` : ''}`);

  writeFileSync(join(userFolder, 'env-probe.json'), JSON.stringify(probeWorkflow));
  n8nCli(['import:workflow', '--input', join(userFolder, 'env-probe.json')]);
  n8nCli(['publish:workflow', `--id=${PROBE_ID}`]);
  h.importWorkflows();

  await h.start({ approvers: approval.approvers.join(',') });
  await assertAllowlistedEnvironment();

  for (const def of scenarios) await verifyScenario(def);
  await verifyMissingSignature();
  await verifyReplay();
  await verifyErrorHandler();
  await verifyRedeliveryWhileInFlight();
  await verifyRedeliveryAfterFailure();
  await verifyApprovals();
  await verifyLiveHubspotParity();
} catch (error) {
  failure = error;
} finally {
  await h.stop().catch(() => {});
  if (!failure) {
    try { await verifyExecutionHistory(); } catch (error) { failure = error; }
  }
  const serverLog = h.serverLog();
  writeFileSync(join(resultsDir, `${prefix}n8n-server.log.txt`), serverLog.split('\n').filter(line => !/migration|deprecat|^\s*- N8N_/i.test(line)).join('\n'));
  const resultFile = `${JSON.stringify({ mode: live ? 'live-llm (Claude Code bridge)' : 'replay (recorded Claude responses)', run_at: new Date().toISOString(), test_now: TEST_NOW, n8n: N8N_VERSION, only: onlyArg, result: failure ? 'failed' : 'passed', summary: tally(outcomes), outcomes }, null, 2)}\n`;
  writeFileSync(join(resultsDir, `${prefix}scenario-results.json`), resultFile);
  // A timestamped copy of every complete run, so the evidence of each clean run is kept (results/runs/).
  if (!only) {
    mkdirSync(join(resultsDir, 'runs'), { recursive: true });
    writeFileSync(join(resultsDir, 'runs', `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${live ? 'live-llm' : 'replay'}-${failure ? 'FAILED' : 'passed'}.json`), resultFile);
  }
  h.cleanup();
  if (!failure) {
    const n8nLine = `${n8nCommand.label}`;
    writeFileSync(join(resultsDir, `${prefix}runtime-commands.txt`), [
      '# Run from pest-lead-agent/ (tests/verify.mjs does all of this with a temp N8N_USER_FOLDER and free ports)',
      'node workflow/build-workflow.mjs',
      'export N8N_USER_FOLDER="$(mktemp -d)"',
      `${n8nLine} --version                     # must print ${N8N_VERSION}`,
      `${n8nLine} import:workflow --input workflow/alert-on-errors.json`,
      `${n8nLine} import:workflow --input workflow/book-new-lead.json`,
      `${n8nLine} import:workflow --input workflow/handle-approval.json`,
      `${n8nLine} publish:workflow --id=${ERROR_ID}`,
      `${n8nLine} publish:workflow --id=${MAIN_ID}`,
      `${n8nLine} publish:workflow --id=${APPROVAL_ID}`,
      '# env: n8n is started with an allowlisted environment (tests/n8n-env.mjs; start.sh does the same with env -i): PATH HOME TMPDIR LANG,',
      '#   N8N_* settings, *_BASE_URL -> local mock, dummy tokens, EVENT_LEDGER_*, LEAD_WEBHOOK_SECRET, RIDGEWAY_TEST_MODE=true, OPS_RULES_SHEET_ID,',
      '#   N8N_BLOCK_ENV_ACCESS_IN_NODE=false (lets any workflow read the whole environment: hence the allowlist), NODE_FUNCTION_ALLOW_BUILTIN=crypto',
      `${n8nLine} start                        # publish only takes effect on (re)start`,
      "# sign: sha256 HMAC of \"<timestamp>.<raw body>\" with LEAD_WEBHOOK_SECRET; send the timestamp (Unix seconds) in x-ridgeway-timestamp",
      "curl -X POST http://127.0.0.1:$N8N_PORT/webhook/ridgeway/lead -H 'x-ridgeway-signature: sha256=<hmac>' -H 'x-ridgeway-timestamp: <unix seconds>' --data-binary @payload.json",
      "# Approve / Hold: the same signature with SLACK_RELAY_SECRET over the relay's ids-only body, POST /webhook/ridgeway/slack-action (slack-relay/relay.mjs does this)",
      live ? 'node tests/verify.mjs --live-llm' : 'node tests/verify.mjs',
      '',
    ].join('\n'));
  }
}

const summary = tally(outcomes);
if (failure) {
  console.error(`FAIL: ${failure.message}`);
  for (const outcome of outcomes) console.error(`  ${outcome.skipped ? 'skip' : outcome.passed ? 'ok  ' : 'FAIL'} ${outcome.id}${outcome.error ? `: ${outcome.error.split('\n')[0]}` : ''}`);
  console.error(`${summary.passed} passed, ${summary.skipped} skipped, ${summary.failed} failed of ${summary.total} (stopped at the first failure)`);
  process.exitCode = 1;
} else {
  for (const outcome of outcomes) console.log(`${outcome.skipped ? 'skip' : 'ok  '} ${outcome.id}${outcome.skipped ? ` (${outcome.skipped})` : ''}${outcome.notes.length ? ` [${outcome.notes.join('; ')}]` : ''}`);
  console.log(`PASS (${live ? 'live-llm' : 'replay'}): ${summary.passed} passed, ${summary.skipped} skipped of ${summary.total} checks against n8n ${N8N_VERSION}. Results: ${resultsDir}`);
}
