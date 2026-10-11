// Runs one simulated Tuesday (October 13, 2026: 40 deliveries, fixtures/day/leads.json) through the real n8n
// workflow against the vendor mock, with the test clock set to each lead's arrival time. Claude answers are the
// recordings in fixtures/llm (replayed by the mock), so the run makes no Claude call and needs no network.
//   node scripts/simulate-day.mjs
// Writes results/day/state.json (the mock's final state: contacts, deals, tasks, Slack posts, Sheets rows, ledger),
// results/day/deliveries.json (one row per delivery) and results/day/kpi.md (the day's numbers).
// The harness is the one tests/verify.mjs uses (tests/harness.mjs): a temporary N8N_USER_FOLDER, a free port, an
// allowlisted environment, signed requests.
//
// Options:
//   --only <event ids>   send just these deliveries (comma list); --limit N  send the first N (after --only)
//   --live-slack         Slack is real: n8n posts to https://slack.com with the bot token from the environment
//                        (RIDGEWAY_SLACK_BOT_TOKEN, run through `doppler run`), to the channel ids in SLACK_LEADS_CHANNEL
//                        and SLACK_ALERTS_CHANNEL. Every other vendor stays on the mock and Claude stays on the recordings.
//                        Leads are paced (chat.postMessage allows about one message per second per channel). Writes
//                        results/live-slack/ (deliveries, the Slack ts of each post, the mock's state) instead of results/day/.
//   --serve              (with --live-slack) after sending, keep n8n and the mock running and start the Socket Mode relay
//                        (slack-relay/relay.mjs, app token RIDGEWAY_SLACK_APP_TOKEN) so the Approve / Hold buttons work;
//                        runs until Ctrl-C and saves the mock's state to results/live-slack/mock-state.json.
//   --resume             (with --serve) start from that saved state and send nothing, so earlier messages stay clickable.
//   --live-hubspot       HubSpot is real: n8n calls https://api.hubapi.com with RIDGEWAY_HUBSPOT_TOKEN (a service key, through
//                        `doppler run`) in the developer test account that scripts/hubspot-setup.mjs prepared; it refuses to
//                        start without results/live-hubspot/portal.json. The portal's pipeline and stage ids and its record-link
//                        base go into the mocked rules sheet. Combinable with --live-slack, --only, --limit and --serve. Leads
//                        are paced for HubSpot's limits. Writes results/live-hubspot/ instead of results/day/.
//   (the email fallback)  with --live-hubspot, HubSpot stores <local>+<domain>@example.com instead of the fictional
//                        .example address, because HubSpot rejects .example emails (400 INVALID_EMAIL). It is on by default.
//   --no-hubspot-email-fallback  (with --live-hubspot) turn it off and send the .example addresses as they are.
//   --hubspot-email-fallback     (with --live-hubspot) accepted, changes nothing: the fallback is already on.
// scripts/live-slack.sh and scripts/live-hubspot.sh wrap the live modes with Doppler.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { N8N_VERSION, createHarness, sleep } from '../tests/harness.mjs';
import { configProblems, createRelay } from '../slack-relay/relay.mjs';
import { HUBSPOT_API, checkHubspotToken, emailFallbackFromArgs, readPortalFile, settingsFromPortal } from './hubspot-setup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = name => JSON.parse(readFileSync(join(root, 'fixtures', name), 'utf8'));
const args = process.argv.slice(2);
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const liveSlack = args.includes('--live-slack');
const liveHubspot = args.includes('--live-hubspot');
const emailFallback = liveHubspot && emailFallbackFromArgs(args); // on by default in live-HubSpot mode
const serve = args.includes('--serve');
const resume = args.includes('--resume');
const onlyIds = option('--only') ? option('--only').split(',').map(id => id.trim()).filter(Boolean) : null;
const limit = option('--limit') === undefined ? null : Number(option('--limit'));
const LIVE_SLACK_PACE_MS = 1200; // chat.postMessage: about 1 message per second per channel
// HubSpot: 100 requests per 10 s per app on Free/Starter (the conservative reading for a test account), searches 5 per
// second per account. A lead makes 5 to 7 HubSpot calls, so 1.5 s between leads stays near 45 per 10 s.
const LIVE_HUBSPOT_PACE_MS = 1500;
const live = liveSlack || liveHubspot;
const liveDir = join(root, liveHubspot ? 'results/live-hubspot' : 'results/live-slack');
const mockStateFile = join(liveDir, 'mock-state.json');

