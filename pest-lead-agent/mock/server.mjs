// Zero-dependency mock of every vendor the Ridgeway lead workflow talks to.
// Shapes approximate HubSpot CRM v3/v4, ClickUp v2, Slack Web API, Gmail v1, Google Sheets v4,
// the Anthropic Messages API (served from recorded responses) and the FieldRoutes (PestRoutes) API.
// Every request is logged (secrets redacted) and faults can be injected per operation.
// It also plays the "event ledger", the small service that holds one claim per event id (see workflow/idempotency.js).
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECORDING_META_KEYS = ['recorded_at', 'recorded_request', 'synthetic', 'synthetic_reason', 'via'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const LEDGER_IN_FLIGHT_MS = 10 * 60 * 1000;
const LEDGER_RETRY_AFTER_SECONDS = 30;
// Slack answers with the channel id even when a message is posted by name, so the mock does the same.
const SLACK_CHANNEL_IDS = { '#leads': 'C0MOCKLEADS', '#automation-alerts': 'C0MOCKALERTS' };
// HubSpot default properties the workflows write (every portal has them); custom ones come from fixtures/hubspot/properties.json.
const HUBSPOT_DEFAULT_PROPERTIES = {
  contacts: ['email', 'phone', 'firstname', 'lastname', 'zip', 'address', 'city', 'state', 'lifecyclestage', 'createdate', 'hs_object_id'],
  deals: ['dealname', 'amount', 'pipeline', 'dealstage', 'closedate', 'createdate', 'hs_object_id'],
};
// What a brand-new portal has: HubSpot's own "Sales Pipeline" (the real one has these seven stages).
const HUBSPOT_FRESH_PIPELINE = {
  id: 'default', label: 'Sales Pipeline', displayOrder: 0,
  stages: [['appointmentscheduled', 'Appointment scheduled', '0.2'], ['qualifiedtobuy', 'Qualified to buy', '0.4'], ['presentationscheduled', 'Presentation scheduled', '0.6'],
    ['decisionmakerboughtin', 'Decision maker bought-in', '0.8'], ['contractsent', 'Contract sent', '0.9'], ['closedwon', 'Closed won', '1.0'], ['closedlost', 'Closed lost', '0.0']]
    .map(([id, label, probability], displayOrder) => ({ id, label, displayOrder, metadata: { probability, isClosed: String(probability === '1.0' || probability === '0.0') } })),
};
const hubspotError = (category, message, extra = {}) => ({ status: 'error', message, correlationId: '00000000-0000-4000-8000-000000000000', category, ...extra });

// clock and ledger are for tests: an injected clock makes the 10-minute stale claim and the 7-day TTL testable.
// seed: load the fictional CRM, ClickUp list and FieldRoutes records from fixtures/ (false starts every vendor empty).
// restore: a snapshot() taken from an earlier mock (the live-Slack stack keeps its state across restarts with it).
export async function startMock({ port = 0, host = '127.0.0.1', fixturesDir = join(root, 'fixtures'), clock = () => Date.now(), ledger = {}, seed = true, restore = null } = {}) {
  const inFlightMs = ledger.inFlightMs ?? LEDGER_IN_FLIGHT_MS;
  const ttlMs = ledger.ttlMs ?? LEDGER_TTL_MS;
  const frCustomers = readJson(join(fixturesDir, 'fieldroutes/customers.json')).customers;
  const frSchedule = readJson(join(fixturesDir, 'fieldroutes/schedule.json'));
  const opsRules = readJson(join(fixturesDir, 'ops-rules.json'));
  const hubspotDefinitions = readJson(join(fixturesDir, 'hubspot/properties.json'));
  const seedData = seed ? {
    contacts: readJson(join(fixturesDir, 'hubspot/contacts.json')).contacts,
    deals: readJson(join(fixturesDir, 'hubspot/deals.json')).deals,
    pipeline: readJson(join(fixturesDir, 'hubspot/pipeline.json')),
    clickup: readJson(join(fixturesDir, 'clickup/csr-queue.json')),
  } : null;
  const state = {};
  const clone = value => JSON.parse(JSON.stringify(value));

  function reset() {
    state.log = [];
    state.faults = [];
    state.ignoreKeys = new Set();
    state.simNowMs = null; // set through /__control { sim_time } so records carry the simulated time
    state.contacts = new Map();
    state.deals = new Map();
    state.tasks = [];
    if (seedData) {
      for (const contact of clone(seedData.contacts)) state.contacts.set(contact.id, contact);
      for (const deal of clone(seedData.deals)) state.deals.set(deal.id, deal);
      for (const task of seedData.clickup.tasks) {
        state.tasks.push({ id: task.id, name: task.name, description: '', priority: task.priority, tags: task.tags, status: { status: task.status }, list: { id: seedData.clickup.list.id },
          url: `https://app.clickup.example/t/${task.id}`, custom_fields: clone(task.custom_fields) });
      }
    }
    state.seeded = { contacts: state.contacts.size, deals: state.deals.size, tasks: state.tasks.length };
    // The HubSpot portal's schema. Seeded: an already set-up portal (the Ridgeway pipeline, the custom properties),
    // enforced like HubSpot: unknown properties, stages and pipelines are refused, ridgeway_event_id is unique.
    // seed: false keeps the schema permissive (unit tests that only exercise records).
    state.hubspot = seedData ? setUpPortal() : { enforce: false, pipelines: [], properties: { contacts: new Map(), deals: new Map() }, groups: { contacts: new Set(), deals: new Set() } };
    state.searchHidden = new Set();
    state.rejectExampleEmails = false;
    state.sheetSettings = {};
    // New records get ids that continue the seeded ones, in each vendor's own style.
    const next = ids => Math.max(0, ...ids.map(Number)) + 1;
    state.ids = { contact: seedData ? next([...state.contacts.keys()]) : 1000, deal: seedData ? next([...state.deals.keys()]) : 1000, task: parseInt('4qd000', 36), draft: 4417902836551, other: 1000 };
    state.drafts = [];
    state.slackMessages = [];
    state.slackEphemeral = [];
    state.sheetRows = [];
    state.ledger = new Map();
    state.idem = new Map();
    state.seq = 0;
  }
  reset();

  // Everything a later run needs to carry on where this one stopped (the request log and injected faults are not kept).
  const SNAPSHOT_KEYS = ['simNowMs', 'tasks', 'drafts', 'slackMessages', 'slackEphemeral', 'sheetRows', 'seeded', 'ids', 'seq'];
  function snapshot() {
    return clone({
      ...Object.fromEntries(SNAPSHOT_KEYS.map(key => [key, state[key]])),
      contacts: [...state.contacts.entries()], deals: [...state.deals.entries()], ledger: [...state.ledger.entries()], idem: [...state.idem.entries()],
    });
  }
  function load(saved) {
    for (const key of SNAPSHOT_KEYS) if (saved[key] !== undefined) state[key] = clone(saved[key]);
    for (const key of ['contacts', 'deals', 'ledger', 'idem']) if (saved[key]) state[key] = new Map(clone(saved[key]));
  }
  if (restore) load(restore);

  const newId = (kind = 'other') => String(state.ids[kind]++);

  function hubspotPortal(enforce) {
    const properties = { contacts: new Map(), deals: new Map() };
    for (const object of ['contacts', 'deals']) for (const name of HUBSPOT_DEFAULT_PROPERTIES[object]) properties[object].set(name, { name, type: 'string', fieldType: 'text', groupName: `${object.slice(0, -1)}information`, hasUniqueValue: false });
    return { enforce, portal: { portalId: 4242424, accountType: 'DEVELOPER_TEST', timeZone: 'US/Eastern', companyCurrency: 'USD', additionalCurrencies: [], utcOffset: '-05:00', utcOffsetMilliseconds: -18000000, uiDomain: 'app.hubspot.example', dataHostingLocation: 'na1' },
      pipelines: [], properties, groups: { contacts: new Set(['contactinformation']), deals: new Set(['dealinformation']) } };
  }
  function setUpPortal() {
    const portal = hubspotPortal(true);
    portal.pipelines = [clone(seedData.pipeline)];
    delete portal.pipelines[0]._note;
    for (const object of ['contacts', 'deals']) {
      portal.groups[object].add(hubspotDefinitions.group.name);
      for (const def of hubspotDefinitions.properties[object]) portal.properties[object].set(def.name, { hasUniqueValue: false, ...clone(def), groupName: hubspotDefinitions.group.name });
    }
    return portal;
  }
  // A brand-new portal: default properties and HubSpot's own Sales Pipeline only, no records. scripts/hubspot-setup.mjs
  // run against it creates the group, the properties and the pipeline, with generated numeric ids like a real portal.
  function freshPortal() {
    state.hubspot = hubspotPortal(true);
    state.hubspot.pipelines = [clone(HUBSPOT_FRESH_PIPELINE)];
    state.contacts = new Map();
    state.deals = new Map();
    state.seeded = { ...state.seeded, contacts: 0, deals: 0 };
  }
  const hubspotIds = { pipeline: 880100001, stage: 1290000001 };

  // HubSpot refuses a property that does not exist, a pipeline or stage it does not have, and a second record with a
  // unique value (ridgeway_event_id; email for contacts). Returns an error answer, or null.
  function hubspotRefusal(object, properties, current = null) {
    const props = properties || {};
    if (state.hubspot.enforce) {
      const unknown = Object.keys(props).filter(name => !state.hubspot.properties[object].has(name));
      if (unknown.length) return { status: 400, body: hubspotError('VALIDATION_ERROR', `Property values were not valid: [${unknown.map(name => JSON.stringify({ isValid: false, message: `Property "${name}" does not exist`, error: 'PROPERTY_DOESNT_EXIST', name })).join(',')}]`) };
      if (object === 'deals' && (props.pipeline !== undefined || props.dealstage !== undefined)) {
        const pipelineId = props.pipeline ?? current?.properties.pipeline;
        const pipeline = state.hubspot.pipelines.find(item => item.id === pipelineId);
        if (!pipeline) return { status: 400, body: hubspotError('VALIDATION_ERROR', `Property values were not valid: [${JSON.stringify({ isValid: false, message: `${pipelineId} is not a valid pipeline`, error: 'INVALID_OPTION', name: 'pipeline' })}]`) };
        const stage = props.dealstage ?? current?.properties.dealstage;
        if (!pipeline.stages.some(item => item.id === stage)) return { status: 400, body: hubspotError('VALIDATION_ERROR', `Property values were not valid: [${JSON.stringify({ isValid: false, message: `${stage} is not a valid stage of pipeline ${pipeline.id}`, error: 'INVALID_OPTION', name: 'dealstage' })}]`) };
      }
      for (const [name, value] of Object.entries(props)) {
        const def = state.hubspot.properties[object].get(name);
        if (!def?.hasUniqueValue || value === '' || value === null || value === undefined) continue;
        const holder = [...(object === 'deals' ? state.deals : state.contacts).values()].find(record => record !== current && String(record.properties[name] ?? '') === String(value));
        // HubSpot's exact body for this conflict is not in its public docs; the workflow does not read it (it reads the record instead).
        if (holder) return { status: 409, body: hubspotError('CONFLICT', `A ${object.slice(0, -1)} with ${name} ${value} already exists. Existing ID: ${holder.id}`) };
      }
    }
    if (object === 'contacts' && props.email) {
      if (state.rejectExampleEmails && /\.example$/i.test(props.email)) return { status: 400, body: hubspotError('VALIDATION_ERROR', `Property values were not valid: [${JSON.stringify({ isValid: false, message: `Email address ${props.email} is invalid`, error: 'INVALID_EMAIL', name: 'email' })}]`) };
      const holder = [...state.contacts.values()].find(record => record !== current && String(record.properties.email ?? '').toLowerCase() === String(props.email).toLowerCase());
      // The body commonly observed from HubSpot for a duplicate email (not in its public docs either).
      if (holder) return { status: 409, body: hubspotError('CONFLICT', `Contact already exists. Existing ID: ${holder.id}`) };
    }
    return null;
  }
  const notFound = id => ({ status: 404, body: hubspotError('OBJECT_NOT_FOUND', 'Object not found.  objectId are usually numeric.', { context: { id: [id] } }) });
  // GET /crm/v3/objects/<type>/<id>, or by a unique value with ?idProperty=<name> (email for contacts).
  function hubspotRead(object, id, query) {
    const records = object === 'deals' ? state.deals : state.contacts;
    const idProperty = query.get('idProperty');
    let record;
    if (!idProperty) record = records.get(id);
    else {
      const def = state.hubspot.properties[object].get(idProperty);
      const unique = (object === 'contacts' && idProperty === 'email') || def?.hasUniqueValue || !state.hubspot.enforce;
      if (!unique) return { status: 400, body: hubspotError('VALIDATION_ERROR', `${idProperty} is not a unique identifier property`) };
      record = [...records.values()].find(item => String(item.properties[idProperty] ?? '').toLowerCase() === id.toLowerCase());
    }
    if (!record) return notFound(id);
    const wanted = (query.get('properties') || '').split(',').filter(Boolean);
    const properties = wanted.length ? Object.fromEntries(wanted.map(name => [name, record.properties[name] ?? null]).concat([['hs_object_id', record.id]])) : record.properties;
    return { status: 200, body: { id: record.id, properties, createdAt: record.createdAt ?? record.properties.createdate ?? null, updatedAt: record.updatedAt ?? null, archived: false } };
  }
  const clickupFieldIds = new Set((seedData?.clickup.fields ?? []).map(field => field.id));

  function takeFault(op) {
    const fault = state.faults.find(item => item.op === op && item.remaining > 0);
    if (!fault) return null;
    fault.remaining -= 1;
    return fault;
  }

  // 32-bit FNV-1a, so "already sold" windows are the same on every run.
  function hash01(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h / 4294967296;
  }
  const bookedKeys = new Set((frSchedule.booked || []).map(item => `${item.technician}|${item.date}|${item.start}`));

  // Spots = a technician's free two-hour arrival windows on his or her route days (see fixtures/fieldroutes/schedule.json).
  function slotsFor(officeId, dateStart, dateEnd) {
    const spots = [];
    const techs = frSchedule.technicians.filter(tech => tech.officeID === String(officeId));
    for (let date = dateStart; date <= dateEnd; date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (weekday === 0) continue;
      const windows = weekday === 6 ? frSchedule.windows.saturday : frSchedule.windows.weekday;
      windows.forEach(([start, end], index) => {
        for (const tech of techs) {
          if (!tech.route_days.includes(weekday)) continue;
          if (bookedKeys.has(`${tech.id}|${date}|${start}`)) continue;
          const reserved = start === frSchedule.emergency_rule.reserved_window_start;
          if (!reserved && hash01(`${frSchedule.background_booking.seed}|${tech.id}|${date}|${index}`) < frSchedule.background_booking.fill_rate) continue;
          spots.push({ spotID: `${tech.id}-${date}-${index}`, officeID: String(officeId), date, start, end, duration: '120', status: 'open', routeID: tech.routeID, employeeID: tech.employeeID });
        }
      });
    }
    return spots;
  }

  const nowIso = () => new Date(state.simNowMs ?? clock()).toISOString();

  function anthropicResponse(body) {
    const eventId = body?.metadata?.user_id;
    const problems = [];
    if (body?.model !== 'claude-haiku-5-5') problems.push(`unexpected model ${body?.model}`);
    if (body?.output_config?.format?.type !== 'json_schema') problems.push('missing output_config.format json_schema');
    for (const banned of ['temperature', 'top_p', 'top_k', 'prefill']) if (banned in (body || {})) problems.push(`${banned} is not accepted for this model`);
    if (body?.messages?.at(-1)?.role !== 'user') problems.push('messages must end with a user turn');
    if (problems.length) return { status: 400, fault: 'invalid_request', body: { type: 'error', error: { type: 'invalid_request_error', message: problems.join('; ') } } };
    const file = join(fixturesDir, 'llm', `${eventId}.json`);
    if (!eventId || !existsSync(file)) {
      return { status: 500, fault: 'missing_recording',
        body: { type: 'error', error: { type: 'api_error', message: `mock: no recorded Claude response for event_id ${eventId}. Run scripts/record-llm.mjs.` } } };
    }
    const recording = readJson(file);
    if (recording.recorded_request && !isDeepStrictEqual(recording.recorded_request, body)) {
      return { status: 500, fault: 'stale_recording',
        body: { type: 'error', error: { type: 'api_error', message: `mock: recording for ${eventId} was made for a different request. Re-run scripts/record-llm.mjs.` } } };
    }
    const response = { ...recording };
    for (const key of RECORDING_META_KEYS) delete response[key];
    return { status: 200, body: response, recording: { synthetic: Boolean(recording.synthetic) } };
  }

  // Returns { op, status, body, extra }
  function route(method, path, query, body, headers) {
    const decoded = decodeURIComponent(path);
    let m;
    const authed = Boolean(headers.authorization || headers['x-api-key'] || headers.authenticationkey);
    const reject = (op, status, message) => ({ op, status, fault: 'rejected', body: { message } });

    if (method === 'POST' && decoded === '/anthropic/v1/messages') {
      if (!headers['x-api-key'] || headers['anthropic-version'] !== '2023-06-01') return reject('anthropic.messages', 401, 'missing x-api-key or anthropic-version');
      return { op: 'anthropic.messages', ...anthropicResponse(body) };
    }
    if (decoded.startsWith('/hubspot/')) {
      if (!headers.authorization?.startsWith('Bearer ')) return reject('hubspot.unauthorized', 401, 'missing bearer token');
      if (method === 'POST' && decoded === '/hubspot/crm/v3/objects/contacts/search') {
        const groups = body?.filterGroups || [];
        // searchHidden: records HubSpot's search has not indexed yet ("it may take a few moments", search docs).
        const results = [...state.contacts.values()].filter(contact => !state.searchHidden.has(contact.id) && groups.some(group => group.filters.every(filter =>
          filter.operator === 'EQ' && String(contact.properties[filter.propertyName] ?? '').toLowerCase() === String(filter.value).toLowerCase())));
        return { op: 'hubspot.search_contacts', status: 200, body: { total: results.length, results: results.slice(0, body?.limit || 10) } };
      }
      if (method === 'POST' && decoded === '/hubspot/crm/v3/objects/contacts') {
        return { op: 'hubspot.create_contact', apply: () => {
          const refused = hubspotRefusal('contacts', body?.properties);
          if (refused) return refused;
          const id = newId('contact');
          const contact = { id, properties: { ...body?.properties, hs_object_id: id, createdate: nowIso() }, createdAt: nowIso(), updatedAt: nowIso(), archived: false };
          state.contacts.set(id, contact);
          return { status: 201, body: contact };
        } };
      }
      if (method === 'PATCH' && (m = decoded.match(/^\/hubspot\/crm\/v3\/objects\/contacts\/(\w+)$/))) {
        return { op: 'hubspot.update_contact', apply: () => {
          const contact = state.contacts.get(m[1]);
          if (!contact) return notFound(m[1]);
          const refused = hubspotRefusal('contacts', body?.properties, contact);
          if (refused) return refused;
          Object.assign(contact.properties, body?.properties);
          contact.updatedAt = nowIso();
          return { status: 200, body: contact };
        } };
      }
      if (method === 'POST' && decoded === '/hubspot/crm/v3/objects/deals/search') {
        const groups = body?.filterGroups || [];
        const results = [...state.deals.values()].filter(deal => !state.searchHidden.has(deal.id) && groups.some(group => group.filters.every(filter =>
          filter.operator === 'EQ' && String(deal.properties[filter.propertyName] ?? '') === String(filter.value))));
        return { op: 'hubspot.search_deals', status: 200, body: { total: results.length, results: results.slice(0, body?.limit || 10) } };
      }
      if (method === 'POST' && decoded === '/hubspot/crm/v3/objects/deals') {
        return { op: 'hubspot.create_deal', apply: () => {
          const refused = hubspotRefusal('deals', body?.properties);
          if (refused) return refused;
          const id = newId('deal');
          const deal = { id, properties: { ...body?.properties, hs_object_id: id, createdate: nowIso() }, archived: false };
          state.deals.set(id, deal);
          return { status: 201, body: deal };
        } };
      }
      if (method === 'PATCH' && (m = decoded.match(/^\/hubspot\/crm\/v3\/objects\/deals\/(\w+)$/))) {
        return { op: 'hubspot.update_deal', apply: () => {
          const deal = state.deals.get(m[1]);
          if (!deal) return notFound(m[1]);
          const refused = hubspotRefusal('deals', body?.properties, deal);
          if (refused) return refused;
          Object.assign(deal.properties, body?.properties);
          return { status: 200, body: deal };
        } };
      }
      if (method === 'GET' && (m = decoded.match(/^\/hubspot\/crm\/v3\/objects\/(contacts|deals)\/([^/]+)$/))) {
        return { op: m[1] === 'deals' ? 'hubspot.get_deal' : 'hubspot.get_contact', ...hubspotRead(m[1], m[2], query) };
      }
      if (method === 'GET' && decoded === '/hubspot/crm/v3/pipelines/deals') {
        return { op: 'hubspot.get_pipelines', status: 200, body: { results: clone(state.hubspot.pipelines) } };
      }
      // Pipelines and stages: HubSpot generates their ids (the create body names labels, order and probability only).
      if (method === 'POST' && decoded === '/hubspot/crm/v3/pipelines/deals') {
        return { op: 'hubspot.create_pipeline', apply: () => {
          const stages = Array.isArray(body?.stages) ? body.stages : [];
          if (!body?.label || !stages.length || stages.some(stage => !stage.label || stage.metadata?.probability === undefined)) return { status: 400, body: hubspotError('VALIDATION_ERROR', 'label, stages and each stage\'s label and metadata.probability are required') };
          if (state.hubspot.pipelines.some(item => item.label === body.label)) return { status: 409, body: hubspotError('VALIDATION_ERROR', `A pipeline labelled ${body.label} already exists`) };
          if (new Set(stages.map(stage => stage.label)).size !== stages.length) return { status: 400, body: hubspotError('VALIDATION_ERROR', 'stage labels must be unique') };
          const pipeline = { id: String(hubspotIds.pipeline++), label: body.label, displayOrder: body.displayOrder ?? 0, createdAt: nowIso(), archived: false,
            stages: stages.map(stage => ({ id: String(hubspotIds.stage++), label: stage.label, displayOrder: stage.displayOrder ?? 0, metadata: { probability: String(stage.metadata.probability), isClosed: String(['1.0', '0.0', '1', '0'].includes(String(stage.metadata.probability))) }, createdAt: nowIso(), archived: false })) };
          state.hubspot.pipelines.push(pipeline);
          return { status: 201, body: clone(pipeline) };
        } };
      }
      if (method === 'POST' && (m = decoded.match(/^\/hubspot\/crm\/v3\/pipelines\/deals\/([^/]+)\/stages$/))) {
        return { op: 'hubspot.create_pipeline_stage', apply: () => {
          const pipeline = state.hubspot.pipelines.find(item => item.id === m[1]);
          if (!pipeline) return notFound(m[1]);
          if (!body?.label || body.metadata?.probability === undefined) return { status: 400, body: hubspotError('VALIDATION_ERROR', 'label and metadata.probability are required') };
          if (pipeline.stages.some(stage => stage.label === body.label)) return { status: 409, body: hubspotError('VALIDATION_ERROR', `A stage labelled ${body.label} already exists`) };
          const stage = { id: String(hubspotIds.stage++), label: body.label, displayOrder: body.displayOrder ?? pipeline.stages.length, metadata: { probability: String(body.metadata.probability), isClosed: 'false' }, createdAt: nowIso(), archived: false };
          pipeline.stages.push(stage);
          return { status: 201, body: clone(stage) };
        } };
      }
      // Properties and property groups (GET one, POST one). A real portal answers 404 for a property that is not there.
      if ((m = decoded.match(/^\/hubspot\/crm\/v3\/properties\/(contacts|deals)\/groups(?:\/([^/]+))?$/))) {
        const groups = state.hubspot.groups[m[1]];
        if (method === 'GET' && m[2]) return groups.has(m[2]) ? { op: 'hubspot.get_property_group', status: 200, body: { name: m[2], label: m[2], displayOrder: -1, archived: false } } : { op: 'hubspot.get_property_group', ...notFound(m[2]) };
        if (method === 'POST' && !m[2]) {
          return { op: 'hubspot.create_property_group', apply: () => {
            if (!body?.name || !body?.label) return { status: 400, body: hubspotError('VALIDATION_ERROR', 'name and label are required') };
            if (groups.has(body.name)) return { status: 409, body: hubspotError('OBJECT_ALREADY_EXISTS', `A property group named ${body.name} already exists`) };
            groups.add(body.name);
            return { status: 201, body: { name: body.name, label: body.label, displayOrder: body.displayOrder ?? -1, archived: false } };
          } };
        }
      }
      if ((m = decoded.match(/^\/hubspot\/crm\/v3\/properties\/(contacts|deals)(?:\/([^/]+))?$/))) {
        const props = state.hubspot.properties[m[1]];
        if (method === 'GET' && m[2]) return props.has(m[2]) ? { op: 'hubspot.get_property', status: 200, body: clone(props.get(m[2])) } : { op: 'hubspot.get_property', ...notFound(m[2]) };
        if (method === 'POST' && !m[2]) {
          return { op: 'hubspot.create_property', apply: () => {
            if (!body?.name || !body?.label || !body?.type || !body?.fieldType || !body?.groupName) return { status: 400, body: hubspotError('VALIDATION_ERROR', 'groupName, name, label, type and fieldType are required') };
            if (!state.hubspot.groups[m[1]].has(body.groupName)) return { status: 400, body: hubspotError('VALIDATION_ERROR', `Property group ${body.groupName} does not exist`) };
            if (props.has(body.name)) return { status: 409, body: hubspotError('OBJECT_ALREADY_EXISTS', `Property named ${body.name} already exists`) };
            const def = { hasUniqueValue: false, ...clone(body), createdAt: nowIso(), archived: false };
            props.set(body.name, def);
            return { status: 201, body: clone(def) };
          } };
        }
      }
      if (method === 'GET' && decoded === '/hubspot/account-info/v3/details') {
        return { op: 'hubspot.get_account', status: 200, body: clone(state.hubspot.portal ?? hubspotPortal(false).portal) };
      }
      if (method === 'PUT' && (m = decoded.match(/^\/hubspot\/crm\/v4\/objects\/deals\/(\w+)\/associations\/default\/contacts\/(\w+)$/))) {
        if (!state.deals.has(m[1]) || !state.contacts.has(m[2])) return { op: 'hubspot.associate_deal_contact', apply: () => ({ status: 404, body: { status: 'error', message: 'unknown deal or contact' } }) };
        return { op: 'hubspot.associate_deal_contact', apply: () => {
          const deal = state.deals.get(m[1]);
          const results = (deal.associations ??= { contacts: { results: [] } }).contacts.results;
          if (!results.some(item => item.id === m[2])) results.push({ id: m[2], type: 'deal_to_contact' });
          // BatchResponsePublicDefaultAssociation, the documented answer of the v4 default association (associationTypeId 3: deal to contact).
          return { status: 200, body: { status: 'COMPLETE', results: [{ from: { id: m[1] }, to: { id: m[2] }, associationSpec: { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 } }], startedAt: nowIso(), completedAt: nowIso() } };
        } };
      }
    }
    if (decoded.startsWith('/clickup/')) {
      if (!headers.authorization) return reject('clickup.unauthorized', 401, 'missing token');
      if (method === 'GET' && (m = decoded.match(/^\/clickup\/api\/v2\/list\/(\w+)$/)) && seedData?.clickup.list.id === m[1]) {
        return { op: 'clickup.get_list', status: 200, body: seedData.clickup.list };
      }
      if (method === 'GET' && (m = decoded.match(/^\/clickup\/api\/v2\/list\/(\w+)\/field$/)) && seedData?.clickup.list.id === m[1]) {
        return { op: 'clickup.get_fields', status: 200, body: { fields: seedData.clickup.fields } };
      }
      if (method === 'POST' && (m = decoded.match(/^\/clickup\/api\/v2\/list\/(\w+)\/task$/))) {
        // ClickUp v2 custom_fields: [{ id, value }]. A field id the list does not have is refused, like ClickUp does.
        const fields = Array.isArray(body?.custom_fields) ? body.custom_fields : [];
        const unknown = clickupFieldIds.size ? fields.filter(field => !clickupFieldIds.has(field?.id)) : [];
        if (unknown.length) return { op: 'clickup.create_task', apply: () => ({ status: 400, body: { err: `Custom field ${unknown[0]?.id} not found on list`, ECODE: 'FIELD_033' } }) };
        return { op: 'clickup.create_task', apply: () => {
          const id = `86a${Number(newId('task')).toString(36)}`;
          const task = { id, name: body?.name, description: body?.description, priority: body?.priority, tags: body?.tags, status: { status: 'to do' }, list: { id: m[1] }, url: `https://app.clickup.example/t/${id}`, date_created: String(state.simNowMs ?? clock()),
            ...(fields.length ? { custom_fields: fields.map(field => ({ id: field.id, name: seedData?.clickup.fields.find(item => item.id === field.id)?.name ?? null, value: field.value })) } : {}) };
          state.tasks.push(task);
          return { status: 200, body: task };
        } };
      }
      if (method === 'POST' && (m = decoded.match(/^\/clickup\/api\/v2\/task\/(\w+)\/comment$/))) {
        return { op: 'clickup.create_comment', apply: () => {
          const task = state.tasks.find(item => item.id === m[1]);
          if (!task) return { status: 404, body: { err: 'Task not found, deleted', ECODE: 'ITEM_013' } };
          if (typeof body?.comment_text !== 'string' || !body.comment_text) return { status: 400, body: { err: 'Comment text required', ECODE: 'COMM_002' } };
          const comment = { id: Number(newId('other')) + 90000000, comment_text: body.comment_text, date: String(state.simNowMs ?? clock()) };
          (task.comments ??= []).push(comment);
          return { status: 200, body: { id: comment.id, hist_id: `hist-${comment.id}`, date: Number(comment.date) } };
        } };
      }
    }
    if (decoded.startsWith('/slack/')) {
      if (!headers.authorization?.startsWith('Bearer ')) return reject('slack.unauthorized', 401, 'missing bearer token');
      if (method === 'POST' && decoded === '/slack/api/chat.postMessage') {
        if (!body?.channel || !(body.text || body.blocks)) return { op: 'slack.post_message', apply: () => ({ status: 200, body: { ok: false, error: body?.channel ? 'no_text' : 'channel_not_found' } }) };
        return { op: 'slack.post_message', apply: () => {
          const ts = `${Math.floor((state.simNowMs ?? clock()) / 1000)}.${String(state.slackMessages.length + 1).padStart(6, '0')}`;
          const channelId = SLACK_CHANNEL_IDS[body.channel] ?? body.channel;
          state.slackMessages.push({ channel: body.channel, channel_id: channelId, text: body.text, ...(body.blocks ? { blocks: body.blocks } : {}), ts });
          return { status: 200, body: { ok: true, channel: channelId, ts, message: { text: body.text } } };
        } };
      }
      // Slack answers errors with HTTP 200 and ok: false.
      if (method === 'POST' && decoded === '/slack/api/chat.update') {
        return { op: 'slack.update_message', apply: () => {
          const message = state.slackMessages.find(item => item.channel_id === body?.channel && item.ts === body?.ts);
          if (!message) return { status: 200, body: { ok: false, error: body?.channel ? 'message_not_found' : 'channel_not_found' } };
          Object.assign(message, { text: body.text, blocks: body.blocks, edited: { ts: `${Math.floor((state.simNowMs ?? clock()) / 1000)}.000000` } });
          return { status: 200, body: { ok: true, channel: message.channel_id, ts: message.ts, text: body.text } };
        } };
      }
      if (method === 'POST' && decoded === '/slack/api/chat.postEphemeral') {
        return { op: 'slack.post_ephemeral', apply: () => {
          if (!body?.channel || !body?.user || !body?.text) return { status: 200, body: { ok: false, error: body?.user ? 'channel_not_found' : 'user_not_in_channel' } };
          const messageTs = `${Math.floor((state.simNowMs ?? clock()) / 1000)}.${String(state.slackEphemeral.length + 1).padStart(6, '0')}`;
          state.slackEphemeral.push({ channel: body.channel, user: body.user, text: body.text, message_ts: messageTs });
          return { status: 200, body: { ok: true, message_ts: messageTs } };
        } };
      }
    }
    if (decoded.startsWith('/gmail/')) {
      if (!headers.authorization) return reject('gmail.unauthorized', 401, 'missing token');
      if (method === 'POST' && decoded === '/gmail/gmail/v1/users/me/drafts') {
        return { op: 'gmail.create_draft', apply: () => {
          const id = `r${newId('draft')}`;
          state.drafts.push({ id });
          return { status: 200, body: { id, message: { id: `m${id}`, threadId: `t${id}`, labelIds: ['DRAFT'] } } };
        } };
      }
      if (method === 'POST' && /\/(messages|drafts)\/send$/.test(decoded)) {
        return { op: 'gmail.send', status: 403, fault: 'forbidden_send', body: { error: { code: 403, message: 'mock: this demo must never send email' } } };
      }
    }
    if (decoded.startsWith('/sheets/')) {
      if (!headers.authorization) return reject('sheets.unauthorized', 401, 'missing token');
      if (method === 'GET' && (m = decoded.match(/^\/sheets\/v4\/spreadsheets\/([^/]+)\/values\/(.+)$/))) {
        const tab = opsRules.tabs[m[2].split('!')[0]];
        if (m[1] !== opsRules.spreadsheet_id || !tab) return { op: 'sheets.get_values', status: 404, body: { error: { code: 404, message: `Requested entity was not found: ${m[1]} ${m[2]}` } } };
        // sheet_settings (/__control) overrides Settings rows: the live-HubSpot runner puts the portal's ids there.
        let rows = tab.rows;
        if (m[2].split('!')[0] === 'Settings' && Object.keys(state.sheetSettings).length) {
          rows = tab.rows.map(([key, value]) => [key, Object.prototype.hasOwnProperty.call(state.sheetSettings, key) ? state.sheetSettings[key] : value]);
          for (const [key, value] of Object.entries(state.sheetSettings)) if (!rows.some(row => row[0] === key)) rows.push([key, value]);
        }
        return { op: 'sheets.get_values', status: 200, body: { range: m[2], majorDimension: 'ROWS', values: m[2].includes('A1') ? [tab.header, ...rows] : rows } };
      }
      if (method === 'POST' && (m = decoded.match(/^\/sheets\/v4\/spreadsheets\/([^/]+)\/values\/(.+):append$/))) {
        return { op: 'sheets.append', apply: () => { state.sheetRows.push({ range: m[2], values: body?.values }); return { status: 200, body: { spreadsheetId: m[1], tableRange: `${m[2]}1:H1`, updates: { spreadsheetId: m[1], updatedRange: m[2], updatedRows: 1, updatedColumns: body?.values?.[0]?.length ?? 0, updatedCells: body?.values?.[0]?.length ?? 0 } } }; } };
      }
    }
    if (decoded.startsWith('/ledger/')) {
      if (!headers.authorization?.startsWith('Bearer ')) return reject('ledger.unauthorized', 401, 'missing bearer token');
      // The ledger is the dedupe authority, so its calls are not replayed by Idempotency-Key (keyed: false):
      // each is idempotent on (event_id, run_id) instead.
      if (method === 'POST' && decoded === '/ledger/v1/events/claim') {
        return { op: 'ledger.claim', keyed: false, apply: () => {
          const eventId = body?.event_id;
          const runId = body?.run_id === undefined ? '' : String(body.run_id);
          if (typeof eventId !== 'string' || !eventId || !runId) return { status: 400, body: { error: 'event_id and run_id are required' } };
          const now = clock();
          for (const [id, item] of state.ledger) if (now - item.updated_ms > ttlMs) state.ledger.delete(id);
          const existing = state.ledger.get(eventId);
          const take = reclaimed => {
            state.ledger.set(eventId, { event_id: eventId, state: 'in_flight', run_id: runId, attempts: (existing?.attempts ?? 0) + 1, claimed_at: new Date(now).toISOString(), claimed_ms: now, updated_ms: now });
            return { status: 200, body: { outcome: 'claimed', ...(reclaimed ? { reclaimed } : {}) } };
          };
          if (!existing) return take(null);
          if (existing.state === 'done') return { status: 200, body: { outcome: 'done', status: existing.status } };
          if (existing.state === 'in_flight') {
            if (existing.run_id === runId) return { status: 200, body: { outcome: 'claimed' } };
            if (now - existing.claimed_ms < inFlightMs) return { status: 200, body: { outcome: 'in_flight', retry_after_s: LEDGER_RETRY_AFTER_SECONDS } };
            return take('stale_attempt');
          }
          return take('after_failure');
        } };
      }
      if (method === 'POST' && decoded === '/ledger/v1/events/complete') {
        return { op: 'ledger.complete', keyed: false, apply: () => {
          const existing = state.ledger.get(body?.event_id);
          if (!existing || existing.run_id !== String(body?.run_id)) return { status: 200, body: { ok: false, outcome: 'not_owner' } };
          Object.assign(existing, { state: 'done', status: body.status, ...(body.refs ? { refs: body.refs } : {}), completed_at: new Date(clock()).toISOString(), updated_ms: clock() });
          return { status: 200, body: { ok: true } };
        } };
      }
      // One approval decision per lead, first wins. The claim answers with the ids the lead's run stored (refs).
      if (method === 'POST' && (m = decoded.match(/^\/ledger\/v1\/events\/([A-Za-z0-9_.:-]+)\/decision$/))) {
        return { op: 'ledger.claim_decision', keyed: false, apply: () => {
          const runId = body?.run_id === undefined ? '' : String(body.run_id);
          if (!runId || !['approved', 'on_hold'].includes(body?.decision) || !body?.user_id) return { status: 400, body: { error: 'run_id, decision and user_id are required' } };
          const entry = state.ledger.get(m[1]);
          if (!entry) return { status: 200, body: { outcome: 'unknown_event' } };
          if (entry.state !== 'done' || entry.status !== 'approval_required' || !entry.refs) return { status: 200, body: { outcome: 'not_awaiting_approval', state: entry.state, status: entry.status ?? null } };
          const now = clock();
          const current = entry.decision;
          if (current?.state === 'done') return { status: 200, body: { outcome: 'decided', decision: current.decision, user_id: current.user_id, decided_at: current.decided_at } };
          if (current?.state === 'in_flight' && current.run_id !== runId && now - current.claimed_ms < inFlightMs) return { status: 200, body: { outcome: 'in_flight', retry_after_s: LEDGER_RETRY_AFTER_SECONDS } };
          if (current?.state !== 'in_flight' || current.run_id !== runId) {
            entry.decision = { state: 'in_flight', decision: body.decision, user_id: String(body.user_id), action_ts: body.action_ts ?? null, run_id: runId, attempts: (current?.attempts ?? 0) + 1, claimed_at: new Date(now).toISOString(), claimed_ms: now };
            entry.updated_ms = now;
          }
          return { status: 200, body: { outcome: 'claimed', decision: entry.decision.decision, refs: entry.refs } };
        } };
      }
      if (method === 'POST' && (m = decoded.match(/^\/ledger\/v1\/events\/([A-Za-z0-9_.:-]+)\/decision\/complete$/))) {
        return { op: 'ledger.complete_decision', keyed: false, apply: () => {
          const decision = state.ledger.get(m[1])?.decision;
          if (!decision || decision.run_id !== String(body?.run_id)) return { status: 200, body: { ok: false, outcome: 'not_owner' } };
          Object.assign(decision, { state: 'done', decided_at: new Date(clock()).toISOString() });
          return { status: 200, body: { ok: true } };
        } };
      }
      if (method === 'POST' && (m = decoded.match(/^\/ledger\/v1\/runs\/(\w+)\/fail$/))) {
        return { op: 'ledger.fail', keyed: false, apply: () => {
          const reason = String(body?.reason ?? '').slice(0, 300);
          const entry = [...state.ledger.values()].find(item => item.run_id === m[1] && item.state === 'in_flight');
          if (entry) {
            Object.assign(entry, { state: 'failed', failed_at: new Date(clock()).toISOString(), reason, updated_ms: clock() });
            return { status: 200, body: { event_id: entry.event_id, state: 'failed' } };
          }
          // A failed approval run hands its decision back, so the approver's next click is processed again.
          const decided = [...state.ledger.values()].find(item => item.decision?.run_id === m[1] && item.decision.state === 'in_flight');
          if (decided) {
            Object.assign(decided.decision, { state: 'failed', failed_at: new Date(clock()).toISOString(), reason });
            return { status: 200, body: { event_id: decided.event_id, state: 'decision_failed' } };
          }
          return { status: 200, body: { event_id: null, state: 'unknown_run' } };
        } };
      }
    }
    if (decoded.startsWith('/fieldroutes/')) {
      if (!headers.authenticationkey || !headers.authenticationtoken) return reject('fieldroutes.unauthorized', 401, 'missing authenticationKey/authenticationToken');
      if (method === 'GET' && decoded === '/fieldroutes/customer/search') {
        const phone = query.get('phone');
        const email = query.get('email')?.toLowerCase();
        const customers = frCustomers.filter(c => (phone && c.phone1 === phone) || (email && c.email === email));
        return { op: 'fieldroutes.search_customers', status: 200, body: { success: true, count: customers.length, customerIDs: customers.map(c => c.customerID), ...(query.get('includeData') === '1' ? { customers } : {}) } };
      }
      if (method === 'GET' && decoded === '/fieldroutes/spot/search') {
        const offices = JSON.parse(query.get('officeIDs') || '[]');
        const spots = offices.flatMap(office => slotsFor(office, query.get('dateStart'), query.get('dateEnd')));
        return { op: 'fieldroutes.search_spots', status: 200, body: { success: true, count: spots.length, spots } };
      }
    }
    return { op: 'unknown', status: 404, fault: 'unknown_route', body: { message: `mock: no route for ${method} ${decoded}` } };
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://mock.local');
      const raw = Buffer.concat(chunks).toString('utf8');
      const send = (status, payload, headers = {}) => {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(text);
      };
      if (url.pathname.startsWith('/__')) {
        if (url.pathname === '/__log') return send(200, state.log);
        if (url.pathname === '/__state') {
          return send(200, { contacts: [...state.contacts.values()], deals: [...state.deals.values()], tasks: state.tasks,
            hubspot: { pipelines: state.hubspot.pipelines, properties: Object.fromEntries(Object.entries(state.hubspot.properties).map(([object, defs]) => [object, [...defs.values()]])), groups: Object.fromEntries(Object.entries(state.hubspot.groups).map(([object, names]) => [object, [...names]])) }, drafts: state.drafts, slack_messages: state.slackMessages, slack_ephemeral: state.slackEphemeral, sheet_rows: state.sheetRows, seeded: state.seeded,
            ledger: [...state.ledger.values()].map(({ claimed_ms, updated_ms, ...item }) => (item.decision ? { ...item, decision: (({ claimed_ms: _ms, ...decision }) => decision)(item.decision) } : item)) });
        }
        if (url.pathname === '/__reset' && req.method === 'POST') { reset(); return send(200, { ok: true }); }
        if (url.pathname === '/__control' && req.method === 'POST') {
          const control = JSON.parse(raw || '{}');
          if (control.sim_time !== undefined) state.simNowMs = control.sim_time === null ? null : Date.parse(control.sim_time);
          for (const fault of control.faults || []) state.faults.push({ ...fault, remaining: fault.times ?? 1 });
          // Operations of vendors that do not honor Idempotency-Key (the README says HubSpot, Slack and Gmail do not):
          // a repeated call creates a second record, so only the workflow's own search-before-create can prevent it.
          for (const op of control.ignore_idempotency || []) state.ignoreKeys.add(op);
          for (const contact of control.hubspot_contacts || []) state.contacts.set(contact.id, { createdAt: new Date(0).toISOString(), archived: false, ...contact });
          for (const item of control.ledger_events || []) state.ledger.set(item.event_id, { attempts: 1, claimed_at: new Date(clock()).toISOString(), claimed_ms: clock(), updated_ms: clock(), ...item });
          if (control.hubspot_portal === 'fresh') freshPortal();
          if (control.hubspot_account) state.hubspot.portal = { ...(state.hubspot.portal ?? hubspotPortal(false).portal), ...control.hubspot_account };
          for (const id of control.hubspot_search_hidden || []) state.searchHidden.add(String(id));
          if (control.hubspot_reject_example_emails !== undefined) state.rejectExampleEmails = Boolean(control.hubspot_reject_example_emails);
          if (control.sheet_settings) Object.assign(state.sheetSettings, control.sheet_settings);
          // A new run of the stack against the same HubSpot portal: every other vendor and the ledger start over.
          if (control.new_day) {
            state.ledger = new Map(); state.idem = new Map(); state.drafts = []; state.slackMessages = []; state.slackEphemeral = []; state.sheetRows = [];
            state.tasks = state.tasks.slice(0, state.seeded.tasks);
          }
          return send(200, { ok: true, faults: state.faults.length, contacts: state.contacts.size });
        }
        return send(404, { message: 'unknown control route' });
      }
      let body = null;
      if (raw) { try { body = JSON.parse(raw); } catch { body = { _unparsed: raw.slice(0, 200) }; } }
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
      const result = route(req.method, url.pathname, url.searchParams, body, headers);
      const fault = result.op !== 'unknown' && !result.op.endsWith('.unauthorized') ? takeFault(result.op) : null;
      const key = headers['idempotency-key'] || null;
      const entry = {
        seq: state.seq++, at_ms: Date.now(), op: result.op, method: req.method, path: decodeURIComponent(url.pathname),
        query: Object.fromEntries(url.searchParams), body, status: result.status,
        fault: result.fault || null,
        idempotency_key: key,
        run_id: headers['x-run-id'] || null,
        raw_sha256: raw ? createHash('sha256').update(raw).digest('hex') : null,
        auth: { header_present: Boolean(headers.authorization || headers['x-api-key'] || headers.authenticationkey) },
        ...(result.recording ? { recording: result.recording } : {}),
      };
      // A fault before the commit behaves like a vendor that rejected the call: nothing is changed.
      // A fault with after_commit behaves like a lost response: the change IS committed, the reply is late.
      const commitsBeforeFault = !fault || fault.after_commit;
      if (result.apply) {
        const keyed = result.keyed !== false;
        if (keyed && !key) entry.fault = 'missing_idempotency_key';
        const slot = keyed && key && !state.ignoreKeys.has(result.op) ? `${result.op}|${key}` : null;
        const replay = slot ? state.idem.get(slot) : null;
        if (replay && replay.raw_sha256 !== entry.raw_sha256) {
          // Like Stripe: the same key with a different request body is an error, never a silent replay.
          Object.assign(result, { status: 422, body: { error: { message: 'mock: Idempotency-Key reused with a different request body' } } });
          entry.fault = 'idempotency_key_body_mismatch';
        } else if (replay) {
          Object.assign(result, { status: replay.status, body: replay.body });
          entry.idempotent_replay = true;
        } else if (commitsBeforeFault) {
          Object.assign(result, result.apply());
          if (slot) state.idem.set(slot, { status: result.status, body: result.body, raw_sha256: entry.raw_sha256 });
        }
        entry.status = result.status;
        if (result.op.startsWith('ledger.')) entry.outcome = result.body?.outcome ?? result.body?.state ?? null;
      }
      if (fault) {
        entry.fault = fault.after_commit ? 'injected_after_commit' : `injected_${fault.status}`;
        entry.status = fault.after_commit ? result.status : fault.status;
      }
      state.log.push(entry);
      if (fault) {
        if (fault.delay_ms) await new Promise(r => setTimeout(r, fault.delay_ms));
        if (fault.after_commit) return send(result.status, result.body);
        if (fault.malformed) return send(200, '{"oops": ');
        return send(fault.status, fault.body || { message: `mock injected ${fault.status}` }, fault.status === 429 ? { 'retry-after': String(fault.retry_after ?? 0) } : {});
      }
      return send(result.status, result.body);
    });
  });

  await new Promise(resolveListen => server.listen(port, host, resolveListen));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    snapshot,
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.MOCK_PORT || 0);
  const mock = await startMock({ port });
  console.log(`Ridgeway vendor mock listening on ${mock.url} (control: /__control /__log /__reset)`);
}
