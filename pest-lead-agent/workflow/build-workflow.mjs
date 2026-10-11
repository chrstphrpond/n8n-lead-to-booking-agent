// Generates workflow/book-new-lead.json, workflow/alert-on-errors.json and workflow/handle-approval.json.
// Business logic lives in the pure modules next to this file (unit tested, injected into Code nodes);
// this script only wires nodes: Code nodes prepare each vendor request, HTTP Request nodes make it.
//   node workflow/build-workflow.mjs          write both JSON files
//   node workflow/build-workflow.mjs --check  fail if the committed JSON is stale
//
// House style (global n8n rules): project prefix on workflow names, verb-first node names, a "Read me"
// sticky plus one numbered sticky per section, a short note on every node (notesInFlow), 3 retries 5 seconds
// apart on network calls (maxTries 4), early exits, workflow timezone set, an error workflow on the main
// workflow, onError continueErrorOutput on non-critical steps, and on every call that changes state an
// Idempotency-Key (<event id>:<node name>, stable across n8n retries and sender redeliveries) plus
// X-Run-Id (the execution id, for traceability).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModules, moduleSource, resolveModules } from './modules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const lib = loadModules();

export const MAIN_WORKFLOW_ID = 'pestLeadBook0001';
export const ERROR_WORKFLOW_ID = 'pestLeadAlert001';
export const MAIN_WORKFLOW_NAME = 'Pest Lead Agent · Book new lead';
export const ERROR_WORKFLOW_NAME = 'Pest Lead Agent · Alert on errors';
export const APPROVAL_WORKFLOW_ID = 'pestLeadApprove1';
export const APPROVAL_WORKFLOW_NAME = 'Pest Lead Agent · Handle approval';
export const APPROVAL_WEBHOOK_PATH = 'ridgeway/slack-action';
export const WORKFLOW_TIMEZONE = 'America/New_York';
export const WEBHOOK_PATH = 'ridgeway/lead';

// ---------------------------------------------------------------- node factories