// Live Slack: the workflow already reads SLACK_BASE_URL, SLACK_BOT_TOKEN and the channel variables from its environment,
// so the harness only hands n8n other values. Refuses to start without a bot token, and says only what is wrong.
function slackTarget() {
  if (!liveSlack) return undefined; // the mock's /slack
  const token = process.env.RIDGEWAY_SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('--live-slack: the Slack bot token is missing (RIDGEWAY_SLACK_BOT_TOKEN; run through doppler run, see scripts/live-slack.sh)');
  if (!token.startsWith('xoxb-')) throw new Error('--live-slack: the Slack bot token does not start with xoxb-');
  const channels = { SLACK_LEADS_CHANNEL: process.env.SLACK_LEADS_CHANNEL, SLACK_ALERTS_CHANNEL: process.env.SLACK_ALERTS_CHANNEL };
  for (const [name, value] of Object.entries(channels)) {
    if (!/^[CG][A-Z0-9]{8,}$/.test(value || '')) throw new Error(`--live-slack: ${name} must be a Slack channel id (C...), not a name`);
  }
  return { baseUrl: 'https://slack.com', token, leadsChannel: channels.SLACK_LEADS_CHANNEL, alertsChannel: channels.SLACK_ALERTS_CHANNEL };
}

// The relay settings for --serve; checked before anything starts. The target is filled in once n8n has a port.
function relaySettings() {
  if (!serve) return null;
  const settings = { appToken: process.env.RIDGEWAY_SLACK_APP_TOKEN || process.env.SLACK_APP_TOKEN, teamId: process.env.SLACK_TEAM_ID, secret: 'x'.repeat(32), target: 'http://127.0.0.1:1/' };
  const problems = configProblems(settings);
  if (problems.length) throw new Error(`--serve: ${problems.join('; ')}`);
  return settings;
}

// Live HubSpot: the service key and the portal file written by scripts/hubspot-setup.mjs. Says only what is wrong.
function hubspotTarget() {
  if (!liveHubspot) return undefined; // the mock's /hubspot
  const token = checkHubspotToken(process.env.RIDGEWAY_HUBSPOT_TOKEN);
  const portal = readPortalFile();
  return { baseUrl: HUBSPOT_API, token, portal, settings: settingsFromPortal(portal, { emailFallback }) };
}

function checkOptions() {
  if ((args.includes('--hubspot-email-fallback') || args.includes('--no-hubspot-email-fallback')) && !liveHubspot) throw new Error('--hubspot-email-fallback and --no-hubspot-email-fallback need --live-hubspot (the mock accepts .example addresses)');
  if ((serve || resume) && !liveSlack) throw new Error('--serve and --resume need --live-slack (the buttons only exist in a real workspace)');
  if (resume && !serve) throw new Error('--resume needs --serve');
  if (resume && !existsSync(mockStateFile)) throw new Error(`--resume: no saved state at ${mockStateFile}; run --live-slack first`);
  if (limit !== null && !(Number.isInteger(limit) && limit >= 0)) throw new Error('--limit needs a whole number');
  const known = new Set(day.leads.map(item => item.payload.event_id));
  const unknown = (onlyIds ?? []).filter(id => !known.has(id));
  if (unknown.length) throw new Error(`--only: not in fixtures/day/leads.json: ${unknown.join(', ')}`);
}

