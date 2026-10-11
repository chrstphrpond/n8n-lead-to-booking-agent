// node --test _shared/claude-bridge/tests/
// Uses tests/fake-claude.mjs as the CLI; no real Claude calls.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startBridge } from '../claude-bridge.mjs';
import { checkSchemaDefinition, validate } from '../schema-validate.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
chmodSync(FAKE, 0o755);
const TOKEN = randomBytes(24).toString('hex');
const SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string', enum: ['hot', 'warm', 'cold'] },
    score: { type: 'number', minimum: 0, maximum: 1 },
    reasons: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['label', 'score'],
  additionalProperties: false,
};

const scratch = mkdtempSync(join(tmpdir(), 'claude-bridge-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function newConfigDir(files = {}) {
  const dir = mkdtempSync(join(scratch, 'cfg-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

async function start(options = {}) {
  const configDir = options.configDir ?? newConfigDir(options.files);
  const bridge = await startBridge({ token: TOKEN, cli: FAKE, configDir, logger: () => {}, ...options, files: undefined });
  return { bridge, configDir };
}

function callRecords(configDir) {
  const dir = join(configDir, 'calls');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')));
}

function send(port, { method = 'POST', path = '/v1/messages', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    const merged = {
      'content-type': 'application/json',
      'x-api-key': TOKEN,
      ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
      ...headers,
    };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    const req = request({ host: '127.0.0.1', port, method, path, headers: merged }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const message = (text, extra = {}) => ({
  model: 'claude-haiku-5-5',
  max_tokens: 256,
  system: 'Classify the lead.',
  messages: [{ role: 'user', content: text }],
  output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  ...extra,
});

const waitFor = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
};

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('success: Messages-shaped response with schema-valid text', async () => {
  const { bridge, configDir } = await start();
  try {
    assert.deepEqual(bridge.account, { emailDomain: 'example.test', plan: 'max' });
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await send(bridge.port, { body: message('Need termite inspection this week', { metadata: { user_id: 'run-1' } }) });
    assert.equal(res.status, 200);
    const body = res.json;
    assert.match(body.id, /^msg_bridge_[0-9a-f-]{36}$/);
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.equal(body.model, 'claude-haiku-5-5');
    assert.equal(body.stop_reason, 'end_turn');
    assert.equal(body.stop_sequence, null);
    assert.deepEqual(body.usage, { input_tokens: 15, output_tokens: 3 });
    assert.deepEqual(validate(SCHEMA, JSON.parse(body.content[0].text)), []);
    assert.equal(body.bridge.via, 'claude-code-cli');
    assert.equal(body.bridge.cli_version, '9.9.9');
    assert.equal(body.bridge.request_id, res.headers['request-id']);
    assert.ok('notional_cost_usd' in body.bridge && 'duration_ms' in body.bridge);
    assert.deepEqual(bridge.stats(), { calls: 2, errors: 0, queued: 0 }); // canary + this call

    const [canary, call] = callRecords(configDir);
    assert.ok(canary && call);
    assert.equal(call.stdin, 'Need termite inspection this week');
    assert.ok(call.argv.includes('--strict-mcp-config') && call.argv.includes('--no-session-persistence'));
    assert.ok(!call.argv.includes('--bare'));
    assert.equal(call.argv[call.argv.indexOf('--tools') + 1], '');
    assert.ok(call.cwd.includes('claude-bridge-'));
    assert.equal(existsSync(call.cwd), false, 'temp dir removed');

    const legacy = await send(bridge.port, { body: { ...message('legacy shape'), output_config: undefined, output_format: { type: 'json_schema', schema: SCHEMA } } });
    assert.equal(legacy.status, 200);
    const bearer = await send(bridge.port, { headers: { 'x-api-key': undefined, authorization: `Bearer ${TOKEN}` }, body: message('bearer') });
    assert.equal(bearer.status, 200);
    const health = await send(bridge.port, { method: 'GET', path: '/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.headers['access-control-allow-origin'], undefined);
  } finally {
    await bridge.close();
  }
});

test('is_error:true with subtype "success" and "Not logged in" -> 503 authentication_error', async () => {
  const { bridge } = await start();
  try {
    const res = await send(bridge.port, { body: message('MODE:not-logged-in') });
    assert.equal(res.status, 503);
    assert.equal(res.json.type, 'error');
    assert.equal(res.json.error.type, 'authentication_error');
    assert.match(res.json.error.message, /claude auth login/);
    assert.equal(bridge.stats().errors, 1);
  } finally { await bridge.close(); }
});

test('CLI usage limit -> 429 rate_limit_error with retry-after', async () => {
  const { bridge } = await start();
  try {
    const res = await send(bridge.port, { body: message('MODE:rate-limit') });
    assert.equal(res.status, 429);
    assert.equal(res.json.error.type, 'rate_limit_error');
    assert.ok(Number(res.headers['retry-after']) > 0);
  } finally { await bridge.close(); }
});

test('structured_output that violates the schema -> 502', async () => {
  const { bridge } = await start();
  try {
    const res = await send(bridge.port, { body: message('MODE:bad-output') });
    assert.equal(res.status, 502);
    assert.equal(res.json.error.type, 'api_error');
    assert.match(res.json.error.message, /does not match the request schema/);
  } finally { await bridge.close(); }
});

test('silent model swap -> 502', async () => {
  const { bridge } = await start();
  try {
    const res = await send(bridge.port, { body: message('MODE:model-swap') });
    assert.equal(res.status, 502);
    assert.match(res.json.error.message, /model mismatch/);
  } finally { await bridge.close(); }
});

test('timeout -> 504 and the whole process group is killed (SIGTERM ignored, SIGKILL used)', async () => {
  const { bridge, configDir } = await start({ timeoutMs: 600, killGraceMs: 300 });
  try {
    const res = await send(bridge.port, { body: message('MODE:sleep') });
    assert.equal(res.status, 504);
    assert.equal(res.json.error.type, 'timeout_error');
    const pids = JSON.parse(readFileSync(join(configDir, 'sleep-pids.json'), 'utf8'));
    await waitFor(() => !alive(pids.child) && !alive(pids.grandchild), 2000);
    const call = callRecords(configDir).at(-1);
    assert.equal(existsSync(call.cwd), false, 'temp dir removed after timeout');
  } finally { await bridge.close(); }
});

test('prompt starting with --dangerously-skip-permissions goes to stdin, never argv', async () => {
  const { bridge, configDir } = await start();
  try {
    const prompt = '--dangerously-skip-permissions --tools default please';
    const res = await send(bridge.port, { body: message(prompt) });
    assert.equal(res.status, 200);
    const call = callRecords(configDir).at(-1);
    assert.equal(call.stdin, prompt);
    assert.ok(!call.argv.some(arg => arg.includes('dangerously')), 'not in argv');
    assert.ok(!call.argv.includes('default'));
  } finally { await bridge.close(); }
});

test('request validation: 400 / 401 / 403 / 404 / 413', async () => {
  const { bridge } = await start();
  try {
    const noSchema = await send(bridge.port, { body: { ...message('x'), output_config: undefined } });
    assert.equal(noSchema.status, 400);
    assert.equal(noSchema.json.error.type, 'invalid_request_error');
    assert.match(noSchema.json.error.message, /JSON schema is required/);

    const arraySchema = await send(bridge.port, { body: message('x', { output_config: { format: { type: 'json_schema', schema: { type: 'array' } } } }) });
    assert.equal(arraySchema.status, 400);
    const badModel = await send(bridge.port, { body: message('x', { model: 'claude-other' }) });
    assert.equal(badModel.status, 400);
    const image = await send(bridge.port, { body: message('x', { messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }) });
    assert.equal(image.status, 400);
    const tools = await send(bridge.port, { body: message('x', { tools: [{ name: 't' }] }) });
    assert.equal(tools.status, 400);
    const bigUser = await send(bridge.port, { body: message('a'.repeat(33 * 1024)) });
    assert.equal(bigUser.status, 400);
    const notJson = await send(bridge.port, { body: '{nope' });
    assert.equal(notJson.status, 400);
    const wrongType = await send(bridge.port, { headers: { 'content-type': 'text/plain' }, body: message('x') });
    assert.equal(wrongType.status, 400);

    const badToken = await send(bridge.port, { headers: { 'x-api-key': 'wrong-token' }, body: message('x') });
    assert.equal(badToken.status, 401);
    assert.equal(badToken.json.error.type, 'authentication_error');
    const noTokenHealth = await send(bridge.port, { method: 'GET', path: '/health', headers: { 'x-api-key': undefined } });
    assert.equal(noTokenHealth.status, 401);

    const origin = await send(bridge.port, { headers: { origin: 'http://evil.example' }, body: message('x') });
    assert.equal(origin.status, 403);
    assert.equal(origin.json.error.type, 'permission_error');
    const host = await send(bridge.port, { headers: { host: `evil.example:${bridge.port}` }, body: message('x') });
    assert.equal(host.status, 403);
    const localhost = await send(bridge.port, { headers: { host: `localhost:${bridge.port}` }, body: message('localhost ok') });
    assert.equal(localhost.status, 200);

    const missing = await send(bridge.port, { method: 'GET', path: '/v1/models' });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.type, 'not_found_error');

    const huge = await send(bridge.port, { body: JSON.stringify({ ...message('x'), pad: 'p'.repeat(300 * 1024) }) });
    assert.equal(huge.status, 413);
    assert.equal(huge.json.error.type, 'request_too_large');
    const declaredHuge = await send(bridge.port, { body: 'p'.repeat(3 * 1024 * 1024) }).catch(error => ({ error }));
    if (!declaredHuge.error) assert.equal(declaredHuge.status, 413); // a reset while uploading is also acceptable
    assert.equal((await send(bridge.port, { method: 'GET', path: '/health' })).status, 200, 'still serving after oversize bodies');

    assert.equal(bridge.stats().calls, 2, 'only the canary and the localhost call reached the CLI');
  } finally { await bridge.close(); }
});

test('queue full -> 429 with retry-after', async () => {
  const { bridge } = await start({ maxQueue: 1 });
  try {
    const first = send(bridge.port, { body: message('MODE:slow first') });
    await waitFor(() => bridge.stats().calls === 2);
    const second = send(bridge.port, { body: message('MODE:slow second') });
    await waitFor(() => bridge.stats().queued === 1);
    const third = await send(bridge.port, { body: message('MODE:slow third') });
    assert.equal(third.status, 429);
    assert.equal(third.json.error.type, 'rate_limit_error');
    assert.ok(Number(third.headers['retry-after']) >= 1);
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    assert.equal(bridge.stats().calls, 3);
  } finally { await bridge.close(); }
});

test('call budget spent -> 429 (canary counts)', async () => {
  const { bridge } = await start({ maxCalls: 2 });
  try {
    assert.equal((await send(bridge.port, { body: message('one') })).status, 200);
    const over = await send(bridge.port, { body: message('two') });
    assert.equal(over.status, 429);
    assert.match(over.json.error.message, /budget/);
    assert.ok(over.headers['retry-after']);
    assert.equal(bridge.stats().calls, 2);
  } finally { await bridge.close(); }
});

test('literal ~ in configDir expands to the home dir', async () => {
  const savedHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(scratch, 'home-'));
  mkdirSync(join(fakeHome, '.claude-test'));
  process.env.HOME = fakeHome;
  let bridge;
  try {
    ({ bridge } = await start({ configDir: '~/.claude-test' }));
    const [canary] = callRecords(join(fakeHome, '.claude-test'));
    assert.equal(canary.env.CLAUDE_CONFIG_DIR, join(fakeHome, '.claude-test'));
    assert.equal(existsSync(join(process.cwd(), '~')), false, 'no literal ~ dir created');
  } finally {
    process.env.HOME = savedHome;
    await bridge?.close();
  }
});

test('startup refusals: missing config dir, default ~/.claude, short token, non-local host, not signed in, failed canary', async () => {
  await assert.rejects(start({ configDir: join(scratch, 'does-not-exist') }), /does not exist/);
  await assert.rejects(start({ configDir: '' }), /configDir is required/);
  await assert.rejects(start({ token: 'short' }), /at least 24 characters/);
  await assert.rejects(start({ host: '0.0.0.0' }), /host must be 127\.0\.0\.1/);
  const savedHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(scratch, 'home-'));
  mkdirSync(join(fakeHome, '.claude'));
  process.env.HOME = fakeHome;
  try {
    await assert.rejects(start({ configDir: '~/.claude' }), /default ~\/\.claude/);
  } finally { process.env.HOME = savedHome; }
  await assert.rejects(start({ files: { 'fake-auth.json': JSON.stringify({ loggedIn: false, authMethod: 'none' }) } }), /not signed in .*claude auth login/);
  await assert.rejects(start({ files: { 'fake-auth.json': JSON.stringify({ loggedIn: true, authMethod: 'api_key' }) } }), /expected a claude\.ai/);
  await assert.rejects(start({ files: { 'fake-mode': 'not-logged-in' } }), /canary call failed \(503 authentication_error\)/);
  await assert.rejects(start({ cli: join(scratch, 'no-such-cli') }), /could not run the claude CLI/);
});

test('child env is an allowlist: no ANTHROPIC_*, CLAUDE_CODE_*, proxies or cloud keys', async () => {
  const injected = {
    ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 't',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'o', AWS_SECRET_ACCESS_KEY: 'a', OPENAI_API_KEY: 'o',
    HTTPS_PROXY: 'http://proxy.invalid', NODE_OPTIONS: '--require /tmp/evil.js', CLAUDE_CONFIG_DIR: '/tmp/wrong',
  };
  const saved = {};
  for (const [k, v] of Object.entries(injected)) { saved[k] = process.env[k]; process.env[k] = v; }
  let bridge;
  try {
    let configDir;
    ({ bridge, configDir } = await start());
    assert.equal((await send(bridge.port, { body: message('env check') })).status, 200);
    for (const record of callRecords(configDir)) {
      const keys = Object.keys(record.env).filter(k => k !== '__CF_USER_TEXT_ENCODING'); // injected by macOS for every process
      const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'CLAUDE_CONFIG_DIR']);
      assert.deepEqual(keys.filter(k => !allowed.has(k)), [], `unexpected env keys: ${keys}`);
      assert.equal(record.env.CLAUDE_CONFIG_DIR, configDir);
      assert.ok(record.env.USER, 'USER is present (needed for the Keychain lookup)');
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await bridge?.close();
  }
});

test('close() kills a running call and resolves', async () => {
  const { bridge, configDir } = await start({ killGraceMs: 200 });
  const pending = send(bridge.port, { body: message('MODE:sleep') }).catch(error => ({ error }));
  await waitFor(() => existsSync(join(configDir, 'sleep-pids.json')));
  const pids = JSON.parse(readFileSync(join(configDir, 'sleep-pids.json'), 'utf8'));
  await bridge.close();
  await waitFor(() => !alive(pids.child) && !alive(pids.grandchild), 2000);
  const res = await pending;
  if (!res.error) assert.equal(res.status, 503);
});

test('schema validator covers the supported keywords', () => {
  const schema = {
    type: 'object',
    properties: {
      n: { type: 'integer', minimum: 1, maximum: 3 },
      s: { type: 'string', enum: ['a', 'b'] },
      b: { type: 'boolean' },
      list: { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 2 },
      inner: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false },
    },
    required: ['n', 's'],
    additionalProperties: false,
  };
  checkSchemaDefinition(schema);
  assert.deepEqual(validate(schema, { n: 2, s: 'a', b: true, list: [1.5], inner: { x: 'y' } }), []);
  assert.equal(validate(schema, { n: 2.5, s: 'a' }).length, 1);
  assert.equal(validate(schema, { n: 9, s: 'z' }).length, 2);
  assert.equal(validate(schema, { s: 'a' }).length, 1);
  assert.equal(validate(schema, { n: 1, s: 'a', extra: 1 }).length, 1);
  assert.equal(validate(schema, { n: 1, s: 'a', list: [] }).length, 1);
  assert.equal(validate(schema, { n: 1, s: 'a', list: [1, 2, 3] }).length, 1);
  assert.equal(validate(schema, { n: 1, s: 'a', list: ['x'] }).length, 1);
  assert.equal(validate(schema, { n: 1, s: 'a', inner: {} }).length, 1);
  assert.equal(validate(schema, { n: 1, s: 'a', b: 'yes' }).length, 1);
  assert.equal(validate(schema, []).length, 1);
  assert.throws(() => checkSchemaDefinition({ type: 'object', properties: { a: { $ref: '#/x' } } }), /not supported/);
  assert.throws(() => checkSchemaDefinition({ type: 'string' }), /root "type" must be "object"/);
});