function uuid(seed) {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

class Flow {
  constructor(name, settings, notes) {
    this.name = name;
    this.settings = settings;
    this.notes = notes;
    this.nodes = [];
    this.connections = {};
  }

  add(node) {
    if (this.nodes.some(existing => existing.name === node.name)) throw new Error(`Duplicate node name: ${node.name}`);
    const isSticky = node.type === 'n8n-nodes-base.stickyNote';
    const full = { id: uuid(`${this.name}/${node.name}`), ...node };
    if (!isSticky) {
      const note = this.notes[node.name];
      if (!note) throw new Error(`Missing note for node "${node.name}"`);
      full.notes = note;
      full.notesInFlow = true;
    }
    this.nodes.push(full);
    return node.name;
  }

  connect(from, to, output = 0) {
    const source = this.nodes.find(node => node.name === from);
    if (!source) throw new Error(`Unknown node ${from}`);
    const outputs = [output];
    // continueErrorOutput nodes have a second output; both lead on so a failure is recorded and the run continues.
    if (source.onError === 'continueErrorOutput' && output === 0) outputs.push(1);
    for (const index of outputs) {
      const entry = (this.connections[from] ??= { main: [] });
      while (entry.main.length <= index) entry.main.push([]);
      entry.main[index].push({ node: to, type: 'main', index: 0 });
    }
  }

  chain(...names) {
    for (let i = 0; i < names.length - 1; i++) this.connect(names[i], names[i + 1]);
  }

  json(id) {
    return { id, name: this.name, nodes: this.nodes, connections: this.connections, settings: this.settings, active: false, pinData: {}, tags: [] };
  }
}

const at = (col, row) => [240 + col * 240, 160 + row * 170];

function webhookNode(name, position, path) {
  return {
    name, type: 'n8n-nodes-base.webhook', typeVersion: 2, position,
    webhookId: uuid(`webhook/${path}`),
    parameters: { httpMethod: 'POST', path, responseMode: 'responseNode', options: { rawBody: true } },
  };
}

// Code node: injected modules first, then a short glue body. `from` lists the "Prepare" node(s)
// whose output is the working context (an HTTP node replaces the item with the vendor response).
function codeNode(name, position, { modules = [], from = null, body }) {
  const prelude = from
    ? `const ctx = loadCtx($, ${JSON.stringify(from)});\nconst response = $input.first().json;`
    : 'const ctx = JSON.parse(JSON.stringify($input.first().json));';
  const needed = resolveModules(from ? ['ctx.js', ...modules] : modules, `${prelude}\n${body}`);
  const parts = [];
  if (needed.length) parts.push(moduleSource(needed));
  parts.push(`// ---- ${name} ----\n${prelude}\n${body.trim()}`);
  return {
    name, type: 'n8n-nodes-base.code', typeVersion: 2, position,
    parameters: { mode: 'runOnceForAllItems', jsCode: parts.join('\n\n') },
  };
}

const ENV = name => `{{ $env.${name} }}`;

// Network call: 3 retries (4 tries) 5 seconds apart. `writes` adds the Idempotency-Key header, built from the
// event id (not the execution id) so it stays the same across n8n retries AND across redeliveries of the same
// event, plus X-Run-Id for traceability. `ledger` calls (the event ledger is the dedupe authority itself) send
// X-Run-Id only. `soft` = non-critical: on failure the error output continues the run. `lookup` = a read where 404 is
// an answer (HubSpot reads by a unique value): n8n's "never error" plus "full response", so the next Code node gets
// { statusCode, body } and n8n does not retry a 404 three times; network errors and timeouts are still retried.
function httpNode(name, position, { method = 'POST', url, headers = {}, query = false, body = true, soft = false, writes = false, ledger = false, lookup = false, keyPrefix = '$json.event_id', timeout = 10000 }) {
  const allHeaders = { ...headers };
  if (writes) allHeaders['Idempotency-Key'] = `={{ ${keyPrefix} }}:${name}`;
  if (writes || ledger) allHeaders['X-Run-Id'] = '={{ $execution.id }}';
  const parameters = {
    method, url: `=${url}`,
    sendHeaders: Object.keys(allHeaders).length > 0,
    headerParameters: { parameters: Object.entries(allHeaders).map(([key, value]) => ({ name: key, value })) },
    sendQuery: query,
    sendBody: body,
    options: lookup ? { timeout, response: { response: { neverError: true, fullResponse: true } } } : { timeout },
  };
  if (!parameters.sendHeaders) delete parameters.headerParameters;
  if (query) { parameters.specifyQuery = 'json'; parameters.jsonQuery = '={{ JSON.stringify($json.req.query) }}'; } else delete parameters.sendQuery;
  if (body) { parameters.specifyBody = 'json'; parameters.jsonBody = '={{ JSON.stringify($json.req.body) }}'; } else delete parameters.sendBody;
  return {
    name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position, parameters,
    retryOnFail: true, maxTries: 4, waitBetweenTries: 5000,
    onError: soft ? 'continueErrorOutput' : 'stopWorkflow',
  };
}

const condition = (expression, seed) => ({
  options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
  conditions: [{ id: uuid(`cond/${seed}`), leftValue: `={{ ${expression} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
  combinator: 'and',
});

function ifNode(name, position, expression) {
  return { name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position, parameters: { conditions: condition(expression, name), options: {} } };
}

function switchNode(name, position, expression, outputs) {
  return {
    name, type: 'n8n-nodes-base.switch', typeVersion: 3.2, position,
    parameters: {
      rules: {
        values: outputs.map(output => ({
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{ id: uuid(`switch/${name}/${output}`), leftValue: `={{ ${expression} }}`, rightValue: output, operator: { type: 'string', operation: 'equals' } }],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: output,
        })),
      },
      options: {},
    },
  };
}

function respondNode(name, position, bodyExpression, statusCode, responseHeaders = null) {
  const options = { responseCode: statusCode };
  if (responseHeaders) options.responseHeaders = { entries: Object.entries(responseHeaders).map(([headerName, value]) => ({ name: headerName, value })) };
  return {
    name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position,
    parameters: { respondWith: 'json', responseBody: `={{ ${bodyExpression} }}`, options },
  };
}

function sticky(flow, name, content, position, width, height, color = 7) {
  flow.add({ name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position, parameters: { content, width, height, color } });
}

// ---------------------------------------------------------------- node notes (shown on the canvas)

const MAIN_NOTES = {
  'Receive lead': 'Production webhook POST /webhook/ridgeway/lead. Keeps the raw body for the signature check.',
  'Verify signature': 'HMAC-SHA256 over timestamp.rawBody, timing-safe. Rejects a timestamp older than 300 s or over 60 s ahead, and a missing body. Sets the clock (fixed only in test mode).',
  'Check signature result': 'Early exit: a bad or missing signature ends the run here with no side effects.',
  'Respond 401 unauthorized': 'Answers 401. No vendor was called.',
  'Normalize and validate lead': 'Maps web_form, call_tracking and hubspot_form to one lead. Phones to E.164. Needs a phone or an email.',
  'Check lead is valid': 'Early exit: an unusable payload ends the run here.',
  'Respond 400 invalid': 'Answers 400 with the validation errors. No vendor was called.',
  'Prepare event claim': 'Builds the claim for the event ledger: the event id and this execution id.',
  'Claim event': 'Asks the event ledger for the claim on this event id. Critical: 3 retries 5 seconds apart, then the error workflow.',
  'Check event claim': 'Reads the ledger answer: claimed, in_flight (another run holds the event) or done. Anything else fails the run.',
  'Route claim result': 'Early exit: claimed continues; in_flight answers 409 with Retry-After; done answers 200 duplicate.',
  'Respond 409 in flight': 'Answers 409 {status: in_flight} with a Retry-After header. The sender tries again later. No vendor was called.',
  'Respond duplicate': 'Answers 200 {status: duplicate}. No vendor was called.',
  'Fetch ops settings': 'Reads the "Settings" tab: confidence threshold, urgency windows, approval rules and multipliers. Rules live in the sheet.',
  'Prepare Claude request': 'Parses the settings, then builds the request from workflow/anthropic.js: only inquiry text, source and ZIP leave the building.',
  'Qualify lead with Claude': 'Raw HTTP to ANTHROPIC_BASE_URL/v1/messages with a JSON-schema output. Failure is non-critical: the next step routes it to review.',
  'Apply AI guardrails': 'Re-validates every model field against the allowlists and removes phone numbers and emails the model echoed. Bad output or low confidence (threshold from the sheet) means needs_review.',
  'Fetch service area rules': 'Reads the "Service area" tab of the Ridgeway ops rules sheet (values.get). Rules live in the sheet, not here.',
  'Check service area': 'ZIP to branch. Chooses the path: qualified, needs_review or out_of_area.',
  'Route lead by path': 'Qualified leads go to the customer check; the other two skip straight to the HubSpot contact.',
  'Prepare FieldRoutes customer search': 'Query by phone, or email when there is no phone.',
  'Find FieldRoutes customer': 'FieldRoutes customer search. Failure is non-critical: treated as a new customer with a warning.',
  'Check for existing customer': 'An active FieldRoutes customer turns the lead into a service request.',
  'Branch on existing customer': 'Existing customers skip the deal and go to a CSR task.',
  'Prepare ClickUp service request task': 'Task for the CSR. First name, ZIP and ids only.',
  'Create ClickUp service request task': 'Creates the task. Idempotency-Key makes a retry harmless.',
  'Prepare Slack service request alert': 'Short note with the FieldRoutes customer id and the task id.',
  'Post Slack service request alert': 'Posts to #leads. Non-critical.',
  'Prepare HubSpot contact search': 'One search matches email OR phone.',
  'Search HubSpot contact': 'HubSpot CRM v3 contact search. Critical: 3 retries 5 seconds apart, then the error workflow.',
  'Prepare HubSpot contact upsert': 'Picks the match (email wins) and builds the create or update properties, including the original message.',
  'Branch on contact match': 'Existing contact is updated, otherwise created.',
  'Update HubSpot contact': 'PATCH the contact (a search match, or the existing contact a refused create pointed to). Idempotency-Key per event and node.',
  'Create HubSpot contact': 'POST a new contact. Idempotency-Key per event and node (HubSpot ignores it). Its error output goes on: an email that already exists is refused.',
  'Check HubSpot contact create': 'A new contact id goes on. A refused create with an email (it already exists; search lagged) reads that contact; without an email it fails the run.',
  'Branch on contact create': 'Refused create: read the existing contact by email, then update it.',
  'Find HubSpot contact by email': 'GET the contact by its email (idProperty=email). 404 is an answer here, not an error.',
  'Prepare contact update after conflict': 'Found: update that contact with this lead. Not found: fail the run with both answers.',
  'Record HubSpot contact': 'Keeps the contact id for every later step.',
  'Route lead after contact': 'qualified continues to the deal; needs_review and out_of_area take their short branches.',
  'Prepare Slack out-of-area note': 'Short note: ZIP and the HubSpot contact link.',
  'Post Slack out-of-area note': 'Posts to #leads. Non-critical.',
  'Prepare ClickUp review task': 'Review task for a human; the original message is on the HubSpot contact.',
  'Create ClickUp review task': 'Creates the review task. Idempotency-Key makes a retry harmless.',
  'Prepare Slack review alert': 'Short note with the reason and the task id.',
  'Post Slack review alert': 'Posts to #leads. Non-critical.',
  'Fetch pricing rules': 'Reads the "Pricing" tab of the ops rules sheet.',
  'Prepare HubSpot deal': 'Picks the Pricing row (a termite letter request is priced as a WDO letter), estimates the value, decides on approval, builds the deal lookup.',
  'Find HubSpot deal': 'GET the deal by ridgeway_event_id (a unique-value property), not a search, which can lag. HubSpot ignores Idempotency-Key. 404 is an answer here.',
  'Pick HubSpot deal': 'Reuses the deal of an earlier attempt of this event (404: none, prepare the create). 429 or 5xx fails the run.',
  'Branch on deal match': 'A deal already exists for this event: skip the create.',
  'Create HubSpot deal': 'Deal in the New lead stage (pipeline and stage ids from the sheet), with ridgeway_event_id. Its error output goes on: a second create conflicts.',
  'Record HubSpot deal': 'Keeps the new deal id, or marks a refused create to be checked.',
  'Branch on deal create': 'Refused create: read the deal by ridgeway_event_id; it may exist from an attempt whose answer was lost.',
  'Find HubSpot deal after conflict': 'GET the deal by ridgeway_event_id after a refused create.',
  'Reuse HubSpot deal after conflict': 'Found: reuse it (warning hubspot_deal_create_conflict). Not found: fail the run with both answers.',
  'Associate deal with contact': 'HubSpot v4 default association, deal to contact.',
  'Prepare FieldRoutes availability search': 'Window by urgency in the branch time zone; the days per urgency come from the rules sheet.',
  'Search FieldRoutes availability': 'FieldRoutes spot search. Failure is non-critical: no slots, callback task, Slack warning.',
  'Pick slots': 'Up to 3 open slots inside the window and at least an hour from now.',
  'Branch on availability': 'If the search failed, create a callback task and warn Slack; the run continues.',
  'Prepare callback task': 'Call-back-to-book task for the CSR.',
  'Create ClickUp callback task': 'Creates the task. Idempotency-Key makes a retry harmless.',
  'Prepare FieldRoutes warning': 'Slack warning text.',
  'Post Slack FieldRoutes warning': 'Posts to #leads. Non-critical.',
  'Prepare deal stage update': 'Records the final stage the deal should have.',
  'Branch on approval': 'Approval pest types, commercial (when the sheet says so) or a value over the threshold need approval. A reused deal that already moved on keeps its stage.',
  'Move deal to Needs approval': 'PATCH the deal stage. Idempotency-Key per run.',
  'Prepare Gmail draft': 'Drafts the customer email (never sent) and proposes an SMS only with explicit consent.',
  'Branch on email': 'No email address means no draft.',
  'Create Gmail draft': 'Creates a draft only. Non-critical: a failure shows up in the CSR task and as a gmail_draft_failed warning.',
  'Prepare ClickUp CSR task': 'Full handoff for the CSR: ids, links, slots, proposed SMS, the custom fields, and whether the Gmail draft exists.',
  'Create ClickUp CSR task': 'Creates the task. Idempotency-Key makes a retry harmless.',
  'Prepare Slack leads summary': 'Block Kit summary; Approve and Hold buttons (value: the event id only) when approval is required.',
  'Post Slack leads summary': 'Posts to #leads. Non-critical.',
  'Compose result': 'Every path ends here: builds the response and the log row.',
  'Append speed-to-lead row': 'One row per lead: ids, timestamps, status. No personal data. Non-critical.',
  'Prepare event done': 'Builds the done request: status plus the ids later steps look up by event id (deal, CSR task, Slack message).',
  'Mark event done': 'Tells the ledger the event is finished (a redelivery answers duplicate) and stores the ids for Approve / Hold. Non-critical.',
  'Respond with result': 'Answers 200 with the result.',
};

const ERROR_NOTES = {
  'Receive error': 'Runs when the Book new lead or the Handle approval workflow fails.',
  'Describe failure': 'Reads the failed execution id from the error trigger.',
  'Release failed event': 'Hands the failed run\'s claim (a lead or an approval decision) back to the ledger, marked failed, so a retry is processed again.',
  'Compose alert': 'Short alert text: workflow, failed node, event id, error message. No customer data.',
  'Post Slack automation alert': 'Posts to #automation-alerts. Non-critical.',
  'Append error log row': 'Appends to the Errors tab of the log sheet. Non-critical.',
};

const APPROVAL_NOTES = {
  'Receive Slack action': 'Production webhook POST /webhook/ridgeway/slack-action, called only by the local Socket Mode relay. Keeps the raw body.',
  'Verify relay signature': 'HMAC-SHA256 over timestamp.rawBody with SLACK_RELAY_SECRET, timing-safe, 300 s window. Same check as the lead webhook.',
  'Check relay signature result': 'Early exit: a bad or missing signature ends the run here with no side effects.',
  'Respond 401 unauthorized': 'Answers 401. Nothing was called.',
  'Validate Slack action': 'Ids only: team, action (approve_lead or hold_lead), event id, user, channel, message ts, action ts, retry attempt. Anything else is refused.',
  'Check action is valid': 'Early exit: a malformed payload ends the run here.',
  'Respond 400 invalid': 'Answers 400 with the validation errors. Nothing was called.',
  'Check approver': 'Is the Slack user on SLACK_APPROVER_IDS? An empty list means nobody: fail closed.',
  'Branch on approver': 'Approvers go on to claim the decision; anyone else only gets an ephemeral notice.',
  'Prepare approver notice': 'Ephemeral text for the person who clicked: only approvers can decide.',
  'Post Slack approver notice': 'chat.postEphemeral, seen only by that user. Non-critical. Nothing else changes.',
  'Respond not an approver': 'Answers 403 {status: not_approver}.',
  'Prepare decision claim': 'Builds the decision claim: decision, user, click time and this execution id.',
  'Claim decision': 'Event ledger: the first decision on a lead wins. Returns the deal, task and message ids the lead run stored. Critical.',
  'Check decision claim': 'claimed goes on; a decided or in-flight lead (repeat click, Slack redelivery) and an unknown lead stop here.',
  'Route decision claim': 'Early exit for anything but a fresh claim, with no vendor call.',
  'Respond already decided': 'Answers 200 {status: already_decided}. No second update.',
  'Respond not awaiting approval': 'Answers 409: the event is unknown to the ledger or never needed approval.',
  'Fetch ops settings': 'Reads the Settings tab of the ops rules sheet: the HubSpot stage ids live there.',
  'Prepare deal decision': 'Deal stage from the decision and the sheet: Approved or On hold. The deal id comes from the ledger, not from the button.',
  'Move deal to decided stage': 'PATCH the HubSpot deal stage. Idempotency-Key per event and node. Critical.',
  'Prepare ClickUp decision comment': 'Comment for the CSR task: who decided, when, and what to do next. Ids only.',
  'Add ClickUp decision comment': 'POST a comment on the CSR task the lead run created. Idempotency-Key per event and node. Critical.',
  'Prepare Slack message update': 'Rebuilds the summary from the blocks the ledger kept, without the buttons, plus who decided and when.',
  'Update Slack approval message': 'chat.update on the original message: the buttons are replaced. Non-critical.',
  'Prepare decision done': 'Records whether the Slack update worked and builds the done mark for the ledger.',
  'Mark decision done': 'Tells the ledger the decision is complete, so a repeat click answers already_decided. Non-critical.',
  'Respond with decision': 'Answers 200 {status: approved | on_hold}.',
};

// ---------------------------------------------------------------- Pest Lead Agent · Book new lead

const SLACK_HEADERS = { Authorization: `=Bearer ${ENV('SLACK_BOT_TOKEN')}` };
const HUBSPOT_HEADERS = { Authorization: `=Bearer ${ENV('HUBSPOT_TOKEN')}` };
const CLICKUP_HEADERS = { Authorization: `=${ENV('CLICKUP_TOKEN')}` };
const LEDGER_HEADERS = { Authorization: `=Bearer ${ENV('EVENT_LEDGER_TOKEN')}` };
const SHEETS_HEADERS = { Authorization: `=Bearer ${ENV('SHEETS_TOKEN')}` };
const FIELDROUTES_HEADERS = { authenticationKey: `=${ENV('FIELDROUTES_AUTH_KEY')}`, authenticationToken: `=${ENV('FIELDROUTES_AUTH_TOKEN')}` };
const slackPost = (name, position) => httpNode(name, position, { url: `${ENV('SLACK_BASE_URL')}/api/chat.postMessage`, headers: SLACK_HEADERS, soft: true, writes: true });
const clickupCreate = (name, position) => httpNode(name, position, { url: `${ENV('CLICKUP_BASE_URL')}/api/v2/list/${ENV('CLICKUP_LIST_ID')}/task`, headers: CLICKUP_HEADERS, writes: true });
const rulesTab = (name, position, range) => httpNode(name, position, { method: 'GET', body: false, url: `${ENV('SHEETS_BASE_URL')}/v4/spreadsheets/${ENV('OPS_RULES_SHEET_ID')}/values/${range}`, headers: SHEETS_HEADERS });

function buildMain() {
  const f = new Flow(MAIN_WORKFLOW_NAME, {
    executionOrder: 'v1', timezone: WORKFLOW_TIMEZONE, errorWorkflow: ERROR_WORKFLOW_ID,
    // Execution history is a second copy of the lead (names, phones, emails sit in node data). Successful runs keep
    // none of it; failed runs stay saved so they can be debugged.
    saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all',
  }, MAIN_NOTES);

  // Sticky notes first so they render behind the nodes.
  sticky(f, 'Read me', [
    '## Pest Lead Agent: book a new lead',
    'Fictional company (Ridgeway Pest Control), mocked vendor APIs. A new lead comes in; a qualified HubSpot deal, proposed FieldRoutes slots, a CSR task and a Slack alert go out. **Nothing is ever sent to a customer**: email is a Gmail draft, SMS is only a proposal in the CSR task.',
    '**Config** comes from env: *_BASE_URL and tokens for HubSpot, ClickUp, Slack, Gmail, Sheets, FieldRoutes and Anthropic, plus LEAD_WEBHOOK_SECRET, OPS_RULES_SHEET_ID and the Slack channels (SLACK_LEADS_CHANNEL, SLACK_ALERTS_CHANNEL: names for the mock, ids for a real workspace). **Rules** (service area, pricing, approval thresholds, and the HubSpot pipeline and stage ids, which a real portal generates) live in the "Ridgeway ops rules" sheet. **Privacy**: Slack, ClickUp and Sheets get ids, links, first name and ZIP only. **Retries**: 3 retries 5 seconds apart on every network call; every write sends Idempotency-Key = event id + node name (stable across retries and redeliveries) and X-Run-Id = execution id. Failures of required steps go to "Pest Lead Agent · Alert on errors".',
  ].join('\n\n'), at(0, -2), 1800, 230, 4);
  sticky(f, '1. Intake and trust', 'Signed webhook (HMAC-SHA256 over timestamp.rawBody, timing-safe, 300 s replay window), three sources normalized, E.164 phones, one claim per event_id in the event ledger. Bad or stale signature: 401. Invalid payload: 400. Event still in flight: 409 with Retry-After. Duplicate: 200. All four exit early with no side effects.', at(0, -1), 2100, 150);
  sticky(f, '2. AI qualification', 'Claude (haiku 5.5) via raw HTTP with a JSON-schema output. The output is never trusted: guardrails re-validate every field and remove echoed phone numbers and emails. Invalid output or confidence below the sheet threshold goes to needs_review.', at(9, -1), 1100, 150);
  sticky(f, '3. Routing', 'The service-area table is read from the ops rules sheet, like every other rule. ZIP to branch (Jacksonville, Savannah, Mobile). needs_review and out_of_area leads skip the customer check and the deal.', at(13, -1), 1000, 150);

  // --- 1. intake
  f.add(webhookNode('Receive lead', at(0, 0), WEBHOOK_PATH));
  f.add(codeNode('Verify signature', at(1, 0), { body: `
const hook = $input.first();
const headers = hook.json.headers || {};
const clock = resolveClock(headers, $env.RIDGEWAY_TEST_MODE);
const rawBuffer = hook.binary && hook.binary.data ? await this.helpers.getBinaryDataBuffer(0, 'data') : null;
const verdict = verifySignature($env.LEAD_WEBHOOK_SECRET, rawBuffer, headers[SIGNATURE_HEADER], headers[TIMESTAMP_HEADER], clock.nowMs);
return [{ json: {
  sig_ok: verdict.ok, sig_reason: verdict.reason,
  payload: verdict.ok ? hook.json.body : null,
  received_at: new Date(clock.nowMs).toISOString(), now_ms: clock.nowMs, clock_fixed: clock.fixed, started_real_ms: Date.now(),
} }];` }));
  f.add(ifNode('Check signature result', at(2, 0), '$json.sig_ok'));
  f.add(respondNode('Respond 401 unauthorized', at(2, 1), "JSON.stringify({ status: 'unauthorized', error: $json.sig_reason })", 401));
  f.add(codeNode('Normalize and validate lead', at(3, 0), { body: `
const result = normalizeLead(ctx.payload);
delete ctx.payload;
return [{ json: { ...ctx, valid: result.valid, errors: result.errors, lead: result.lead, event_id: result.lead ? result.lead.event_id : null } }];` }));
  f.add(ifNode('Check lead is valid', at(4, 0), '$json.valid'));
  f.add(respondNode('Respond 400 invalid', at(4, 1), "JSON.stringify({ status: 'invalid', errors: $json.errors })", 400));
  f.add(codeNode('Prepare event claim', at(5, 0), { body: `
ctx.req = { body: claimRequestBody(ctx.event_id, $execution.id) };
return [{ json: ctx }];` }));
  f.add(httpNode('Claim event', at(6, 0), {
    url: `${ENV('EVENT_LEDGER_BASE_URL')}/v1/events/claim`, headers: LEDGER_HEADERS, ledger: true,
  }));
  f.add(codeNode('Check event claim', at(7, 0), { from: ['Prepare event claim'], body: `
const verdict = interpretClaim(response);
delete ctx.req;
return [{ json: { ...ctx, claim_route: verdict.route, claim_reason: verdict.reason } }];` }));
  f.add(switchNode('Route claim result', at(8, 0), '$json.claim_route', ['claimed', 'in_flight', 'duplicate']));
  f.add(respondNode('Respond 409 in flight', at(8, 1), `JSON.stringify({ status: 'in_flight', event_id: $json.event_id, retry_after_seconds: ${lib.RETRY_AFTER_SECONDS} })`, 409, { 'Retry-After': String(lib.RETRY_AFTER_SECONDS) }));
  f.add(respondNode('Respond duplicate', at(8, 2), "JSON.stringify({ status: 'duplicate', event_id: $json.event_id, reason: $json.claim_reason })", 200));
  f.chain('Receive lead', 'Verify signature', 'Check signature result');
  f.connect('Check signature result', 'Normalize and validate lead', 0);
  f.connect('Check signature result', 'Respond 401 unauthorized', 1);
  f.connect('Normalize and validate lead', 'Check lead is valid');
  f.connect('Check lead is valid', 'Prepare event claim', 0);
  f.connect('Check lead is valid', 'Respond 400 invalid', 1);
  f.chain('Prepare event claim', 'Claim event', 'Check event claim', 'Route claim result');
  f.connect('Route claim result', 'Respond 409 in flight', 1);
  f.connect('Route claim result', 'Respond duplicate', 2);

  // --- 2. AI qualification
  f.add(rulesTab('Fetch ops settings', at(9, 0), 'Settings!A2:B'));
  f.add(codeNode('Prepare Claude request', at(10, 0), { from: ['Check event claim'], body: `
ctx.settings = parseSettings(response);
ctx.req = { body: buildQualificationRequest(ctx.lead) };
return [{ json: ctx }];` }));
  f.add(httpNode('Qualify lead with Claude', at(11, 0), {
    url: `${ENV('ANTHROPIC_BASE_URL')}/v1/messages`,
    headers: { 'x-api-key': `=${ENV('ANTHROPIC_API_KEY')}`, 'anthropic-version': lib.ANTHROPIC_VERSION },
    soft: true, timeout: 90000,
  }));
  f.add(codeNode('Apply AI guardrails', at(12, 0), { from: ['Prepare Claude request'], body: `
const ai = assessQualification(response, ctx.settings.confidence_threshold);
delete ctx.req;
return [{ json: { ...ctx,
  ai: { ...ai, llm_model: response.model || null, llm_usage: response.usage || null },
  qualification: ai.status === 'ok' ? ai.qualification : null } }];` }));
  f.connect('Route claim result', 'Fetch ops settings', 0);
  f.chain('Fetch ops settings', 'Prepare Claude request', 'Qualify lead with Claude', 'Apply AI guardrails');

  // --- 3. routing (rules come from the ops rules sheet)
  f.add(rulesTab('Fetch service area rules', at(13, 0), 'Service%20area!A2:F'));
  f.add(codeNode('Check service area', at(14, 0), { from: ['Apply AI guardrails'], body: `
const serviceArea = parseServiceArea(response);
const branch = findBranch(serviceArea, ctx.lead.zip);
const path = ctx.ai.status !== 'ok' ? 'needs_review' : (branch ? 'qualified' : 'out_of_area');
return [{ json: { ...ctx, branch, path } }];` }));
  f.add(switchNode('Route lead by path', at(15, 0), '$json.path', ['qualified', 'needs_review', 'out_of_area']));
  f.chain('Apply AI guardrails', 'Fetch service area rules', 'Check service area', 'Route lead by path');
  f.connect('Route lead by path', 'Prepare FieldRoutes customer search', 0);
  f.connect('Route lead by path', 'Prepare HubSpot contact search', 1);
  f.connect('Route lead by path', 'Prepare HubSpot contact search', 2);

  // --- 4. FieldRoutes customer lookup
  sticky(f, '4. Existing customer check', 'FieldRoutes customer search by phone (email if no phone). An active customer is handled as a service request on their account instead of a new deal.', at(0, 2), 1300, 150);
  f.add(codeNode('Prepare FieldRoutes customer search', at(0, 3), { body: `
ctx.req = { query: fieldRoutesCustomerQuery(ctx) };
return [{ json: ctx }];` }));
  f.add(httpNode('Find FieldRoutes customer', at(1, 3), {
    method: 'GET', body: false, query: true, soft: true,
    url: `${ENV('FIELDROUTES_BASE_URL')}/customer/search`, headers: FIELDROUTES_HEADERS,
  }));
  f.add(codeNode('Check for existing customer', at(2, 3), { from: ['Prepare FieldRoutes customer search'], body: `
const status = describeHttp(response);
const customers = status.ok && Array.isArray(response.customers) ? response.customers : [];
const active = customers.find(customer => customer.status === '1');
const warnings = [...(ctx.warnings || [])];
if (!status.ok) warnings.push('fieldroutes_customer_search_failed');
delete ctx.req;
return [{ json: { ...ctx, warnings,
  fieldroutes: { customer_id: active ? active.customerID : null, search_ok: status.ok },
  path: active ? 'service_request' : ctx.path } }];` }));
  f.add(ifNode('Branch on existing customer', at(3, 3), "$json.path === 'service_request'"));
  f.chain('Prepare FieldRoutes customer search', 'Find FieldRoutes customer', 'Check for existing customer', 'Branch on existing customer');
  f.connect('Branch on existing customer', 'Prepare ClickUp service request task', 0);
  f.connect('Branch on existing customer', 'Prepare HubSpot contact search', 1);

  // --- 5. service request branch
  sticky(f, '5. Service request branch', 'Existing customer: a ClickUp CSR task and a Slack note. No new HubSpot deal.', at(4, 3), 1400, 330);
  f.add(codeNode('Prepare ClickUp service request task', at(4, 4), { body: `
const q = ctx.qualification;
ctx.req = { body: clickupTaskBody({
  name: 'Service request: existing customer #' + ctx.fieldroutes.customer_id + ' (' + q.pest_type.replace(/_/g, ' ') + ')',
  description: serviceRequestTaskDescription(ctx), urgency: q.urgency, tags: ['service-request'], custom_fields: clickupCustomFields(ctx, q.urgency) }) };
return [{ json: ctx }];` }));
  f.add(clickupCreate('Create ClickUp service request task', at(5, 4)));
  f.add(codeNode('Prepare Slack service request alert', at(6, 4), { from: ['Prepare ClickUp service request task'], body: `
if (!response.id) throw new Error('ClickUp did not return a task id');
ctx.clickup_task_id = response.id;
ctx.channels = slackChannels($env);
ctx.req = { body: slackServiceRequest(ctx) };
return [{ json: ctx }];` }));
  f.add(slackPost('Post Slack service request alert', at(7, 4)));
  f.chain('Prepare ClickUp service request task', 'Create ClickUp service request task', 'Prepare Slack service request alert', 'Post Slack service request alert', 'Compose result');

  // --- 6. HubSpot contact (shared by every path except existing customers)
  sticky(f, '6. HubSpot contact', 'One search matches email OR phone (email wins), then update or create. A create refused because the email exists (the search lagged) reads that contact by email and updates it. Out-of-area leads are tagged, needs-review leads carry their status. The customer\'s original message is stored on the contact, so other systems only need the id.', at(0, 6), 1600, 150);
  f.add(codeNode('Prepare HubSpot contact search', at(0, 7), { body: `
ctx.req = { body: hubspotSearchBody(ctx.lead, ctx.settings) };
return [{ json: ctx }];` }));
  f.add(httpNode('Search HubSpot contact', at(1, 7), { url: `${ENV('HUBSPOT_BASE_URL')}/crm/v3/objects/contacts/search`, headers: HUBSPOT_HEADERS }));
  f.add(codeNode('Prepare HubSpot contact upsert', at(2, 7), { from: ['Prepare HubSpot contact search'], body: `
// With the email fallback on, HubSpot holds the mapped address, so the match compares with that.
const match = pickContactMatch(response.results, { ...ctx.lead, email: hubspotEmail(ctx.lead.email, ctx.settings) });
const existed = Boolean(match);
ctx.hubspot = { contact_id: match ? String(match.id) : null, existed };
ctx.req = { body: { properties: hubspotContactProperties(ctx, existed) } };
return [{ json: ctx }];` }));
  f.add(ifNode('Branch on contact match', at(3, 7), '$json.hubspot.existed'));
  f.add(httpNode('Update HubSpot contact', at(4, 7), { method: 'PATCH', url: `${ENV('HUBSPOT_BASE_URL')}/crm/v3/objects/contacts/{{ $json.hubspot.contact_id }}`, headers: HUBSPOT_HEADERS, writes: true }));
  f.add(httpNode('Create HubSpot contact', at(4, 8), { url: `${ENV('HUBSPOT_BASE_URL')}/crm/v3/objects/contacts`, headers: HUBSPOT_HEADERS, writes: true, soft: true }));
  f.add(codeNode('Check HubSpot contact create', at(5, 8), { from: ['Prepare HubSpot contact upsert'], body: `
const status = describeHttp(response);
if (status.ok && response.id) {
  ctx.hubspot.contact_id = String(response.id);
  ctx.contact_conflict = false;
  delete ctx.req;
} else {
  // Refused. With an email this is normally "already exists" (HubSpot's search had not caught up); read it.
  const email = hubspotEmail(ctx.lead.email, ctx.settings);
  if (!email) throw new Error('HubSpot refused the contact create: ' + (status.error || 'no contact id'));
  ctx.contact_conflict = true;
  ctx.contact_create_error = status.error || 'HubSpot returned no contact id';
  ctx.lookup_email = email;
  ctx.req = { query: hubspotContactLookupQuery() };
}
return [{ json: ctx }];` }));
  f.add(ifNode('Branch on contact create', at(6, 8), '$json.contact_conflict'));
  f.add(httpNode('Find HubSpot contact by email', at(7, 8), {
    method: 'GET', body: false, query: true, lookup: true,
    url: `${ENV('HUBSPOT_BASE_URL')}/crm/v3/objects/contacts/{{ encodeURIComponent($json.lookup_email) }}`, headers: HUBSPOT_HEADERS,
  }));
  f.add(codeNode('Prepare contact update after conflict', at(8, 8), { from: ['Check HubSpot contact create'], body: `
const lookup = readHubspotLookup(response);
if (!lookup.found) throw new Error('HubSpot refused the contact create (' + ctx.contact_create_error + ') and has no contact with this email (lookup answered ' + lookup.status + ')');
ctx.hubspot = { contact_id: String(lookup.record.id), existed: true };
ctx.warnings = [...(ctx.warnings || []), 'hubspot_contact_create_conflict'];
delete ctx.lookup_email;
ctx.req = { body: { properties: hubspotContactProperties(ctx, true) } };
return [{ json: ctx }];` }));
  f.add(codeNode('Record HubSpot contact', at(5, 7), { from: ['Prepare contact update after conflict', 'Prepare HubSpot contact upsert'], body: `
if (!response.id) throw new Error('HubSpot did not return a contact id');
ctx.hubspot.contact_id = String(response.id);
delete ctx.req;
return [{ json: ctx }];` }));
  f.add(switchNode('Route lead after contact', at(6, 7), '$json.path', ['qualified', 'needs_review', 'out_of_area']));
  f.chain('Prepare HubSpot contact search', 'Search HubSpot contact', 'Prepare HubSpot contact upsert', 'Branch on contact match');
  f.connect('Branch on contact match', 'Update HubSpot contact', 0);
  f.connect('Branch on contact match', 'Create HubSpot contact', 1);
  f.connect('Update HubSpot contact', 'Record HubSpot contact');
  f.chain('Create HubSpot contact', 'Check HubSpot contact create', 'Branch on contact create');
  f.connect('Branch on contact create', 'Find HubSpot contact by email', 0);
  f.connect('Branch on contact create', 'Route lead after contact', 1);
  f.chain('Find HubSpot contact by email', 'Prepare contact update after conflict', 'Update HubSpot contact');
  f.connect('Record HubSpot contact', 'Route lead after contact');
  f.connect('Route lead after contact', 'Fetch pricing rules', 0);
  f.connect('Route lead after contact', 'Prepare ClickUp review task', 1);
  f.connect('Route lead after contact', 'Prepare Slack out-of-area note', 2);

  // --- 7. triage branches
  sticky(f, '7. Needs review and out of area', 'needs_review: ClickUp review task and Slack, no deal, no slot. out_of_area: the contact is already tagged, so a short Slack note is all that is left.', at(0, 10), 1700, 330);
  f.add(codeNode('Prepare Slack out-of-area note', at(0, 11), { body: `
ctx.channels = slackChannels($env);
ctx.req = { body: slackOutOfArea(ctx) };
return [{ json: ctx }];` }));
  f.add(slackPost('Post Slack out-of-area note', at(1, 11)));
  f.chain('Prepare Slack out-of-area note', 'Post Slack out-of-area note', 'Compose result');
  f.add(codeNode('Prepare ClickUp review task', at(0, 12), { body: `
ctx.req = { body: clickupTaskBody({
  name: 'Review lead: ' + leadRef(ctx),
  description: reviewTaskDescription(ctx), urgency: 'normal', tags: ['needs-review'], custom_fields: clickupCustomFields(ctx, 'normal') }) };
return [{ json: ctx }];` }));
  f.add(clickupCreate('Create ClickUp review task', at(1, 12)));
  f.add(codeNode('Prepare Slack review alert', at(2, 12), { from: ['Prepare ClickUp review task'], body: `
if (!response.id) throw new Error('ClickUp did not return a task id');
ctx.clickup_task_id = response.id;
ctx.channels = slackChannels($env);
ctx.req = { body: slackReview(ctx) };
return [{ json: ctx }];` }));
  f.add(slackPost('Post Slack review alert', at(3, 12)));
  f.chain('Prepare ClickUp review task', 'Create ClickUp review task', 'Prepare Slack review alert', 'Post Slack review alert', 'Compose result');

  // --- 8. deal, availability, approval
  sticky(f, '8. Deal, availability and approval', 'Pricing and approval rules come from the ops rules sheet. A redelivery reads the deal by its unique ridgeway_event_id (GET with idProperty, not a search) instead of creating a second one; a create that conflicts on that property reads it too. The deal is created in "New lead" and associated to the contact. The FieldRoutes spot search covers the urgency window; a failure after 3 retries means no slots, a callback task and a Slack warning, and the run continues. The approval pest types, commercial properties (when the sheet says so) and a high value move the deal to "Needs approval".', at(0, 14), 3700, 170);
  f.add(rulesTab('Fetch pricing rules', at(0, 15), 'Pricing!A2:D'));
  f.add(codeNode('Prepare HubSpot deal', at(1, 15), { from: ['Route lead after contact'], body: `
const pricing = parsePricing(response);
ctx.service = pricedService(ctx.qualification, ctx.lead.inquiry_text, ctx.settings);
ctx.estimated_value = estimateDealValue(pricing, ctx.settings, ctx.qualification, ctx.service);
ctx.approval = decideApproval(ctx.qualification, ctx.estimated_value, ctx.settings, ctx.service);
ctx.deal_body = hubspotDealBody(ctx);
ctx.req = { query: hubspotDealLookupQuery() };
return [{ json: ctx }];` }));
  const dealLookup = (name, position) => httpNode(name, position, {
    method: 'GET', body: false, query: true, lookup: true,
    url: `${ENV('HUBSPOT_BASE_URL')}/crm/v3/objects/deals/{{ encodeURIComponent($json.event_id) }}`, headers: HUBSPOT_HEADERS,
  });
  f.add(dealLookup('Find HubSpot deal', at(2, 15)));
  f.add(codeNode('Pick HubSpot deal', at(3, 15), { from: ['Prepare HubSpot deal'], body: `
const lookup = pickDealLookup(response, ctx.event_id);
ctx.hubspot.deal_reused = lookup.found;
if (lookup.found) { ctx.hubspot.deal_id = String(lookup.record.id); ctx.hubspot.deal_stage = lookup.record.properties.dealstage || null; delete ctx.deal_body; ctx.req = null; }
else ctx.req = { body: ctx.deal_body };
return [{ json: ctx }];` }));
  f.add(ifNode('Branch on deal match', at(4, 15), '$json.hubspot.deal_reused'));
  f.add(httpNode('Create HubSpot deal', at(5, 16), { url: `${ENV('HUBSPOT_BASE_URL')}/crm/v3/objects/deals`, headers: HUBSPOT_HEADERS, writes: true, soft: true }));
  f.add(codeNode('Record HubSpot deal', at(6, 16), { from: ['Pick HubSpot deal'], body: `
const status = describeHttp(response);
delete ctx.deal_body;
if (status.ok && response.id) {
  ctx.hubspot.deal_id = String(response.id);
  ctx.deal_conflict = false;
  delete ctx.req;
} else {
  // Refused, after the retries. ridgeway_event_id is unique, so a deal an earlier try created (its answer lost)
  // makes every later create conflict. Whatever the body says, the lookup decides.
  ctx.deal_conflict = true;
  ctx.deal_create_error = status.error || 'HubSpot returned no deal id';
  ctx.req = { query: hubspotDealLookupQuery() };
}
return [{ json: ctx }];` }));
  f.add(ifNode('Branch on deal create', at(7, 16), '$json.deal_conflict'));
  f.add(dealLookup('Find HubSpot deal after conflict', at(8, 17)));
  f.add(codeNode('Reuse HubSpot deal after conflict', at(9, 17), { from: ['Record HubSpot deal'], body: `
const lookup = pickDealLookup(response, ctx.event_id);
if (!lookup.found) throw new Error('HubSpot refused the deal create (' + ctx.deal_create_error + ') and has no deal for this event (lookup answered ' + lookup.status + ')');
ctx.hubspot.deal_id = String(lookup.record.id);
ctx.hubspot.deal_reused = true;
ctx.hubspot.deal_stage = lookup.record.properties.dealstage || null;
ctx.warnings = [...(ctx.warnings || []), 'hubspot_deal_create_conflict'];
delete ctx.req;
return [{ json: ctx }];` }));
  f.add(httpNode('Associate deal with contact', at(7, 15), {
    method: 'PUT', body: false, writes: true,
    url: `${ENV('HUBSPOT_BASE_URL')}/crm/v4/objects/deals/{{ $json.hubspot.deal_id }}/associations/default/contacts/{{ $json.hubspot.contact_id }}`,
    headers: HUBSPOT_HEADERS,
  }));
  f.add(codeNode('Prepare FieldRoutes availability search', at(8, 15), { from: ['Reuse HubSpot deal after conflict', 'Record HubSpot deal', 'Pick HubSpot deal'], body: `
delete ctx.req;
ctx.window = urgencyWindow(ctx.qualification.urgency, ctx.now_ms, ctx.branch.timezone, ctx.settings.urgency_window_days);
ctx.req = { query: fieldRoutesSpotQuery(ctx) };
return [{ json: ctx }];` }));
  f.add(httpNode('Search FieldRoutes availability', at(9, 15), {
    method: 'GET', body: false, query: true, soft: true,
    url: `${ENV('FIELDROUTES_BASE_URL')}/spot/search`, headers: FIELDROUTES_HEADERS,
  }));
  f.add(codeNode('Pick slots', at(10, 15), { from: ['Prepare FieldRoutes availability search'], body: `
const status = describeHttp(response);
const failed = !status.ok || response.success === false;
const warnings = [...(ctx.warnings || [])];
if (failed) warnings.push('fieldroutes_availability_unavailable');
const slots = failed ? [] : pickSlots(response.spots, {
  nowMs: ctx.now_ms, timeZone: ctx.branch.timezone, window: ctx.window, urgency: ctx.qualification.urgency });
delete ctx.req;
return [{ json: { ...ctx, slots, availability_failed: failed, warnings } }];` }));
  f.add(ifNode('Branch on availability', at(11, 15), '$json.availability_failed'));
  f.chain('Fetch pricing rules', 'Prepare HubSpot deal', 'Find HubSpot deal', 'Pick HubSpot deal', 'Branch on deal match');
  f.connect('Branch on deal match', 'Associate deal with contact', 0);
  f.connect('Branch on deal match', 'Create HubSpot deal', 1);
  f.chain('Create HubSpot deal', 'Record HubSpot deal', 'Branch on deal create');
  f.connect('Branch on deal create', 'Find HubSpot deal after conflict', 0);
  f.connect('Branch on deal create', 'Associate deal with contact', 1);
  f.chain('Find HubSpot deal after conflict', 'Reuse HubSpot deal after conflict', 'Associate deal with contact');
  f.chain('Associate deal with contact', 'Prepare FieldRoutes availability search', 'Search FieldRoutes availability', 'Pick slots', 'Branch on availability');
  f.connect('Branch on availability', 'Prepare callback task', 0);
  f.connect('Branch on availability', 'Prepare deal stage update', 1);

  f.add(codeNode('Prepare callback task', at(12, 16), { body: `
ctx.req = { body: clickupTaskBody({
  name: 'Call back to book: ' + leadRef(ctx),
  description: callbackTaskDescription(ctx), urgency: ctx.qualification.urgency, tags: ['callback-to-book'], custom_fields: clickupCustomFields(ctx, ctx.qualification.urgency) }) };
return [{ json: ctx }];` }));
  f.add(clickupCreate('Create ClickUp callback task', at(13, 16)));
  f.add(codeNode('Prepare FieldRoutes warning', at(14, 16), { from: ['Prepare callback task'], body: `
ctx.callback_task_id = response.id || null;
ctx.channels = slackChannels($env);
ctx.req = { body: slackFieldRoutesWarning(ctx) };
return [{ json: ctx }];` }));
  f.add(slackPost('Post Slack FieldRoutes warning', at(15, 16)));
  f.chain('Prepare callback task', 'Create ClickUp callback task', 'Prepare FieldRoutes warning', 'Post Slack FieldRoutes warning', 'Prepare deal stage update');

  f.add(codeNode('Prepare deal stage update', at(12, 15), { from: ['Prepare FieldRoutes warning', 'Pick slots'], body: `
ctx.deal_stage = ctx.approval.required ? 'needs_approval' : 'new_lead';
ctx.move_deal_stage = needsApprovalMove(ctx);
ctx.req = { body: hubspotDealStageBody(ctx.settings) };
return [{ json: ctx }];` }));
  f.add(ifNode('Branch on approval', at(13, 15), '$json.move_deal_stage'));
  f.add(httpNode('Move deal to Needs approval', at(14, 15), { method: 'PATCH', url: `${ENV('HUBSPOT_BASE_URL')}/crm/v3/objects/deals/{{ $json.hubspot.deal_id }}`, headers: HUBSPOT_HEADERS, writes: true }));
  f.connect('Prepare deal stage update', 'Branch on approval');
  f.connect('Branch on approval', 'Move deal to Needs approval', 0);
  f.connect('Branch on approval', 'Prepare Gmail draft', 1);
  f.connect('Move deal to Needs approval', 'Prepare Gmail draft');

  // --- 9. outreach drafts and CSR handoff
  sticky(f, '9. Outreach drafts and CSR handoff', 'Gmail draft only, never sent. SMS is proposed only when consent normalizes to true (boolean true, or the form strings true, yes, checked or on); otherwise the reason is recorded. The ClickUp CSR task carries ids, links, slots and the proposed SMS; Slack #leads gets the summary, with Approve and Hold buttons when approval is required.', at(0, 18), 2000, 150);
  f.add(codeNode('Prepare Gmail draft', at(0, 19), { from: ['Prepare deal stage update'], body: `
const email = buildEmailDraft(ctx);
const sms = proposeSms(ctx);
ctx.outreach = { email: { to: email.to, subject: email.subject, draft_id: null, omitted_reason: email.omitted_reason }, sms };
ctx.req = email.to ? { body: gmailDraftBody(buildMimeRaw(email)) } : null;
return [{ json: ctx }];` }));
  f.add(ifNode('Branch on email', at(1, 19), '$json.outreach.email.to !== null'));
  f.add(httpNode('Create Gmail draft', at(2, 19), { url: `${ENV('GMAIL_BASE_URL')}/gmail/v1/users/me/drafts`, headers: { Authorization: `=Bearer ${ENV('GMAIL_TOKEN')}` }, soft: true, writes: true }));
  f.add(codeNode('Prepare ClickUp CSR task', at(3, 19), { from: ['Prepare Gmail draft'], body: `
const email = ctx.outreach.email;
if (email.to) {
  // The input item is Gmail's own answer: the draft on the success output, an error item on the error output.
  const status = describeHttp(response);
  if (status.ok && response.id) email.draft_id = response.id;
  else {
    email.draft_failed = true;
    email.omitted_reason = 'draft_failed';
    email.error = status.error || 'Gmail returned no draft id';
    ctx.warnings = [...(ctx.warnings || []), 'gmail_draft_failed'];
  }
}
const q = ctx.qualification;
ctx.req = { body: clickupTaskBody({
  name: (ctx.approval.required ? 'Approve, then book: ' : 'Book: ') + q.pest_type.replace(/_/g, ' ') + ' - ' + leadRef(ctx),
  description: csrTaskDescription(ctx), urgency: q.urgency, tags: ctx.approval.required ? ['lead', 'needs-approval'] : ['lead'], custom_fields: clickupCustomFields(ctx, q.urgency) }) };
return [{ json: ctx }];` }));
  f.add(clickupCreate('Create ClickUp CSR task', at(4, 19)));
  f.add(codeNode('Prepare Slack leads summary', at(5, 19), { from: ['Prepare ClickUp CSR task'], body: `
if (!response.id) throw new Error('ClickUp did not return a task id');
ctx.clickup_task_id = response.id;
ctx.channels = slackChannels($env);
ctx.req = { body: slackSummary(ctx, ctx.approval.required ? 'approval_required' : 'auto_proposed') };
return [{ json: ctx }];` }));
  f.add(slackPost('Post Slack leads summary', at(6, 19)));
  f.chain('Prepare Gmail draft', 'Branch on email');
  f.connect('Branch on email', 'Create Gmail draft', 0);
  f.connect('Branch on email', 'Prepare ClickUp CSR task', 1);
  f.connect('Create Gmail draft', 'Prepare ClickUp CSR task');
  f.chain('Prepare ClickUp CSR task', 'Create ClickUp CSR task', 'Prepare Slack leads summary', 'Post Slack leads summary', 'Compose result');

  // --- 10. result, speed-to-lead row, response
  sticky(f, '10. Result, log and response', 'Every path ends here: append received_at, finished_at and status to the Google Sheets log, tell the event ledger the event is done (so a redelivery answers duplicate), respond 200 with the result.', at(0, 21), 1900, 150);
  f.add(codeNode('Compose result', at(0, 22), {
    from: ['Prepare Slack out-of-area note', 'Prepare Slack review alert', 'Prepare Slack service request alert', 'Prepare Slack leads summary'],
    body: `
const slack = describeHttp(response);
const warnings = [...(ctx.warnings || [])];
if (!slack.ok || response.ok === false) warnings.push('slack_post_failed');
const status = ctx.path === 'qualified' ? (ctx.approval.required ? 'approval_required' : 'auto_proposed') : ctx.path;
const result = buildResult({ ...ctx, warnings }, status);
const finishedAt = new Date(ctx.now_ms + (Date.now() - ctx.started_real_ms)).toISOString();
return [{ json: { event_id: ctx.event_id, status, result, refs: ledgerRefs(ctx, slack.ok ? response : null, ctx.req && ctx.req.body), req: { body: sheetsSpeedRow(ctx, finishedAt, status) } } }];` }));
  f.add(httpNode('Append speed-to-lead row', at(1, 22), {
    url: `${ENV('SHEETS_BASE_URL')}/v4/spreadsheets/${ENV('SHEETS_SPREADSHEET_ID')}/values/Leads!A:H:append?valueInputOption=USER_ENTERED`,
    headers: SHEETS_HEADERS, soft: true, writes: true,
  }));
  f.add(codeNode('Prepare event done', at(2, 22), { from: ['Compose result'], body: `
ctx.req = { body: doneRequestBody(ctx.event_id, $execution.id, ctx.status, ctx.refs) };
return [{ json: ctx }];` }));
  f.add(httpNode('Mark event done', at(3, 22), {
    url: `${ENV('EVENT_LEDGER_BASE_URL')}/v1/events/complete`, headers: LEDGER_HEADERS, ledger: true, soft: true,
  }));
  f.add(respondNode('Respond with result', at(4, 22), "JSON.stringify($('Compose result').first().json.result)", 200));
  f.chain('Compose result', 'Append speed-to-lead row', 'Prepare event done', 'Mark event done', 'Respond with result');
  return f;
}

// ---------------------------------------------------------------- Pest Lead Agent · Alert on errors

function buildErrorHandler() {
  const f = new Flow(ERROR_WORKFLOW_NAME, { executionOrder: 'v1', timezone: WORKFLOW_TIMEZONE }, ERROR_NOTES);
  sticky(f, 'Read me', [
    '## Pest Lead Agent: alert on errors',
    'Set as `settings.errorWorkflow` on "Pest Lead Agent · Book new lead" and "Pest Lead Agent · Handle approval". It first gives the failed run\'s claim (a lead, or an approval decision) back to the event ledger (marked failed), so the sender\'s redelivery or the approver\'s next click is processed again, then posts a short, personal-data-free alert (with the event id) to Slack #automation-alerts and appends a row to the Errors tab of the log sheet. If the ledger itself is down the claim goes stale after 10 minutes.',
  ].join('\n\n'), at(0, -2), 1400, 170, 4);
  sticky(f, '1. Release, alert and log', 'Release the event claim, describe the failure, tell Slack, write the Errors row. All three calls are non-critical.', at(0, -1), 1400, 130);
  f.add({ name: 'Receive error', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: at(0, 0), parameters: {} });
  f.add(codeNode('Describe failure', at(1, 0), { body: `
return [{ json: { ...ctx, failed_run_id: String((ctx.execution && ctx.execution.id) || ''), req: { body: failRequestBody(ctx.execution && ctx.execution.error && ctx.execution.error.message) } } }];` }));
  f.add(httpNode('Release failed event', at(2, 0), {
    url: `${ENV('EVENT_LEDGER_BASE_URL')}/v1/runs/{{ $json.failed_run_id }}/fail`, headers: LEDGER_HEADERS, ledger: true, soft: true,
  }));
  f.add(codeNode('Compose alert', at(3, 0), { from: ['Describe failure'], body: `
const eventId = response && typeof response.event_id === 'string' ? response.event_id : null;
return [{ json: { ...describeFailure(ctx, new Date().toISOString(), eventId, slackChannels($env).alerts), failed_run_id: ctx.failed_run_id } }];` }));
  f.add(httpNode('Post Slack automation alert', at(4, 0), { url: `${ENV('SLACK_BASE_URL')}/api/chat.postMessage`, headers: SLACK_HEADERS, soft: true, writes: true, keyPrefix: '$json.failed_run_id' }));
  f.add(httpNode('Append error log row', at(5, 0), {
    url: `${ENV('SHEETS_BASE_URL')}/v4/spreadsheets/${ENV('SHEETS_SPREADSHEET_ID')}/values/Errors!A:F:append?valueInputOption=USER_ENTERED`,
    headers: SHEETS_HEADERS, soft: true, writes: true, keyPrefix: "$('Compose alert').first().json.failed_run_id",
  }));
  f.chain('Receive error', 'Describe failure', 'Release failed event', 'Compose alert', 'Post Slack automation alert', 'Append error log row');
  return f;
}

// ---------------------------------------------------------------- Pest Lead Agent · Handle approval

function buildApproval() {
  const f = new Flow(APPROVAL_WORKFLOW_NAME, { executionOrder: 'v1', timezone: WORKFLOW_TIMEZONE, errorWorkflow: ERROR_WORKFLOW_ID }, APPROVAL_NOTES);
  sticky(f, 'Read me', [
    '## Pest Lead Agent: handle Approve / Hold from Slack',
    'A manager clicks **Approve** or **Hold** on a lead summary in #leads. Slack sends the click over Socket Mode to the local relay (`slack-relay/relay.mjs`), which acks it at once and POSTs **ids only** here, signed like the lead webhook (SLACK_RELAY_SECRET). Only users on SLACK_APPROVER_IDS may decide (empty list: nobody). The first decision per lead wins in the event ledger; a repeat click or a Slack redelivery changes nothing. The ledger also hands back the deal, task and message ids the lead run stored, so nothing from the button is trusted beyond the event id.',
    '**Steps**: read the stage ids from the ops rules sheet, HubSpot deal Needs approval to Approved or On hold, a comment on the ClickUp CSR task, and chat.update on the original message (buttons replaced by who decided and when). Writes carry Idempotency-Key = event id + node name and X-Run-Id; 3 retries 5 seconds apart. Failures go to "Pest Lead Agent · Alert on errors", which also releases the decision claim.',
  ].join('\n\n'), at(0, -2), 1900, 250, 4);
  sticky(f, '1. Trust and validation', 'Signed by the relay (HMAC over timestamp.rawBody, 300 s window): 401 otherwise. Ids only, in a fixed shape: 400 otherwise. Both exit with no side effects.', at(0, -1), 1200, 150);
  sticky(f, '2. Approver check', 'SLACK_APPROVER_IDS decides who may act. Anyone else gets an ephemeral notice and nothing changes.', at(5, -1), 950, 150);
  sticky(f, '3. Claim the decision', 'The event ledger holds one decision per lead: first wins. A decided or in-flight lead answers already_decided; a lead that never needed approval answers 409.', at(5, 2), 1150, 150);
  sticky(f, '4. Apply the decision', 'Settings from the ops rules sheet (the HubSpot stage ids live there), then deal stage, CSR task comment, Slack message update, and the ledger marks the decision done.', at(0, 5), 1900, 150);

  f.add(webhookNode('Receive Slack action', at(0, 0), APPROVAL_WEBHOOK_PATH));
  f.add(codeNode('Verify relay signature', at(1, 0), { body: `
const hook = $input.first();
const headers = hook.json.headers || {};
const clock = resolveClock(headers, $env.RIDGEWAY_TEST_MODE);
const rawBuffer = hook.binary && hook.binary.data ? await this.helpers.getBinaryDataBuffer(0, 'data') : null;
const verdict = verifySignature($env.SLACK_RELAY_SECRET, rawBuffer, headers[SIGNATURE_HEADER], headers[TIMESTAMP_HEADER], clock.nowMs);
return [{ json: { sig_ok: verdict.ok, sig_reason: verdict.reason, payload: verdict.ok ? hook.json.body : null } }];` }));
  f.add(ifNode('Check relay signature result', at(2, 0), '$json.sig_ok'));
  f.add(respondNode('Respond 401 unauthorized', at(2, 1), "JSON.stringify({ status: 'unauthorized', error: $json.sig_reason })", 401));
  f.add(codeNode('Validate Slack action', at(3, 0), { body: `
const result = validateSlackAction(ctx.payload);
return [{ json: { valid: result.valid, errors: result.errors, action: result.action, event_id: result.action ? result.action.event_id : null } }];` }));
  f.add(ifNode('Check action is valid', at(4, 0), '$json.valid'));
  f.add(respondNode('Respond 400 invalid', at(4, 1), "JSON.stringify({ status: 'invalid', errors: $json.errors })", 400));
  f.chain('Receive Slack action', 'Verify relay signature', 'Check relay signature result');
  f.connect('Check relay signature result', 'Validate Slack action', 0);
  f.connect('Check relay signature result', 'Respond 401 unauthorized', 1);
  f.connect('Validate Slack action', 'Check action is valid');
  f.connect('Check action is valid', 'Check approver', 0);
  f.connect('Check action is valid', 'Respond 400 invalid', 1);

  f.add(codeNode('Check approver', at(5, 0), { body: `
return [{ json: { ...ctx, approver: isApprover(ctx.action.user_id, parseApproverIds($env.SLACK_APPROVER_IDS)) } }];` }));
  f.add(ifNode('Branch on approver', at(6, 0), '$json.approver'));
  f.add(codeNode('Prepare approver notice', at(6, 1), { body: `
ctx.req = { body: approverOnlyNotice(ctx.action) };
return [{ json: ctx }];` }));
  f.add(httpNode('Post Slack approver notice', at(7, 1), { url: `${ENV('SLACK_BASE_URL')}/api/chat.postEphemeral`, headers: SLACK_HEADERS, soft: true, writes: true }));
  f.add(respondNode('Respond not an approver', at(8, 1), "JSON.stringify({ status: 'not_approver', event_id: $('Prepare approver notice').first().json.event_id })", 403));
  f.chain('Check approver', 'Branch on approver');
  f.connect('Branch on approver', 'Prepare decision claim', 0);
  f.connect('Branch on approver', 'Prepare approver notice', 1);
  f.chain('Prepare approver notice', 'Post Slack approver notice', 'Respond not an approver');

  f.add(codeNode('Prepare decision claim', at(5, 3), { body: `
ctx.req = { body: decisionClaimBody(ctx.action, $execution.id) };
return [{ json: ctx }];` }));
  f.add(httpNode('Claim decision', at(6, 3), {
    url: `${ENV('EVENT_LEDGER_BASE_URL')}/v1/events/{{ encodeURIComponent($json.event_id) }}/decision`, headers: LEDGER_HEADERS, ledger: true,
  }));
  f.add(codeNode('Check decision claim', at(7, 3), { from: ['Prepare decision claim'], body: `
const verdict = interpretDecisionClaim(response);
delete ctx.req;
return [{ json: { ...ctx, claim_route: verdict.route, claim_reason: verdict.reason, refs: verdict.refs } }];` }));
  f.add(switchNode('Route decision claim', at(8, 3), '$json.claim_route', ['claimed', 'already_decided', 'not_awaiting']));
  f.add(respondNode('Respond already decided', at(9, 3), "JSON.stringify({ status: 'already_decided', reason: $json.claim_reason, event_id: $json.event_id })", 200));
  f.add(respondNode('Respond not awaiting approval', at(9, 4), "JSON.stringify({ status: 'not_awaiting_approval', reason: $json.claim_reason, event_id: $json.event_id })", 409));
  f.chain('Prepare decision claim', 'Claim decision', 'Check decision claim', 'Route decision claim');
  f.connect('Route decision claim', 'Fetch ops settings', 0);
  f.connect('Route decision claim', 'Respond already decided', 1);
  f.connect('Route decision claim', 'Respond not awaiting approval', 2);

  f.add(rulesTab('Fetch ops settings', at(10, 3), 'Settings!A2:B'));
  f.add(codeNode('Prepare deal decision', at(0, 6), { from: ['Check decision claim'], body: `
ctx.settings = parseSettings(response);
ctx.req = { body: hubspotDecisionStageBody(ctx.action.decision, ctx.settings) };
return [{ json: ctx }];` }));
  f.add(httpNode('Move deal to decided stage', at(1, 6), { method: 'PATCH', url: `${ENV('HUBSPOT_BASE_URL')}/crm/v3/objects/deals/{{ $json.refs.deal_id }}`, headers: HUBSPOT_HEADERS, writes: true }));
  f.add(codeNode('Prepare ClickUp decision comment', at(2, 6), { from: ['Prepare deal decision'], body: `
if (!response.id) throw new Error('HubSpot did not return the deal');
ctx.req = { body: clickupCommentBody(clickupDecisionComment(ctx.action, ctx.refs)) };
return [{ json: ctx }];` }));
  f.add(httpNode('Add ClickUp decision comment', at(3, 6), { url: `${ENV('CLICKUP_BASE_URL')}/api/v2/task/{{ $json.refs.clickup_task_id }}/comment`, headers: CLICKUP_HEADERS, writes: true }));
  f.add(codeNode('Prepare Slack message update', at(4, 6), { from: ['Prepare ClickUp decision comment'], body: `
if (!response.id) throw new Error('ClickUp did not return a comment id');
ctx.clickup_comment_id = String(response.id);
ctx.req = { body: decidedMessage(ctx.refs, ctx.action) };
return [{ json: ctx }];` }));
  f.add(httpNode('Update Slack approval message', at(5, 6), { url: `${ENV('SLACK_BASE_URL')}/api/chat.update`, headers: SLACK_HEADERS, soft: true, writes: true }));
  f.add(codeNode('Prepare decision done', at(6, 6), { from: ['Prepare Slack message update'], body: `
const slack = describeHttp(response);
const updated = slack.ok && response.ok === true;
ctx.result = {
  status: ctx.action.decision, event_id: ctx.event_id, deal_id: ctx.refs.deal_id, clickup_task_id: ctx.refs.clickup_task_id,
  clickup_comment_id: ctx.clickup_comment_id, decided_by: ctx.action.user_id, slack_message_updated: updated,
  warnings: updated ? [] : ['slack_update_failed'],
};
ctx.req = { body: { run_id: String($execution.id) } };
return [{ json: ctx }];` }));
  f.add(httpNode('Mark decision done', at(7, 6), {
    url: `${ENV('EVENT_LEDGER_BASE_URL')}/v1/events/{{ encodeURIComponent($json.event_id) }}/decision/complete`, headers: LEDGER_HEADERS, ledger: true, soft: true,
  }));
  f.add(respondNode('Respond with decision', at(8, 6), "JSON.stringify($('Prepare decision done').first().json.result)", 200));
  f.chain('Fetch ops settings', 'Prepare deal decision', 'Move deal to decided stage', 'Prepare ClickUp decision comment', 'Add ClickUp decision comment', 'Prepare Slack message update',
    'Update Slack approval message', 'Prepare decision done', 'Mark decision done', 'Respond with decision');
  return f;
}

// The two HTTP nodes above read $json.req.body; the error handler keeps its payloads in other fields.
function patchErrorHandlerBodies(json) {
  json.nodes.find(node => node.name === 'Post Slack automation alert').parameters.jsonBody = '={{ JSON.stringify($json.slack) }}';
  json.nodes.find(node => node.name === 'Append error log row').parameters.jsonBody = "={{ JSON.stringify($('Compose alert').first().json.sheet) }}";
  return json;
}

export function buildAll() {
  return {
    'book-new-lead.json': buildMain().json(MAIN_WORKFLOW_ID),
    'alert-on-errors.json': patchErrorHandlerBodies(buildErrorHandler().json(ERROR_WORKFLOW_ID)),
    'handle-approval.json': buildApproval().json(APPROVAL_WORKFLOW_ID),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let stale = false;
  for (const [file, workflow] of Object.entries(buildAll())) {
    const target = join(here, file);
    const output = `${JSON.stringify(workflow, null, 2)}\n`;
    if (process.argv.includes('--check')) {
      let current = '';
      try { current = readFileSync(target, 'utf8'); } catch { /* missing counts as stale */ }
      if (current !== output) { console.error(`${file} is stale. Run: node workflow/build-workflow.mjs`); stale = true; }
    } else {
      writeFileSync(target, output);
      console.log(`wrote workflow/${file} (${workflow.nodes.length} nodes)`);
    }
  }
  if (stale) process.exitCode = 1;
}
