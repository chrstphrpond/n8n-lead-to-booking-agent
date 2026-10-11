// Unit tests for slack-relay/relay.mjs with an injected WebSocket class and fetch: no network, no Slack.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModules } from '../workflow/modules.mjs';
import { APPROVAL_ACTION_IDS, configProblems, createRelay } from '../slack-relay/relay.mjs';

const { verifySignature, validateSlackAction } = loadModules();
const TEAM = 'T0C88V52NGN';
const SECRET = 'relay-secret-for-unit-tests-0123456789';
const APP_TOKEN = 'xapp-1-UNITTEST-not-a-real-token';
const TARGET = 'http://127.0.0.1:5999/webhook/ridgeway/slack-action';
const tick = () => new Promise(done => setTimeout(done, 5));

// Records every step in one sequence so the order (ack before forward) can be asserted.
function harness({ openAnswers } = {}) {
  const steps = [];
  const sockets = [];
  const logs = [];
  const posts = [];
  let opens = 0;
  class FakeSocket {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; sockets.push(this); steps.push(`connect ${url}`); }
    send(data) { this.sent.push(JSON.parse(data)); steps.push(`ack ${JSON.parse(data).envelope_id}`); }
    close() { if (this.closed) return; this.closed = true; steps.push('close'); setTimeout(() => this.onclose?.(), 0); }
    emit(envelope) { this.onmessage({ data: JSON.stringify(envelope) }); }
  }
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/apps.connections.open')) {
      opens += 1;
      steps.push('open');
      assert.equal(options.headers.authorization, `Bearer ${APP_TOKEN}`);
      const answer = openAnswers?.[opens - 1] ?? { ok: true, url: `wss://wss-primary.slack.example/link/?ticket=secret-ticket-${opens}` };
      return { status: 200, json: async () => answer };
    }
    steps.push(`forward ${JSON.parse(options.body).action_id}`);
    posts.push({ url, headers: options.headers, body: options.body });
    return { status: 200, text: async () => JSON.stringify({ status: 'approved' }) };
  };
  const relay = createRelay({ appToken: APP_TOKEN, teamId: TEAM, target: TARGET, secret: SECRET, fetchImpl, WebSocketImpl: FakeSocket, log: line => logs.push(line), backoffMs: [0, 0, 0], forwardWaitMs: 0 });
  return { relay, steps, sockets, logs, posts, opens: () => opens };
}