const day = fixture('day/leads.json');
const pipeline = fixture('hubspot/pipeline.json');
const schedule = fixture('fieldroutes/schedule.json');
const seededDealIds = new Set(fixture('hubspot/deals.json').deals.map(deal => deal.id));
const rules = fixture('ops-rules.json');
const zipBranch = new Map(rules.tabs['Service area'].rows.flatMap(([id, , , , , zips]) => zips.split(/\s+/).map(zip => [zip, id])));
const BRANCH_LABEL = { jacksonville: 'Jacksonville', savannah: 'Savannah', mobile: 'Mobile', none: 'Outside the service area' };
const BRANCH_ZONE = { jacksonville: 'America/New_York', savannah: 'America/New_York', mobile: 'America/Chicago' };
const STATUSES = ['auto_proposed', 'approval_required', 'service_request', 'needs_review', 'out_of_area', 'duplicate'];
const SOURCES = [['web_form', 'Web form'], ['hubspot_form', 'HubSpot form'], ['call_tracking', 'Call tracking']];

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
};
const seconds = ms => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(2)} s`);
const money = n => `$${Math.round(n).toLocaleString('en-US')}`;
const pct = (n, total) => `${Math.round((n / total) * 100)}%`;
// left: indexes of the text columns (the first column is always text); every other column is a number
const table = (header, rows, left = []) => [`| ${header.join(' | ')} |`, `| ${header.map((_, i) => (i === 0 || left.includes(i) ? '---' : '---:')).join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n');
const reasonText = reason => (/^pest_type:/.test(reason) ? `${reason.slice(10).replace(/_/g, ' ').replace(/^termites$/, 'termite')} jobs always need approval` : reason === 'commercial_property' ? 'commercial property' : /^estimated_value>=/.test(reason) ? `estimate of $${reason.slice(17)} or more` : reason);
const localTime = (iso, zone) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));

// the lead's own ZIP, read from the raw payload (the branch of a duplicate or an out-of-area lead is not in the response)
function zipOf(payload) {
  if (payload.fields && !Array.isArray(payload.fields)) return payload.fields['4.5'];
  if (Array.isArray(payload.fields)) return payload.fields.find(field => field.name === 'zip')?.value;
  return /\b(?:FL|GA|AL|Florida|Georgia|Alabama)\b[\s,.:-]*(\d{5})/.exec(payload.transcription ?? '')?.[1];
}

