// The real-n8n test harness, shared by tests/verify.mjs and scripts/simulate-day.mjs.
// It starts the vendor mock (and, in live mode, the Claude bridge), imports and publishes both workflows with the
// n8n CLI into a temporary N8N_USER_FOLDER, starts `n8n start` on a free port with an allowlisted environment, and
// POSTs HMAC-signed leads to the production webhook. Nothing here asserts anything: callers do.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from '../mock/server.mjs';
import { buildN8nEnv } from './n8n-env.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const N8N_VERSION = '2.42.6';
export const MAIN_ID = 'pestLeadBook0001';
export const ERROR_ID = 'pestLeadAlert001';
export const APPROVAL_ID = 'pestLeadApprove1';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Prefer the global n8n (same binary as the editor); fall back to a pinned pnpm dlx copy.
const globalN8n = process.env.N8N_BIN || join(homedir(), 'Library/pnpm/bin/n8n');
export const n8nCommand = existsSync(globalN8n)
  ? { bin: globalN8n, args: [], label: globalN8n.replace(homedir(), '~') }
  : { bin: 'pnpm', args: ['--package=node@24.21.0', `--package=n8n@${N8N_VERSION}`, '--allow-build=sqlite3', 'dlx', 'n8n'], label: `pnpm dlx n8n@${N8N_VERSION}` };

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
  });
}

