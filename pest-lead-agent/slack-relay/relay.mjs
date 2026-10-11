// Slack Socket Mode relay for the Approve / Hold buttons. Zero dependencies (Node 24's global WebSocket and fetch).
//   node slack-relay/relay.mjs            run until Ctrl-C
//   node slack-relay/relay.mjs --check    connect, wait for Slack's hello, exit (proves the app token and Socket Mode)
// Env: RIDGEWAY_SLACK_APP_TOKEN (xapp-, or SLACK_APP_TOKEN), RIDGEWAY_SLACK_RELAY_SECRET (or SLACK_RELAY_SECRET),
// SLACK_TEAM_ID, RELAY_TARGET_URL (default the editor: http://127.0.0.1:5688/webhook/ridgeway/slack-action).
//
// What it does: apps.connections.open with the app token, connect to the WebSocket URL it returns, answer `hello`,
// reconnect on `disconnect` and on any close (always with a fresh URL, backoff on failures), and for every envelope
// send the ack first (Slack wants it within 3 seconds), then decide. Only `block_actions` from the configured team
// whose action is approve_lead or hold_lead are forwarded; everything else is dropped and only its type is logged.
// The forward carries ids only (never the message text or blocks), signed exactly like the lead webhook: HMAC-SHA256
// over "<timestamp>.<raw body>" in x-ridgeway-signature, the Unix timestamp in x-ridgeway-timestamp.
// It binds nothing: one outbound WebSocket to Slack, one outbound HTTPS call to open it, one POST to localhost.
// It never logs the tokens or the WebSocket URL (the URL carries a connection ticket).
import { fileURLToPath } from 'node:url';
import { loadModules } from '../workflow/modules.mjs';

const { computeSignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } = loadModules(['signature.js']);

export const APPROVAL_ACTION_IDS = ['approve_lead', 'hold_lead'];
export const DEFAULT_TARGET = 'http://127.0.0.1:5688/webhook/ridgeway/slack-action';
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

// Returns the problems with a relay configuration (empty when it is usable). Says what is wrong, never the value.
export function configProblems({ appToken, teamId, target, secret }) {
  const problems = [];
  if (!appToken) problems.push('the Slack app token is missing');
  else if (!String(appToken).startsWith('xapp-')) problems.push('the Slack app token does not start with xapp-');
  if (!/^T[A-Z0-9]{2,30}$/.test(teamId || '')) problems.push('SLACK_TEAM_ID is missing or not a Slack team id');
  let url = null;
  try { url = new URL(target); } catch { problems.push('RELAY_TARGET_URL is not a URL'); }
  if (url && (url.protocol !== 'http:' || !LOCAL_HOSTS.includes(url.hostname))) problems.push('RELAY_TARGET_URL must be http on 127.0.0.1 or localhost (n8n on this machine)');
  if (!secret || String(secret).length < 16) problems.push('the relay secret is missing or shorter than 16 characters');
  return problems;
}

// The ids the approval workflow needs, and nothing else. Returns null for anything that is not one of our buttons.
export function actionForward(envelope, action, teamId) {
  const payload = envelope.payload || {};
  if (payload.type !== 'block_actions' || (payload.team && payload.team.id) !== teamId) return null;
  if (!APPROVAL_ACTION_IDS.includes(action && action.action_id)) return null;
  return {
    team_id: payload.team.id,
    action_id: action.action_id,
    value: typeof action.value === 'string' ? action.value : '',
    user_id: (payload.user && payload.user.id) || '',
    channel_id: (payload.channel && payload.channel.id) || (payload.container && payload.container.channel_id) || '',
    message_ts: (payload.container && payload.container.message_ts) || (payload.message && payload.message.ts) || '',
    action_ts: typeof action.action_ts === 'string' ? action.action_ts : '',
    retry_attempt: Number.isInteger(envelope.retry_attempt) ? envelope.retry_attempt : 0,
  };
}

export function signForward(body, secret, nowMs) {
  const timestamp = String(Math.floor(nowMs / 1000));
  return { [SIGNATURE_HEADER]: `sha256=${computeSignature(secret, timestamp, Buffer.from(body, 'utf8'))}`, [TIMESTAMP_HEADER]: timestamp };
}

const sleep = ms => new Promise(done => setTimeout(done, ms));