let slack;
let hubspot;
let relayConfig;
try { checkOptions(); slack = slackTarget(); hubspot = hubspotTarget(); relayConfig = relaySettings(); } catch (error) { console.error(error.message); process.exit(2); } // refuses before anything is started
const selectedLeads = resume ? [] : day.leads.filter(item => !onlyIds || onlyIds.includes(item.payload.event_id)).slice(0, limit ?? undefined);
const fullDay = !live && selectedLeads.length === day.leads.length;
const outDir = live ? liveDir : join(root, 'results/day');
const paceMs = Math.max(liveSlack ? LIVE_SLACK_PACE_MS : 0, liveHubspot ? LIVE_HUBSPOT_PACE_MS : 0);
const harnessLogs = mkdtempSync(join(tmpdir(), 'pest-day-'));
const h = createHarness({ live: false, resultsDir: harnessLogs, defaultNow: day.leads[0].received_at });
let failure = null;
const deliveries = [];
let relay = null;
try {
  h.prepareWorkflows();
  h.importWorkflows();
  await h.start({
    slack, hubspot: hubspot && { baseUrl: hubspot.baseUrl, token: hubspot.token }, approvers: process.env.SLACK_APPROVER_IDS || '', relaySecret: liveSlack ? process.env.RIDGEWAY_SLACK_RELAY_SECRET : undefined,
    mockRestore: resume ? JSON.parse(readFileSync(mockStateFile, 'utf8')) : null,
  });
  // The portal's ids go into the mocked rules sheet, which both workflows read (Settings tab).
  if (hubspot) await h.control('/__control', { sheet_settings: hubspot.settings });
  const realVendors = [liveSlack && 'Slack (the real workspace)', liveHubspot && `HubSpot (developer test account ${hubspot.portal.portal_id}${emailFallback ? ', email fallback on' : ''})`].filter(Boolean);
  console.log(`n8n ${N8N_VERSION} is up; sending ${selectedLeads.length} of ${day.leads.length} deliveries for ${day.date} with the test clock set to each arrival time${realVendors.length ? ` (real: ${realVendors.join(' and ')}, paced ${paceMs / 1000} s; every other vendor: the mock)` : ''}`);

  // Live vendors: a lead's writes go out during its run, so the next lead waits for the previous answer plus the pace.
  let lastAnsweredAt = 0;
  for (const item of selectedLeads) {
    if (live) await sleep(Math.max(0, lastAnsweredAt + paceMs - Date.now()));
    await h.control('/__control', { sim_time: new Date(item.received_at).toISOString() });
    const sentAt = Date.now();
    const res = await h.sendLead(item.payload, { now: item.received_at });
    const answeredAt = Date.now();
    lastAnsweredAt = answeredAt;
    const zip = zipOf(item.payload);
    const first = deliveries.find(d => d.event_id === item.payload.event_id);
    deliveries.push({
      seq: item.seq, received_at: item.received_at, event_id: item.payload.event_id, source: item.payload.source, note: item.note,
      http_status: res.status, status: res.json?.status ?? 'error',
      branch: res.json?.branch ?? first?.branch ?? zipBranch.get(zip) ?? 'none',
      pest_type: res.json?.pest_type ?? first?.pest_type ?? null, urgency: res.json?.urgency ?? first?.urgency ?? null,
      approval_required: Boolean(res.json?.approval_required), slots: res.json?.slots?.length ?? 0, warnings: res.json?.warnings ?? [],
      hubspot: res.json?.hubspot ?? null, clickup_task_id: res.json?.clickup_task_id ?? null,
      sent_at_ms: sentAt, response_ms: answeredAt - sentAt, redelivery: Boolean(item.redelivery),
    });
    const row = deliveries.at(-1);
    console.log(`${String(row.seq).padStart(2)} ${localTime(item.received_at, BRANCH_ZONE[row.branch] ?? 'America/New_York').padStart(9)}  ${row.source.padEnd(13)} ${row.branch.padEnd(12)} ${String(row.status).padEnd(17)} ${row.pest_type ?? '-'}`);
  }

  const state = await h.mockState();
  const log = await h.mockLog();

  if (live) {
    // What a person can look at in Slack and HubSpot: one row per delivery with the channel id and ts of its post, and
    // the HubSpot record links.
    for (const row of deliveries) {
      const refs = state.ledger.find(item => item.event_id === row.event_id)?.refs;
      row.slack = row.status === 'duplicate' ? null : refs?.slack ? { channel: refs.slack.channel, ts: refs.slack.ts, buttons: row.status === 'approval_required' } : null;
      if (hubspot && row.hubspot) {
        row.hubspot_links = {
          contact: row.hubspot.contact_id ? `${hubspot.portal.app_url}/0-1/${row.hubspot.contact_id}` : null,
          deal: row.hubspot.deal_id ? `${hubspot.portal.app_url}/0-3/${row.hubspot.deal_id}` : null,
        };
      }
    }
    mkdirSync(liveDir, { recursive: true });
    if (selectedLeads.length) {
      const mode = `${[liveSlack && 'live Slack (real workspace)', liveHubspot && `live HubSpot (developer test account ${hubspot.portal.portal_id})`].filter(Boolean).join(' and ')}, other vendors mocked, recorded Claude answers`;
      writeFileSync(join(liveDir, 'deliveries.json'), `${JSON.stringify({ date: day.date, n8n: N8N_VERSION, mode, email_fallback: liveHubspot ? emailFallback : undefined, run_at: new Date().toISOString(), deliveries: deliveries.map(({ sent_at_ms, ...row }) => row) }, null, 2)}\n`);
    }
    if (liveHubspot) {
      // Re-running the day against the same portal must not duplicate: on a second run every deal is reused.
      const booked = deliveries.filter(d => d.hubspot?.deal_id && d.status !== 'duplicate');
      const reused = booked.filter(d => d.hubspot.deal_reused);
      const conflicts = deliveries.filter(d => d.warnings.includes('hubspot_contact_create_conflict') || d.warnings.includes('hubspot_deal_create_conflict'));
      console.log(`   HubSpot: ${booked.length - reused.length} deals created, ${reused.length} reused (found by ridgeway_event_id), ${conflicts.length} create conflicts resolved by a lookup`);
    }
    writeFileSync(mockStateFile, `${JSON.stringify(h.mock.snapshot())}\n`);
    for (const row of deliveries) console.log(`   ${row.event_id} ${row.status}${row.slack ? ` -> Slack ${row.slack.channel} ts ${row.slack.ts}${row.slack.buttons ? ' (Approve / Hold)' : ''}` : ''}${row.warnings.length ? ` warnings: ${row.warnings.join(', ')}` : ''}`);
    const bad = deliveries.filter(d => d.http_status !== 200 || !STATUSES.includes(d.status) || (d.status !== 'duplicate' && !d.slack));
    if (bad.length) throw new Error(`${bad.length} deliveries did not end in a known 200 status with a Slack post: ${bad.map(d => `${d.event_id} ${d.http_status} ${d.status} ${d.warnings.join(',')}`).join('; ')}`);
    if (serve) await serveUntilStopped();
  } else if (!fullDay) {
    console.log(`\n${selectedLeads.length} of ${day.leads.length} deliveries sent; results/day/ is written only for the full day`);
    const bad = deliveries.filter(d => d.http_status !== 200 || !STATUSES.includes(d.status));
    if (bad.length) throw new Error(`${bad.length} deliveries did not end in a known 200 status: ${bad.map(d => `#${d.seq} ${d.http_status} ${d.status}`).join(', ')}`);
  } else {
    writeDayResults(state, log);
  }
} catch (error) {
  failure = error;
} finally {
  await relay?.stop().catch(() => {});
  if (live && h.mock) { try { writeFileSync(mockStateFile, `${JSON.stringify(h.mock.snapshot())}\n`); } catch { /* keep the earlier file */ } }
  await h.stop().catch(() => {});
  h.cleanup();
  rmSync(harnessLogs, { recursive: true, force: true });
}
if (failure) { console.error(`FAIL: ${failure.message}`); process.exitCode = 1; }

// ------------------------------------------------------------------ the full day: results/day/

function writeDayResults(state, log) {
  // receipt to CSR task: from the moment the webhook was called to the moment the mock saw the task created
  for (const row of deliveries) {
    const created = log.find(entry => entry.op === 'clickup.create_task' && entry.idempotency_key?.startsWith(`${row.event_id}:`) && entry.status === 200 && !row.redelivery);
    row.csr_task_ms = created ? created.at_ms - row.sent_at_ms : null;
    const recording = (() => { try { return JSON.parse(readFileSync(join(root, 'fixtures/llm', `${row.event_id}.json`), 'utf8')); } catch { return null; } })();
    row.recorded_claude_ms = !row.redelivery && recording?.bridge?.duration_ms ? recording.bridge.duration_ms : null;
  }

  mkdirSync(outDir, { recursive: true });
  const stageLabel = Object.fromEntries(pipeline.stages.map(stage => [stage.id, stage.label]));
  const published = deliveries.map(({ sent_at_ms, ...row }) => row);
  writeFileSync(join(outDir, 'deliveries.json'), `${JSON.stringify({ date: day.date, n8n: N8N_VERSION, mode: 'replay (recorded Claude answers, mocked vendors)', deliveries: published }, null, 2)}\n`);
  writeFileSync(join(outDir, 'state.json'), `${JSON.stringify({
    _note: 'Final state of the vendor mock after the simulated day: the seeded records plus what the workflow created. Fictional data, mocked vendors; nothing was sent anywhere. Slack posts keep their blocks.',
    date: day.date,
    seeded: state.seeded,
    contacts: state.contacts, deals: state.deals.map(deal => ({ ...deal, stage_label: stageLabel[deal.properties.dealstage] })), tasks: state.tasks,
    drafts: state.drafts, slack_messages: state.slack_messages, sheet_rows: state.sheet_rows, ledger: state.ledger,
  }, null, 2)}\n`);

  writeFileSync(join(outDir, 'kpi.md'), buildKpi({ deliveries, state, stageLabel }));
  console.log(`\nWrote ${outDir}/state.json, deliveries.json and kpi.md`);

  const bad = deliveries.filter(d => d.http_status !== 200 || !STATUSES.includes(d.status));
  if (bad.length) throw new Error(`${bad.length} deliveries did not end in a known 200 status: ${bad.map(d => `#${d.seq} ${d.http_status} ${d.status}`).join(', ')}`);
}

// ------------------------------------------------------------------ --serve: the relay, until Ctrl-C

async function serveUntilStopped() {
  relay = createRelay({ ...relayConfig, secret: h.secrets.relay, target: `http://127.0.0.1:${h.ports.n8n}/webhook/ridgeway/slack-action` }).start();
  await relay.whenHello(30000);
  const approvers = (process.env.SLACK_APPROVER_IDS || '').split(',').filter(Boolean);
  const clickable = h.mock.snapshot().ledger.map(([, item]) => item).filter(item => item.status === 'approval_required' && item.refs?.slack && item.decision?.state !== 'done');
  console.log([
    '',
    `Live stack is up: n8n ${N8N_VERSION} on 127.0.0.1:${h.ports.n8n}, the mock on ${h.mock.url}, the Socket Mode relay connected.`,
    approvers.length ? `Approvers: ${approvers.join(', ')}.` : 'SLACK_APPROVER_IDS is empty: nobody can approve (every click gets the ephemeral notice).',
    clickable.length ? `Waiting for a click on: ${clickable.map(item => `${item.event_id} (${item.refs.slack.channel} ts ${item.refs.slack.ts})`).join(', ')}` : 'No lead is waiting for a decision in this state.',
    'Ctrl-C stops everything and saves the mock state for --resume.',
  ].join('\n'));
  let saved = '';
  await new Promise(resolveStop => {
    const timer = setInterval(() => {
      const now = JSON.stringify(h.mock.snapshot());
      if (now !== saved) { saved = now; writeFileSync(mockStateFile, `${now}\n`); }
    }, 2000);
    const stop = () => { clearInterval(timer); resolveStop(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  console.log('\nStopping the live stack.');
}

// ------------------------------------------------------------------ the KPI report

function buildKpi({ deliveries: rows, state, stageLabel }) {
  const lines = [];
  const processed = rows.filter(row => row.status !== 'duplicate');
  const distinct = new Set(rows.map(row => row.event_id)).size;
  lines.push(`# Simulated day: Tuesday, October 13, 2026`, '');
  lines.push(`${rows.length} deliveries (${distinct} distinct leads and ${rows.length - distinct} redelivery) went through the real n8n ${N8N_VERSION} workflow, one at a time, with the test clock set to each arrival time in the branch's own time zone. Fictional company, mocked vendors, Claude answers replayed from recordings: nothing was sent to a real person or account, and no Claude call was made for this report.`, '');

  // leads by branch and source
  lines.push('## Leads by branch and source', '');
  const branchRows = ['jacksonville', 'savannah', 'mobile', 'none'].map(branch => {
    const inBranch = rows.filter(row => row.branch === branch);
    const counts = SOURCES.map(([source]) => inBranch.filter(row => row.source === source).length);
    return [BRANCH_LABEL[branch], ...counts, inBranch.length, pct(inBranch.length, rows.length)];
  });
  const totals = SOURCES.map(([source]) => rows.filter(row => row.source === source).length);
  branchRows.push(['**All branches**', ...totals.map(n => `**${n}**`), `**${rows.length}**`, '**100%**']);
  lines.push(table(['Branch', ...SOURCES.map(([, label]) => label), 'Deliveries', 'Share'], branchRows), '');
  lines.push(`The redelivered event is counted under its branch both times. Outside the service area: one lead from Montgomery, Alabama.`, '');

  // status counts
  lines.push('## What happened to each delivery', '');
  const statusRows = STATUSES.map(status => [`\`${status}\``, rows.filter(row => row.status === status).length]);
  const other = rows.filter(row => !STATUSES.includes(row.status));
  if (other.length) statusRows.push(['other (see deliveries.json)', other.length]);
  statusRows.push(['**Total**', `**${rows.length}**`]);
  lines.push(table(['Status', 'Deliveries'], statusRows), '');

  // speed to lead
  lines.push('## Speed to lead', '');
  const csr = rows.map(row => row.csr_task_ms).filter(ms => ms !== null);
  const done = processed.map(row => row.response_ms);
  const claude = processed.map(row => row.recorded_claude_ms).filter(ms => ms !== null);
  const withClaude = processed.filter(row => row.csr_task_ms !== null && row.recorded_claude_ms !== null).map(row => row.csr_task_ms + row.recorded_claude_ms);
  lines.push(table(['Measure', 'Leads', 'p50', 'p90'], [
    ['Webhook received to CSR task created (workflow time, recorded Claude answer replayed, mocked vendors)', csr.length, seconds(percentile(csr, 50)), seconds(percentile(csr, 90))],
    ['Webhook received to response (the whole run)', done.length, seconds(percentile(done, 50)), seconds(percentile(done, 90))],
    ['Claude call time when it was recorded (`claude -p` through the bridge, CLI overhead included)', claude.length, seconds(percentile(claude, 50)), seconds(percentile(claude, 90))],
    ['Estimate: CSR task time plus the recorded Claude call time', withClaude.length, seconds(percentile(withClaude, 50)), seconds(percentile(withClaude, 90))],
  ]), '');
  lines.push(`The first row is what this run measured: n8n and the mocks on one laptop, with the Claude answer served instantly from a recording. It leaves out the real network, the real vendors and the real model call, so read it as the workflow's own overhead, not as a promise. Leads that get no CSR task (the out-of-area note, duplicates) are not in the first row. The last row adds the recorded model time to show the order of magnitude with a live Claude call.`, '');

  // pipeline
  lines.push('## Open pipeline value by stage', '');
  const byStage = Object.fromEntries(pipeline.stages.map(stage => [stage.id, { deals: 0, value: 0, newDeals: 0, newValue: 0 }]));
  for (const deal of state.deals) {
    const entry = byStage[deal.properties.dealstage];
    if (!entry) continue;
    const amount = Number(deal.properties.amount) || 0;
    entry.deals++; entry.value += amount;
    if (!seededDealIds.has(deal.id)) { entry.newDeals++; entry.newValue += amount; }
  }
  const open = pipeline.stages.filter(stage => stage.metadata.isClosed === 'false');
  const closed = pipeline.stages.filter(stage => stage.metadata.isClosed === 'true');
  const stageRow = stage => [stage.label, byStage[stage.id].deals, money(byStage[stage.id].value), byStage[stage.id].newDeals, money(byStage[stage.id].newValue)];
  const openTotals = open.reduce((sum, stage) => ({ deals: sum.deals + byStage[stage.id].deals, value: sum.value + byStage[stage.id].value, newDeals: sum.newDeals + byStage[stage.id].newDeals, newValue: sum.newValue + byStage[stage.id].newValue }), { deals: 0, value: 0, newDeals: 0, newValue: 0 });
  lines.push(table(['Stage', 'Deals', 'Value', 'Added today', 'Value added today'], [
    ...open.map(stageRow),
    ['**Open pipeline**', `**${openTotals.deals}**`, `**${money(openTotals.value)}**`, `**${openTotals.newDeals}**`, `**${money(openTotals.newValue)}**`],
    ...closed.map(stageRow).map(row => [`${row[0]} (closed, not counted)`, ...row.slice(1)]),
  ]), '');
  lines.push(`Values are the workflow's estimates from the illustrative price table (basis: "illustrative, pending sourced research"), plus the seeded deals that were already in the pipeline.`, '');

  // approval queue
  lines.push('## Approval queue', '');
  const approvals = state.deals.filter(deal => deal.properties.dealstage === 'ridgeway_needs_approval');
  const arrival = new Map(rows.filter(row => row.hubspot?.deal_id).map(row => [row.hubspot.deal_id, row]));
  const taskFor = deal => state.tasks.find(task => task.description?.includes(`/0-3/${deal.id}`));
  const queueRows = approvals.map(deal => {
    const row = arrival.get(deal.id);
    const reasons = /Approval needed because: (.+)/.exec(taskFor(deal)?.description ?? '')?.[1];
    return [row ? `${localTime(row.received_at, BRANCH_ZONE[row.branch])}` : 'before today', row ? BRANCH_LABEL[row.branch] : deal.properties.dealname.match(/\(([^)]+)\)$/)?.[1] ?? '', deal.properties.dealname.replace(/ \(.*\)$/, ''), money(Number(deal.properties.amount)), reasons ? reasons.split(', ').map(reasonText).join('; ') : 'seeded, decided by hand', deal.id];
  });
  queueRows.sort((a, b) => (a[0] === 'before today') - (b[0] === 'before today'));
  lines.push(`${approvals.length} deals wait for approval (${rows.filter(row => row.status === 'approval_required').length} came in today). A manager approves or holds each one from the Slack message.`, '');
  lines.push(table(['Arrived', 'Branch', 'Deal', 'Estimate', 'Why it needs approval', 'Deal id'], queueRows, [1, 2, 4]), '');

  // top pests
  lines.push('## Top pests', '');
  const pests = {};
  for (const row of processed) if (row.pest_type) pests[row.pest_type] = (pests[row.pest_type] ?? 0) + 1;
  const ranked = Object.entries(pests).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  lines.push(table(['Pest', 'Leads', 'Share'], ranked.map(([pest, n]) => [pest.replace(/_/g, ' '), n, pct(n, processed.length)])), '');
  lines.push(`Pest type is Claude's reading of the message, as recorded; ${processed.filter(row => !row.pest_type).length} lead(s) have none because the model output was unusable. ${rows.filter(row => row.urgency === 'emergency' && row.status !== 'duplicate').length} lead(s) were read as an emergency.`, '');

  // office hours (Mon to Fri 8 to 5, local time; the schedule fixture is the source)
  const [opens, closes] = schedule.office_hours.weekdays.map(time => Number(time.slice(0, 2)) * 60);
  const minutesOf = row => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: BRANCH_ZONE[row.branch] ?? 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(row.received_at));
    return Number(parts.find(part => part.type === 'hour').value) * 60 + Number(parts.find(part => part.type === 'minute').value);
  };
  const early = processed.filter(row => minutesOf(row) < opens);
  const late = processed.filter(row => minutesOf(row) >= closes);
  lines.push('## Timing', '');
  lines.push(`${early.length + late.length} of ${processed.length} leads arrived outside office hours (8 AM to 5 PM local time): ${early.length} before opening and ${late.length} after closing, the last at ${localTime(late.at(-1)?.received_at ?? rows[0].received_at, BRANCH_ZONE[late.at(-1)?.branch] ?? 'America/New_York')}. The workflow handles them the same way, so the CSR queue is ready when the office opens.`, '');
  lines.push('---', '', 'Reproduce with `node scripts/simulate-day.mjs` (under a minute). The data is fictional: real ZIP codes with invented streets, 555-01xx phone numbers, `.example` email addresses and illustrative prices.', '');
  return lines.join('\n');
}