const blockActions = (overrides = {}, action = {}) => ({
  envelope_id: 'env-1', type: 'interactive', accepts_response_payload: false, retry_attempt: 0, retry_reason: '',
  payload: {
    type: 'block_actions', team: { id: TEAM, domain: 'ridgeway-demo' }, user: { id: 'U0C84MF082F', username: 'christopher', name: 'christopher', team_id: TEAM },
    api_app_id: 'A0C85KQCGTX', token: 'legacy-verification-token', trigger_id: '123.456.abc',
    container: { type: 'message', message_ts: '1791686146.000001', channel_id: 'C0C867WL7AR', is_ephemeral: false },
    channel: { id: 'C0C867WL7AR', name: 'leads' },
    message: { ts: '1791686146.000001', text: 'New high lead: termites (Jacksonville, FL)', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Malik, ZIP 32207' } }] },
    response_url: 'https://hooks.slack.example/actions/T0/1/secret',
    actions: [{ action_id: 'approve_lead', block_id: 'approval_evt-termite-fl-001', text: { type: 'plain_text', text: 'Approve' }, value: 'evt-termite-fl-001', style: 'primary', type: 'button', action_ts: '1791687000.123456' }],
    ...overrides,
  },
  ...(action.envelope ?? {}),
});

async function connected() {
  const h = harness();
  h.relay.start();
  await tick();
  h.sockets[0].emit({ type: 'hello', num_connections: 1, debug_info: { host: 'applink-1', approximate_connection_time: 18060 } });
  await h.relay.whenHello(100);
  return h;
}

test('relay: refuses a bot token, a missing token, a remote target and a short secret, and never echoes them', () => {
  assert.deepEqual(configProblems({ appToken: APP_TOKEN, teamId: TEAM, target: TARGET, secret: SECRET }), []);
  const problems = configProblems({ appToken: 'xoxb-123-secret-bot-token', teamId: 'nope', target: 'https://n8n.example.com/webhook/x', secret: 'pw-9z' });
  assert.equal(problems.length, 4);
  assert.ok(!problems.join(' ').includes('xoxb-123') && !problems.join(' ').includes('pw-9z'), 'the values are never printed');
  assert.match(configProblems({ appToken: undefined, teamId: TEAM, target: TARGET, secret: SECRET })[0], /missing/);
  assert.throws(() => createRelay({ appToken: APP_TOKEN, teamId: TEAM, target: 'http://10.0.0.5:5678/webhook', secret: SECRET }), /127\.0\.0\.1 or localhost/);
});

test('relay: opens a Socket Mode URL with the app token, answers hello, and never logs the token or the URL', async () => {
  const h = await connected();
  assert.deepEqual(h.steps.slice(0, 2), ['open', 'connect wss://wss-primary.slack.example/link/?ticket=secret-ticket-1']);
  assert.equal(h.relay.stats().hellos, 1);
  assert.ok(h.logs.some(line => /connected \(hello; 1 connection/.test(line)));
  await h.relay.stop();
  const all = h.logs.join('\n');
  assert.ok(!all.includes('xapp-') && !all.includes('ticket') && !all.includes('wss://'), 'no token or ticket URL in the log');
});

test('relay: acks an interactive envelope before forwarding it, and forwards ids only', async () => {
  const h = await connected();
  h.sockets[0].emit(blockActions());
  await tick();
  const ack = h.steps.indexOf('ack env-1');
  const forward = h.steps.indexOf('forward approve_lead');
  assert.ok(ack >= 0 && forward > ack, `ack first, then forward: ${h.steps.join(' | ')}`);
  assert.deepEqual(h.sockets[0].sent, [{ envelope_id: 'env-1' }], 'the ack is exactly the envelope id');
  const body = JSON.parse(h.posts[0].body);
  assert.deepEqual(body, { team_id: TEAM, action_id: 'approve_lead', value: 'evt-termite-fl-001', user_id: 'U0C84MF082F', channel_id: 'C0C867WL7AR', message_ts: '1791686146.000001', action_ts: '1791687000.123456', retry_attempt: 0 });
  assert.ok(!/Malik|32207|hooks\.slack|legacy-verification|trigger/.test(h.posts[0].body), 'no message content, response_url, token or trigger id');
  assert.equal(h.posts[0].url, TARGET);
  assert.equal(validateSlackAction(body).valid, true, 'the workflow accepts exactly what the relay sends');
  await h.relay.stop();
});

test('relay: the forward is signed like the lead webhook (HMAC over "<timestamp>.<raw body>")', async () => {
  const h = await connected();
  h.sockets[0].emit(blockActions());
  await tick();
  const { headers, body } = h.posts[0];
  const nowMs = Number(headers['x-ridgeway-timestamp']) * 1000;
  assert.deepEqual(verifySignature(SECRET, Buffer.from(body), headers['x-ridgeway-signature'], headers['x-ridgeway-timestamp'], nowMs), { ok: true, reason: null });
  assert.equal(verifySignature('another-secret-entirely-0000', Buffer.from(body), headers['x-ridgeway-signature'], headers['x-ridgeway-timestamp'], nowMs).reason, 'signature_mismatch');
  assert.equal(verifySignature(SECRET, Buffer.from(body.replace('approve_lead', 'hold_lead')), headers['x-ridgeway-signature'], headers['x-ridgeway-timestamp'], nowMs).reason, 'signature_mismatch');
  await h.relay.stop();
});

test('relay: drops other teams, other actions, other interactive types and non-interactive envelopes, but acks them all', async () => {
  const h = await connected();
  const socket = h.sockets[0];
  socket.emit({ ...blockActions({ team: { id: 'T0OTHERTEAM' } }), envelope_id: 'env-team' });
  socket.emit({ ...blockActions({}, {}), envelope_id: 'env-action', payload: { ...blockActions().payload, actions: [{ action_id: 'delete_lead', value: 'evt-termite-fl-001', action_ts: '1791687000.1' }] } });
  socket.emit({ envelope_id: 'env-view', type: 'interactive', payload: { type: 'view_submission', team: { id: TEAM } } });
  socket.emit({ envelope_id: 'env-event', type: 'events_api', payload: { event: { type: 'message', text: 'hello there' } } });
  socket.emit({ envelope_id: 'env-slash', type: 'slash_commands', payload: { command: '/approve' } });
  await tick();
  assert.deepEqual(socket.sent.map(ack => ack.envelope_id), ['env-team', 'env-action', 'env-view', 'env-event', 'env-slash'], 'every envelope is acked');
  assert.equal(h.posts.length, 0, 'nothing is forwarded');
  assert.equal(h.relay.stats().dropped, 5);
  const dropped = h.logs.filter(line => line.startsWith('dropped'));
  assert.deepEqual(dropped, ['dropped block_actions from another team', 'dropped block_actions with no approval button', 'dropped interactive view_submission', 'dropped envelope type events_api', 'dropped envelope type slash_commands']);
  assert.ok(!h.logs.join('\n').includes('hello there'), 'only the type is logged, never the content');
  assert.deepEqual(APPROVAL_ACTION_IDS, ['approve_lead', 'hold_lead']);
  await h.relay.stop();
});

test('relay: forwards Slack\'s retry attempt so the workflow can see a redelivery', async () => {
  const h = await connected();
  h.sockets[0].emit({ ...blockActions(), envelope_id: 'env-2', retry_attempt: 2, retry_reason: 'timeout' });
  await tick();
  assert.equal(JSON.parse(h.posts[0].body).retry_attempt, 2);
  await h.relay.stop();
});

test('relay: a disconnect envelope (refresh_requested) closes the socket and reconnects with a fresh URL at once', async () => {
  const h = await connected();
  h.sockets[0].emit({ type: 'disconnect', reason: 'refresh_requested', debug_info: { host: 'applink-1' } });
  await tick(); await tick();
  assert.equal(h.sockets[0].closed, true);
  assert.equal(h.opens(), 2, 'apps.connections.open is called again: a URL is never reused');
  assert.equal(h.sockets.length, 2);
  assert.notEqual(h.sockets[1].url, h.sockets[0].url);
  h.sockets[1].emit({ type: 'hello', num_connections: 1 });
  h.sockets[1].emit(blockActions());
  await tick();
  assert.equal(h.posts.length, 1, 'the new socket forwards');
  await h.relay.stop();
  assert.ok(h.logs.some(line => /asked to disconnect \(refresh_requested\)/.test(line)));
});

test('relay: an unexpected close and a failed apps.connections.open are retried with backoff', async () => {
  const h = harness({ openAnswers: [{ ok: true, url: 'wss://one.slack.example/?ticket=a' }, { ok: false, error: 'invalid_auth' }, { ok: true, url: 'wss://two.slack.example/?ticket=b' }] });
  h.relay.start();
  await tick();
  h.sockets[0].close(); // the network dropped
  for (let i = 0; i < 6 && h.sockets.length < 2; i++) await tick();
  assert.equal(h.opens(), 3, 'one failed open in between, then a fresh URL');
  assert.equal(h.sockets.length, 2);
  assert.ok(h.logs.some(line => /apps\.connections\.open failed: invalid_auth; retrying/.test(line)));
  assert.ok(h.relay.stats().reconnects >= 2);
  await h.relay.stop();
  const after = h.opens();
  await tick(); await tick();
  assert.equal(h.opens(), after, 'stop() means no more reconnects');
});

test('relay: an unreachable n8n is retried; an HTTP answer is not repeated', async () => {
  const steps = [];
  let calls = 0;
  class Socket { constructor() { setTimeout(() => this.onmessage({ data: JSON.stringify(blockActions()) }), 0); } send() { steps.push('ack'); } close() {} }
  const fetchImpl = async url => {
    if (url.endsWith('/api/apps.connections.open')) return { status: 200, json: async () => ({ ok: true, url: 'wss://x.slack.example/?ticket=c' }) };
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' });
    return { status: 500, text: async () => '{"message":"Workflow execution failed"}' };
  };
  const logs = [];
  const relay = createRelay({ appToken: APP_TOKEN, teamId: TEAM, target: TARGET, secret: SECRET, fetchImpl, WebSocketImpl: Socket, log: line => logs.push(line), forwardWaitMs: 0 }).start();
  for (let i = 0; i < 10 && calls < 3; i++) await tick();
  await relay.stop();
  assert.equal(calls, 3, 'two network failures, then n8n answered (500) and that answer was not retried');
  assert.equal(logs.filter(line => /could not reach n8n/.test(line)).length, 2);
  assert.ok(logs.some(line => /-> n8n 500/.test(line)));
});