// live: Claude answers come from the local bridge instead of the recordings (maxBridgeCalls caps the real calls).
// defaultNow: the test clock for sendLead when a call does not pass its own.
export function createHarness({ live = false, resultsDir = join(root, 'results'), prefix = '', defaultNow, maxBridgeCalls = 16 } = {}) {
  mkdirSync(resultsDir, { recursive: true });
  const secrets = {
    webhook: randomBytes(24).toString('hex'),
    bridge: randomBytes(24).toString('hex'),
    relay: randomBytes(24).toString('hex'),
    dummy: name => `test-${name}-${randomBytes(6).toString('hex')}`,
  };
  const userFolder = mkdtempSync(join(tmpdir(), 'pest-lead-n8n-'));
  // n8n gets an allowlisted environment (see n8n-env.mjs), never a copy of this process's. The CLI calls too.
  const n8nSettings = {
    N8N_USER_FOLDER: userFolder,
    N8N_DIAGNOSTICS_ENABLED: 'false',
    N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
    N8N_TEMPLATES_ENABLED: 'false',
    N8N_PERSONALIZATION_ENABLED: 'false',
    N8N_HIRING_BANNER_ENABLED: 'false',
    EXECUTIONS_DATA_PRUNE: 'true',
    EXECUTIONS_DATA_MAX_AGE: '24',
    // A successful run is saved with no data ('none'), but n8n writes its first row (webhook payload included) and
    // soft-deletes it; the pruner hard-deletes soft-deleted rows. One-minute passes make that observable in a test.
    EXECUTIONS_DATA_HARD_DELETE_BUFFER: '0',
    EXECUTIONS_DATA_PRUNE_HARD_DELETE_INTERVAL: '1',
  };
  const baseEnv = buildN8nEnv(n8nSettings);
  const n8nLogPath = join(userFolder, 'n8n-server.log');
  const ports = {};
  const h = { live, resultsDir, prefix, secrets, userFolder, baseEnv, n8nLogPath, ports, n8nCommand, mock: null, bridge: null };
  let n8nProc;
  let n8nOutFd;

  h.n8nCli = (args, label) => {
    const proc = spawnSync(n8nCommand.bin, [...n8nCommand.args, ...args], { cwd: root, env: baseEnv, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000 });
    if (label) writeFileSync(join(resultsDir, `${prefix}${label}.stdout.txt`), (proc.stdout ?? '').split('\n').filter(line => !/migration/i.test(line)).join('\n'));
    if (proc.error || proc.status !== 0) throw new Error(`n8n ${args.join(' ')} failed (${proc.status}): ${proc.error?.message ?? proc.stderr ?? proc.stdout}`);
    return proc.stdout;
  };

  h.control = async (path, body) => {
    const res = await fetch(`${h.mock.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(res.status, 200, `${path} failed`);
  };
  h.mockLog = async () => (await fetch(`${h.mock.url}/__log`)).json();
  h.mockState = async () => (await fetch(`${h.mock.url}/__state`)).json();

  // In live mode Claude calls go to the bridge, so its call counter supplies the "anthropic.messages" entries.
  h.bridgeSnapshot = () => (live ? h.bridge.stats() : { calls: 0, errors: 0 });
  h.bridgeEntries = before => {
    if (!live) return [];
    const now = h.bridge.stats();
    const calls = now.calls - before.calls;
    const errors = now.errors - before.errors;
    return Array.from({ length: calls }, (_, i) => ({ op: 'anthropic.messages', status: i < errors ? 502 : 200, fault: i < errors ? 'bridge_error' : null, body: null }));
  };

  h.settle = async (minMs = 400) => {
    let last = -1;
    let stableSince = Date.now();
    const start = Date.now();
    for (;;) {
      const count = (await h.mockLog()).length + (live ? h.bridge.stats().calls : 0);
      if (count !== last) { last = count; stableSince = Date.now(); }
      if (Date.now() - stableSince >= minMs && Date.now() - start >= minMs) return;
      await sleep(100);
    }
  };

  // The signature covers `${timestamp}.${raw body}`; the timestamp (Unix seconds) travels in x-ridgeway-timestamp.
  h.sign = (body, secret = secrets.webhook, timestamp) => `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

  // Options: now (the test clock for this request; ISO text, any offset), signature (override), signedBody (sign other
  // bytes than the ones sent), timestampOffset (seconds from the clock), pretty (send the payload pretty-printed,
  // non-ASCII characters unescaped).
  h.sendLead = async (payload, { now = defaultNow, signature, signedBody, timestampOffset = 0, pretty = false } = {}) => {
    assert.ok(now, 'sendLead needs a test clock (now)');
    const body = JSON.stringify(payload, null, pretty ? 2 : undefined);
    const nowIso = new Date(now).toISOString();
    const timestamp = Math.floor(Date.parse(nowIso) / 1000) + timestampOffset;
    const res = await fetch(`http://127.0.0.1:${ports.n8n}/webhook/ridgeway/lead`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ridgeway-signature': signature ?? h.sign(signedBody ?? body, secrets.webhook, timestamp), 'x-ridgeway-timestamp': String(timestamp), 'x-ridgeway-test-now': nowIso },
      body,
      signal: AbortSignal.timeout(420000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep raw text */ }
    return { status: res.status, json, text, headers: Object.fromEntries(res.headers) };
  };

  // A signed Approve / Hold click, as the Socket Mode relay forwards it (ids only). Real clock: the relay sends real time.
  h.sendAction = async (payload, { secret = secrets.relay, timestampOffset = 0, raw } = {}) => {
    const body = raw ?? JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000) + timestampOffset;
    const res = await fetch(`http://127.0.0.1:${ports.n8n}/webhook/ridgeway/slack-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ridgeway-signature': h.sign(body, secret, timestamp), 'x-ridgeway-timestamp': String(timestamp) },
      body, signal: AbortSignal.timeout(120000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep raw text */ }
    return { status: res.status, json, text };
  };

  // Builds the workflow JSON, checks the n8n version, imports and publishes the three workflows. Returns the n8n version.
  h.prepareWorkflows = () => {
    execFileSync(process.execPath, [join(root, 'workflow/build-workflow.mjs')], { cwd: root, stdio: 'pipe' });
    const version = h.n8nCli(['--version']).trim();
    assert.equal(version, N8N_VERSION, `the runner and the editor must use n8n ${N8N_VERSION}`);
    assert.match(process.version, /^v24\./, 'Node 24 expected');
    return version;
  };
  h.importWorkflows = () => {
    const workflowDir = join(root, 'workflow');
    h.n8nCli(['import:workflow', '--input', join(workflowDir, 'alert-on-errors.json')], 'import-alert-on-errors');
    h.n8nCli(['import:workflow', '--input', join(workflowDir, 'book-new-lead.json')], 'import-book-new-lead');
    h.n8nCli(['import:workflow', '--input', join(workflowDir, 'handle-approval.json')], 'import-handle-approval');
    h.n8nCli(['publish:workflow', `--id=${ERROR_ID}`], 'publish-alert-on-errors');
    h.n8nCli(['publish:workflow', `--id=${MAIN_ID}`], 'publish-book-new-lead');
    h.n8nCli(['publish:workflow', `--id=${APPROVAL_ID}`], 'publish-handle-approval');
    const listing = h.n8nCli(['list:workflow']);
    assert.ok(listing.includes(`${MAIN_ID}|Pest Lead Agent · Book new lead`), listing);
    assert.ok(listing.includes(`${ERROR_ID}|Pest Lead Agent · Alert on errors`), listing);
    assert.ok(listing.includes(`${APPROVAL_ID}|Pest Lead Agent · Handle approval`), listing);
  };

  // slack: { baseUrl, token, leadsChannel, alertsChannel } points n8n's Slack calls somewhere else than the mock (the
  // live-Slack mode of scripts/simulate-day.mjs). hubspot: { baseUrl, token } does the same for HubSpot (live-HubSpot mode). approvers: SLACK_APPROVER_IDS. relaySecret: SLACK_RELAY_SECRET (default
  // a random one per run). mockRestore: a mock snapshot to start from instead of the seed.
  h.start = async ({ slack, hubspot, approvers = '', relaySecret, mockRestore = null, testMode = true } = {}) => {
    if (relaySecret) secrets.relay = relaySecret;
    ports.n8n = await freePort();
    ports.broker = await freePort();
    h.mock = await startMock({ restore: mockRestore });
    if (live) {
      const { startBridge } = await import('../../_shared/claude-bridge/claude-bridge.mjs');
      h.bridge = await startBridge({ port: 0, token: secrets.bridge, configDir: process.env.CLAUDE_BRIDGE_CONFIG_DIR || join(homedir(), '.claude-n8n-bridge'), maxCalls: maxBridgeCalls });
      console.log(`Claude bridge account: ${h.bridge.account?.emailDomain ?? 'unknown domain'}, plan ${h.bridge.account?.plan ?? 'unknown'}`);
    }
    const vendor = path => `${h.mock.url}${path}`;
    const env = buildN8nEnv({
      ...n8nSettings,
      N8N_PORT: ports.n8n,
      N8N_LISTEN_ADDRESS: '127.0.0.1',
      N8N_RUNNERS_BROKER_PORT: ports.broker,
      N8N_BLOCK_ENV_ACCESS_IN_NODE: 'false', // lets any workflow read every variable below: hence the allowlist
      NODE_FUNCTION_ALLOW_BUILTIN: 'crypto',
      RIDGEWAY_TEST_MODE: testMode ? 'true' : 'false',
      LEAD_WEBHOOK_SECRET: secrets.webhook,
      ANTHROPIC_BASE_URL: live ? h.bridge.url : vendor('/anthropic'),
      ANTHROPIC_API_KEY: live ? secrets.bridge : secrets.dummy('anthropic'),
      HUBSPOT_BASE_URL: hubspot?.baseUrl ?? vendor('/hubspot'), HUBSPOT_TOKEN: hubspot?.token ?? secrets.dummy('hubspot'),
      CLICKUP_BASE_URL: vendor('/clickup'), CLICKUP_TOKEN: secrets.dummy('clickup'), CLICKUP_LIST_ID: '901100123',
      SLACK_BASE_URL: slack?.baseUrl ?? vendor('/slack'), SLACK_BOT_TOKEN: slack?.token ?? secrets.dummy('slack'),
      SLACK_LEADS_CHANNEL: slack?.leadsChannel ?? '#leads', SLACK_ALERTS_CHANNEL: slack?.alertsChannel ?? '#automation-alerts',
      SLACK_APPROVER_IDS: approvers, SLACK_RELAY_SECRET: secrets.relay,
      GMAIL_BASE_URL: vendor('/gmail'), GMAIL_TOKEN: secrets.dummy('gmail'),
      SHEETS_BASE_URL: vendor('/sheets'), SHEETS_TOKEN: secrets.dummy('sheets'),
      SHEETS_SPREADSHEET_ID: 'demo-sheet-id', OPS_RULES_SHEET_ID: 'ridgeway-ops-rules',
      FIELDROUTES_BASE_URL: vendor('/fieldroutes'), FIELDROUTES_AUTH_KEY: secrets.dummy('frkey'), FIELDROUTES_AUTH_TOKEN: secrets.dummy('frtoken'),
      EVENT_LEDGER_BASE_URL: vendor('/ledger'), EVENT_LEDGER_TOKEN: secrets.dummy('ledger'),
    });
    n8nOutFd = openSync(n8nLogPath, 'w');
    n8nProc = spawn(n8nCommand.bin, [...n8nCommand.args, 'start'], { cwd: root, env, detached: true, stdio: ['ignore', n8nOutFd, n8nOutFd] });
    const deadline = Date.now() + 180000;
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${ports.n8n}/healthz`);
        if (res.ok) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('n8n did not become healthy within 180s');
      if (n8nProc.exitCode !== null) throw new Error(`n8n exited early with code ${n8nProc.exitCode}`);
      await sleep(1000);
    }
    // The production webhooks register after /healthz. An unsigned probe is rejected with 401 before any side effect.
    for (const path of ['ridgeway/lead', 'ridgeway/slack-action']) {
      for (;;) {
        try {
          const res = await fetch(`http://127.0.0.1:${ports.n8n}/webhook/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          if (res.status === 401) break;
        } catch { /* retry */ }
        if (Date.now() > deadline) throw new Error(`production webhook ${path} did not respond with 401 to an unsigned probe`);
        await sleep(500);
      }
    }
    if (!mockRestore) await h.control('/__reset');
  };

  h.stop = async () => {
    if (n8nProc?.pid) {
      try { process.kill(-n8nProc.pid, 'SIGTERM'); } catch { /* already gone */ }
      for (let i = 0; i < 40 && n8nProc.exitCode === null; i++) await sleep(250);
      try { process.kill(-n8nProc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (n8nOutFd !== undefined) closeSync(n8nOutFd);
    await h.bridge?.close();
    await h.mock?.close();
  };

  h.serverLog = () => { try { return readFileSync(n8nLogPath, 'utf8'); } catch { return ''; } };
  h.cleanup = () => rmSync(userFolder, { recursive: true, force: true });
  return h;
}
