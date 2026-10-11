// Records real Claude answers for the fixture leads, using the exact request the workflow sends
// (workflow/anthropic.js is the single source for that request).
//   node scripts/record-llm.mjs              record leads that have no real recording or a stale one
//   node scripts/record-llm.mjs --force      re-record every lead
//   node scripts/record-llm.mjs --only evt-vague-007
//   node scripts/record-llm.mjs --dry-run    list what would be recorded and how many Claude calls that costs, make none
// It records the scenario and check leads (fixtures/scenarios.json) and the 39 distinct leads of the simulated day
// (fixtures/day/leads.json), each once.
// By default it starts the shared local Claude Code bridge (_shared/claude-bridge), which answers
// through the `claude` CLI signed in to the dedicated folder CLAUDE_BRIDGE_CONFIG_DIR (default
// ~/.claude-n8n-bridge; never the default ~/.claude login). To reuse a bridge that is already running set CLAUDE_BRIDGE_URL and
// CLAUDE_BRIDGE_TOKEN. No Anthropic API key is used. Calls are sequential and capped (maxCalls).
// Bridge calls count against the plan's limits; run this only when you mean to.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { loadModules } from '../workflow/modules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lib = loadModules();
const { scenarios, checks } = JSON.parse(readFileSync(join(root, 'fixtures/scenarios.json'), 'utf8'));
const day = JSON.parse(readFileSync(join(root, 'fixtures/day/leads.json'), 'utf8'));
const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');
// Hard cap for everything this script may spend in one run, the startup canary of the bridge included.
const CALL_CAP = Number(process.env.RECORD_CALL_CAP || 60);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

// The confidence threshold is a rule from the ops rules sheet (Settings tab); it is only used to print the outcome below.
const { confidence_threshold: CONFIDENCE_THRESHOLD } = lib.parseSettings({ values: JSON.parse(readFileSync(join(root, 'fixtures/ops-rules.json'), 'utf8')).tabs.Settings.rows });

const seenEvents = new Set();
const leads = [
  ...[...scenarios.map(s => [s.id, s]), ...Object.entries(checks)].filter(([, entry]) => entry.llm === 'record').map(([name, entry]) => ({ name, payload: entry.payload })),
  ...day.leads.map(item => ({ name: `day #${item.seq}`, payload: item.payload })),
]
  .filter(({ payload }) => !seenEvents.has(payload.event_id) && seenEvents.add(payload.event_id)) // a redelivery is recorded once
  .map(({ name, payload }) => ({ name, lead: lib.normalizeLead(payload).lead }))
  .filter(({ lead }) => !only || lead.event_id === only);

function needsRecording(lead, request) {
  const file = join(root, 'fixtures/llm', `${lead.event_id}.json`);
  if (force || only || !existsSync(file)) return true;
  const existing = JSON.parse(readFileSync(file, 'utf8'));
  return Boolean(existing.synthetic) || !isDeepStrictEqual(existing.recorded_request, request);
}

const pending = leads.filter(({ lead }) => needsRecording(lead, lib.buildQualificationRequest(lead)));
console.log(`${pending.length} of ${leads.length} leads need a real Claude recording (plus 1 startup canary call when the bridge is started here; cap ${CALL_CAP}).`);
if (dryRun) { for (const { name, lead } of pending) console.log(`  would record ${lead.event_id} (${name})`); process.exit(0); }
if (pending.length + 1 > CALL_CAP) { console.error(`Refusing: ${pending.length + 1} calls would exceed the cap of ${CALL_CAP}.`); process.exit(2); }

let bridge = null;
let baseUrl = process.env.CLAUDE_BRIDGE_URL;
let token = process.env.CLAUDE_BRIDGE_TOKEN;
if (!baseUrl) {
  const { startBridge } = await import('../../_shared/claude-bridge/claude-bridge.mjs');
  token = randomBytes(24).toString('hex');
  bridge = await startBridge({ port: 0, token, configDir: process.env.CLAUDE_BRIDGE_CONFIG_DIR || join(homedir(), '.claude-n8n-bridge'), maxCalls: pending.length + 1 }); // +1: the bridge's startup canary
  baseUrl = bridge.url;
  console.log(`Claude bridge account: ${bridge.account?.emailDomain ?? 'unknown domain'}, plan ${bridge.account?.plan ?? 'unknown'}`);
}
console.log(`Using Claude Code bridge at ${baseUrl}`);

let calls = 0;
let failed = 0;
try {
  for (const { name, lead } of leads) {
    const request = lib.buildQualificationRequest(lead);
    if (!needsRecording(lead, request)) { console.log(`skip   ${lead.event_id} (${name}): real recording is current`); continue; }
    calls += 1;
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST', headers: lib.buildAnthropicHeaders(token), body: JSON.stringify(request), signal: AbortSignal.timeout(120000),
    });
    const body = await res.json();
    if (res.status !== 200) {
      failed += 1;
      console.error(`FAILED ${lead.event_id} (${name}): HTTP ${res.status} ${body?.error?.message ?? ''}`);
      continue;
    }
    const recording = { recorded_at: new Date().toISOString(), via: 'claude-code-cli-bridge', recorded_request: request, ...body };
    writeFileSync(join(root, 'fixtures/llm', `${lead.event_id}.json`), `${JSON.stringify(recording, null, 2)}\n`);
    const assessed = lib.assessQualification(body, CONFIDENCE_THRESHOLD);
    const q = assessed.qualification;
    console.log(`record ${lead.event_id} (${name}): ${assessed.status}${q ? ` ${q.pest_type}/${q.urgency}/${q.property_type}/${q.service_interest} confidence ${q.confidence}` : ` ${assessed.reason}`} [${body.model}, ${body.bridge?.duration_ms} ms]`);
  }
} finally {
  const used = bridge?.stats();
  await bridge?.close();
  if (used) console.log(`Bridge call counter: ${used.calls} real Claude call(s) including the startup canary (${used.errors} failed).`);
}
console.log(`Done: ${calls} recording call(s) made through the bridge, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