export function createRelay({
  appToken, teamId, target = DEFAULT_TARGET, secret, slackApi = 'https://slack.com',
  fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, log = message => console.log(`[slack-relay] ${message}`),
  backoffMs = [1000, 2000, 5000, 10000, 30000], forwardTries = 3, forwardWaitMs = 2000, now = Date.now,
} = {}) {
  const problems = configProblems({ appToken, teamId, target, secret });
  if (problems.length) throw new Error(`slack-relay: ${problems.join('; ')}`);
  const stats = { opens: 0, hellos: 0, acks: 0, forwarded: 0, dropped: 0, reconnects: 0 };
  let socket = null;
  let stopped = false;
  let failures = 0;
  let timer = null;
  let helloWaiters = [];
  const pending = new Set();
  const refreshing = new WeakSet(); // sockets Slack asked us to replace: reconnect at once, no backoff

  async function openUrl() {
    const res = await fetchImpl(`${slackApi}/api/apps.connections.open`, {
      method: 'POST', headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/x-www-form-urlencoded' }, body: '',
    });
    const answer = await res.json().catch(() => ({}));
    if (!answer.ok || typeof answer.url !== 'string') throw new Error(`apps.connections.open failed: ${answer.error || `HTTP ${res.status}`}`);
    return answer.url;
  }

  function scheduleConnect(delay) {
    if (stopped || timer) return;
    stats.reconnects += 1;
    timer = setTimeout(() => { timer = null; connect(); }, delay);
  }

  function nextDelay() {
    const delay = backoffMs[Math.min(failures, backoffMs.length - 1)];
    failures += 1;
    return delay;
  }

  async function connect() {
    if (stopped) return;
    let url;
    try {
      url = await openUrl();
      stats.opens += 1;
    } catch (error) {
      const delay = nextDelay();
      log(`${error.message}; retrying in ${delay} ms`);
      scheduleConnect(delay);
      return;
    }
    if (stopped) return;
    const ws = new WebSocketImpl(url);
    socket = ws;
    ws.onmessage = event => handle(ws, event.data);
    ws.onerror = () => log('socket error');
    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (stopped) return;
      const delay = refreshing.has(ws) ? 0 : nextDelay();
      log(`socket closed; reconnecting with a fresh URL in ${delay} ms`);
      scheduleConnect(delay);
    };
  }

  function handle(ws, data) {
    let envelope;
    try { envelope = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch { log('dropped a frame that is not JSON'); return; }
    // Ack first, decide afterwards: Slack retries an envelope that is not acked within 3 seconds.
    if (envelope.envelope_id) {
      ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      stats.acks += 1;
    }
    if (envelope.type === 'hello') {
      failures = 0;
      stats.hellos += 1;
      log(`connected (hello; ${envelope.num_connections ?? '?'} connection(s) for this app)`);
      for (const waiter of helloWaiters) waiter();
      helloWaiters = [];
      return;
    }
    if (envelope.type === 'disconnect') {
      log(`Slack asked to disconnect (${envelope.reason || 'no reason'}); reconnecting`);
      refreshing.add(ws);
      ws.close();
      return;
    }
    if (envelope.type !== 'interactive') { stats.dropped += 1; log(`dropped envelope type ${envelope.type}`); return; }
    const payload = envelope.payload || {};
    const actions = payload.type === 'block_actions' && Array.isArray(payload.actions) ? payload.actions : [];
    const forwards = actions.map(action => actionForward(envelope, action, teamId)).filter(Boolean);
    if (!forwards.length) {
      stats.dropped += 1;
      const why = payload.type !== 'block_actions' ? `interactive ${payload.type}` : (payload.team && payload.team.id) !== teamId ? 'block_actions from another team' : 'block_actions with no approval button';
      log(`dropped ${why}`);
      return;
    }
    for (const body of forwards) {
      const job = forward(body).finally(() => pending.delete(job));
      pending.add(job);
    }
  }

  async function forward(body) {
    const raw = JSON.stringify(body);
    for (let attempt = 1; attempt <= forwardTries; attempt++) {
      try {
        const res = await fetchImpl(target, { method: 'POST', headers: { 'content-type': 'application/json', ...signForward(raw, secret, now()) }, body: raw, signal: AbortSignal.timeout(120000) });
        const text = await res.text();
        let status = null;
        try { status = JSON.parse(text).status ?? null; } catch { /* not JSON */ }
        stats.forwarded += 1;
        log(`forwarded ${body.action_id} for ${body.value} by ${body.user_id} (retry ${body.retry_attempt}) -> n8n ${res.status}${status ? ` ${status}` : ''}`);
        return res.status;
      } catch (error) {
        // Only an unreachable n8n is retried. An HTTP error is n8n's answer (the workflow has its own retries, and the
        // buttons stay on the message until a decision is applied), so it is logged, not repeated.
        log(`could not reach n8n (try ${attempt} of ${forwardTries}): ${error.name}`);
        if (attempt < forwardTries) await sleep(forwardWaitMs);
      }
    }
    return null;
  }

  return {
    stats: () => ({ ...stats, connected: Boolean(socket) }),
    start() { stopped = false; connect(); return this; },
    whenHello(timeoutMs = 20000) {
      if (stats.hellos > 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`no hello from Slack within ${timeoutMs} ms`)), timeoutMs);
        helloWaiters.push(() => { clearTimeout(timeout); resolve(); });
      });
    },
    async stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (socket) socket.close();
      await Promise.allSettled([...pending]);
    },
  };
}

// ------------------------------------------------------------------ command line

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = {
    appToken: process.env.RIDGEWAY_SLACK_APP_TOKEN || process.env.SLACK_APP_TOKEN,
    secret: process.env.RIDGEWAY_SLACK_RELAY_SECRET || process.env.SLACK_RELAY_SECRET,
    teamId: process.env.SLACK_TEAM_ID,
    target: process.env.RELAY_TARGET_URL || DEFAULT_TARGET,
  };
  const problems = configProblems(config);
  if (problems.length) {
    console.error(`slack-relay: refusing to start: ${problems.join('; ')}`);
    process.exit(2);
  }
  const relay = createRelay(config).start();
  if (process.argv.includes('--check')) {
    try {
      await relay.whenHello(20000);
      console.log('slack-relay: check passed: Slack sent hello over Socket Mode');
    } catch (error) {
      console.error(`slack-relay: check failed: ${error.message}`);
      process.exitCode = 1;
    }
    await relay.stop();
  } else {
    console.log(`[slack-relay] forwarding approve_lead / hold_lead from team ${config.teamId} to ${config.target}; Ctrl-C to stop`);
    const shutdown = async () => { await relay.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}
