// Prepares a HubSpot developer test account for the live-HubSpot mode: the "Ridgeway lead agent (demo)" property
// group, the custom contact and deal properties the workflows write (fixtures/hubspot/properties.json; ridgeway_event_id
// is a unique-value property), and the "Ridgeway Sales" deal pipeline with the stages of fixtures/hubspot/pipeline.json.
// Idempotent: it reads first and creates only what is missing; it never deletes, renames or changes anything that
// exists, and it stops before any write if something that exists does not match (a property of the wrong type, a
// ridgeway_event_id that is not unique). It then writes the non-secret ids the live runner needs (portal id, record-link
// base, pipeline and stage ids) to results/live-hubspot/portal.json.
//
//   doppler run --project portfolio-website --config dev -- node pest-lead-agent/scripts/hubspot-setup.mjs --dry-run
//   doppler run --project portfolio-website --config dev -- node pest-lead-agent/scripts/hubspot-setup.mjs
// (scripts/live-hubspot.sh setup [--dry-run] does the same.) --dry-run reads and prints the plan; it writes nothing,
// not even portal.json. The token is RIDGEWAY_HUBSPOT_TOKEN (a HubSpot service key, Authorization: Bearer); it is never
// printed or logged. It refuses to run against anything but a developer test account (account-info accountType).
//
// Scopes (exactly what the token was given): crm.objects.contacts.read/write, crm.objects.deals.read/write,
// crm.schemas.contacts.read/write, crm.schemas.deals.read/write. See README, "Live HubSpot".
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HUBSPOT_API = 'https://api.hubapi.com';
export const PORTAL_FILE = join(root, 'results/live-hubspot/portal.json');
export const PIPELINE_LABEL = 'Ridgeway Sales';
export const REQUIRED_SCOPES = [
  'crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.objects.deals.read', 'crm.objects.deals.write',
  'crm.schemas.contacts.read', 'crm.schemas.contacts.write', 'crm.schemas.deals.read', 'crm.schemas.deals.write',
];
const STAGE_KEYS = ['new_lead', 'needs_approval', 'approved', 'on_hold'];
const fixture = name => JSON.parse(readFileSync(join(root, 'fixtures', name), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A HubSpot service key (or private app token): "pat-", a region such as na2, then a UUID. Says only what is wrong.
export function checkHubspotToken(token) {
  if (!token) throw new Error('RIDGEWAY_HUBSPOT_TOKEN is missing (run through doppler run, see scripts/live-hubspot.sh)');
  if (!/^pat-[a-z]{2,3}\d{0,2}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    throw new Error('RIDGEWAY_HUBSPOT_TOKEN does not look like a HubSpot service key (pat-<region>-<uuid>)');
  }
  return token;
}

// The host of the HubSpot app for this portal. The mock answers uiDomain app.hubspot.example; a real portal's host
// follows its data hosting location (na1: app.hubspot.com, otherwise app-<location>.hubspot.com, e.g. app-na2.hubspot.com).
export function uiHost(account) {
  if (typeof account.uiDomain === 'string' && /^app[-a-z0-9]*\.hubspot\.example$/.test(account.uiDomain)) return account.uiDomain;
  const location = String(account.dataHostingLocation || '').toLowerCase();
  if (!/^[a-z]{2,3}\d{0,2}$/.test(location)) throw new Error(`account-info has no usable dataHostingLocation (${JSON.stringify(account.dataHostingLocation)})`);
  return location === 'na1' ? 'app.hubspot.com' : `app-${location}.hubspot.com`;
}

// The rules-sheet rows the live runner puts into the mocked ops-rules sheet (Settings tab), from portal.json.
// Live HubSpot stores example.com addresses unless --no-hubspot-email-fallback is given (HubSpot rejects .example);
// --hubspot-email-fallback is still accepted and changes nothing.
export function emailFallbackFromArgs(args) { return !args.includes('--no-hubspot-email-fallback'); }

export function settingsFromPortal(portal, { emailFallback = false } = {}) {
  checkPortal(portal);
  return {
    hubspot_pipeline_id: portal.pipeline.id,
    ...Object.fromEntries(STAGE_KEYS.map(key => [`hubspot_stage_${key}`, portal.stages[key]])),
    hubspot_app_url: portal.app_url,
    hubspot_email_fallback: emailFallback ? 'example_com' : 'off',
  };
}

export function checkPortal(portal) {
  const problems = [];
  if (!portal || typeof portal !== 'object') throw new Error('portal.json is not an object');
  if (!/^\d+$/.test(String(portal.portal_id ?? ''))) problems.push('portal_id');
  if (portal.account_type !== 'DEVELOPER_TEST') problems.push('account_type (must be DEVELOPER_TEST)');
  if (!/^https:\/\/app[-a-z0-9]*\.hubspot\.(com|example)\/contacts\/\d+\/record$/.test(portal.app_url ?? '')) problems.push('app_url');
  if (!/^[A-Za-z0-9_-]+$/.test(portal.pipeline?.id ?? '')) problems.push('pipeline.id');
  for (const key of STAGE_KEYS) if (!/^[A-Za-z0-9_-]+$/.test(portal.stages?.[key] ?? '')) problems.push(`stages.${key}`);
  if (problems.length) throw new Error(`portal.json is incomplete: ${problems.join(', ')}. Run scripts/hubspot-setup.mjs again.`);
  return portal;
}

export function readPortalFile(file = PORTAL_FILE) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { throw new Error(`no ${file.replace(`${root}/`, '')}: run scripts/hubspot-setup.mjs (or scripts/live-hubspot.sh setup) first`); }
  return checkPortal(JSON.parse(text));
}

// One HubSpot call. Retries 429 and 5xx three times (Retry-After when HubSpot sends it, otherwise 10 s, the length of
// its rolling window). Writes carry Idempotency-Key and X-Run-Id like the workflow's (HubSpot ignores the key; the
// script is safe to re-run because it reads before it writes and treats "already exists" as done).
function client({ baseUrl, token, runId, log }) {
  return async function call(method, path, { body, key, ok = [200, 201], allow = [] } = {}) {
    for (let attempt = 1; ; attempt++) {
      const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (key) { headers['idempotency-key'] = `ridgeway-setup:${key}`; headers['x-run-id'] = runId; }
      let res;
      try {
        res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      } catch (error) {
        if (attempt > 3) throw new Error(`${method} ${path} failed: ${error.message}`);
        log(`  ${method} ${path}: ${error.message}, retrying in 5 s`);
        await sleep(5000);
        continue;
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (ok.includes(res.status) || allow.includes(res.status)) return { status: res.status, json };
      if ((res.status === 429 || res.status >= 500) && attempt <= 3) {
        const wait = Number(res.headers.get('retry-after')) > 0 ? Number(res.headers.get('retry-after')) * 1000 : (res.status === 429 ? 10000 : 5000);
        log(`  ${method} ${path} answered ${res.status}, retrying in ${wait / 1000} s`);
        await sleep(wait);
        continue;
      }
      const scopes = json?.context?.missingScopes ? ` Missing scopes: ${[].concat(json.context.missingScopes).join(', ')}.` : '';
      throw new Error(`${method} ${path} answered ${res.status}: ${String(json?.message ?? text).slice(0, 300)}${scopes}`);
    }
  };
}

const sameDefinition = (have, want) => have.type === want.type && have.fieldType === want.fieldType && Boolean(have.hasUniqueValue) === Boolean(want.hasUniqueValue);

// Reads the portal, works out what is missing, and (unless dryRun) creates it. Returns { portal, plan, problems }.
export async function runSetup({ baseUrl = HUBSPOT_API, token, dryRun = false, log = () => {}, runId = `setup-${Date.now()}`, paceMs = 150 }) {
  const call = client({ baseUrl, token, runId, log });
  const paced = async (...args) => { const out = await call(...args); if (paceMs) await sleep(paceMs); return out; };
  const definitions = fixture('hubspot/properties.json');
  const pipelineFixture = fixture('hubspot/pipeline.json');
  const plan = [];
  const problems = [];

  const account = (await paced('GET', '/account-info/v3/details')).json;
  if (account?.accountType !== 'DEVELOPER_TEST') throw new Error(`refusing to set up: account ${account?.portalId ?? '?'} is ${account?.accountType ?? 'of an unknown type'}, not a developer test account`);
  const host = uiHost(account);
  log(`Portal ${account.portalId} (${account.accountType}, data hosted in ${account.dataHostingLocation}, app host ${host})`);

  for (const object of ['contacts', 'deals']) {
    const group = await paced('GET', `/crm/v3/properties/${object}/groups/${definitions.group.name}`, { allow: [404] });
    if (group.status === 404) plan.push({ kind: 'group', object, name: definitions.group.name, body: { name: definitions.group.name, label: definitions.group.label, displayOrder: definitions.group.displayOrder } });
    for (const def of definitions.properties[object]) {
      const have = await paced('GET', `/crm/v3/properties/${object}/${def.name}`, { allow: [404] });
      if (have.status === 404) plan.push({ kind: 'property', object, name: def.name, body: { groupName: definitions.group.name, ...def } });
      else if (!sameDefinition(have.json, def)) problems.push(`${object} property ${def.name} exists as ${have.json.type}/${have.json.fieldType}${have.json.hasUniqueValue ? ' (unique)' : ''}, expected ${def.type}/${def.fieldType}${def.hasUniqueValue ? ' (unique)' : ''}; the script does not change existing properties`);
    }
  }

  const stagesWanted = pipelineFixture.stages.map(stage => ({ key: stage.id.replace(/^ridgeway_/, ''), label: stage.label, displayOrder: stage.displayOrder, metadata: { probability: stage.metadata.probability } }));
  const pipelines = (await paced('GET', '/crm/v3/pipelines/deals')).json?.results ?? [];
  const sameLabel = pipelines.filter(item => item.label === PIPELINE_LABEL);
  if (sameLabel.length > 1) problems.push(`${sameLabel.length} deal pipelines are labelled "${PIPELINE_LABEL}"; keep one`);
  const existing = sameLabel[0];
  if (!existing) {
    plan.push({ kind: 'pipeline', name: PIPELINE_LABEL, body: { label: PIPELINE_LABEL, displayOrder: 1, stages: stagesWanted.map(({ key, ...stage }) => stage) } });
  } else {
    for (const stage of stagesWanted) {
      const found = existing.stages.find(item => item.label === stage.label);
      if (!found) plan.push({ kind: 'stage', name: stage.label, pipelineId: existing.id, body: { label: stage.label, displayOrder: stage.displayOrder, metadata: stage.metadata } });
      else if (Number(found.metadata?.probability) !== Number(stage.metadata.probability)) log(`  note: stage "${stage.label}" has probability ${found.metadata?.probability}, the fixture says ${stage.metadata.probability}; left as it is`);
    }
  }

  for (const item of plan) log(`  ${dryRun ? 'would create' : 'create'} ${item.kind}${item.object ? ` (${item.object})` : ''}: ${item.name}`);
  if (!plan.length) log('  nothing to create: the portal is already set up');
  if (problems.length) throw new Error(`the portal does not match and nothing was written:\n  - ${problems.join('\n  - ')}`);
  if (dryRun) return { portal: null, plan, problems };

  // Create, in dependency order: groups, properties, then the pipeline or its missing stages. "Already exists" (409)
  // counts as done: a retry after a lost answer, or another run of the script in between.
  for (const item of plan) {
    const path = item.kind === 'group' ? `/crm/v3/properties/${item.object}/groups`
      : item.kind === 'property' ? `/crm/v3/properties/${item.object}`
        : item.kind === 'pipeline' ? '/crm/v3/pipelines/deals' : `/crm/v3/pipelines/deals/${item.pipelineId}/stages`;
    const res = await paced('POST', path, { body: item.body, key: `${item.kind}:${item.object ?? 'deals'}:${item.name}`, allow: [409] });
    log(`  ${res.status === 409 ? 'already there' : 'created'}: ${item.kind} ${item.name}`);
  }

  // Read the ids back (they are generated by HubSpot) and check the result once more.
  const after = (await paced('GET', '/crm/v3/pipelines/deals')).json?.results?.find(item => item.label === PIPELINE_LABEL);
  if (!after) throw new Error(`the "${PIPELINE_LABEL}" pipeline is not there after the create`);
  const stages = {};
  for (const stage of stagesWanted) {
    const found = after.stages.find(item => item.label === stage.label);
    if (!found) throw new Error(`stage "${stage.label}" is not there after the create`);
    stages[stage.key] = String(found.id);
  }
  for (const object of ['contacts', 'deals']) for (const def of definitions.properties[object]) {
    const have = await paced('GET', `/crm/v3/properties/${object}/${def.name}`);
    if (!sameDefinition(have.json, def)) throw new Error(`${object} property ${def.name} does not match after the create`);
  }
  const portal = {
    _note: 'Written by scripts/hubspot-setup.mjs. Non-secret ids of the HubSpot developer test account the live-HubSpot mode writes to. No token here.',
    written_at: new Date().toISOString(),
    portal_id: String(account.portalId), account_type: account.accountType, data_hosting_location: account.dataHostingLocation ?? null, ui_domain: account.uiDomain ?? null,
    app_url: `https://${host}/contacts/${account.portalId}/record`,
    pipeline: { id: String(after.id), label: after.label },
    stages,
    group: definitions.group.name,
    properties: Object.fromEntries(Object.entries(definitions.properties).map(([object, defs]) => [object, defs.map(def => def.name)])),
    created: plan.map(item => `${item.kind}${item.object ? ` (${item.object})` : ''}: ${item.name}`),
  };
  return { portal: checkPortal(portal), plan, problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dryRun = process.argv.includes('--dry-run');
  try {
    const token = checkHubspotToken(process.env.RIDGEWAY_HUBSPOT_TOKEN);
    console.log(`HubSpot setup${dryRun ? ' (dry run: reads only, writes nothing)' : ''} against ${HUBSPOT_API}`);
    const { portal } = await runSetup({ token, dryRun, log: line => console.log(line) });
    if (portal) {
      mkdirSync(dirname(PORTAL_FILE), { recursive: true });
      writeFileSync(PORTAL_FILE, `${JSON.stringify(portal, null, 2)}\n`);
      console.log(`Wrote ${PORTAL_FILE.replace(`${root}/`, '')}: portal ${portal.portal_id}, pipeline ${portal.pipeline.id}, stages ${Object.entries(portal.stages).map(([key, id]) => `${key}=${id}`).join(' ')}`);
    }
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
