#!/usr/bin/env node
// claude-bridge: a local, single-user test bridge that answers Anthropic Messages API-shaped
// requests (POST /v1/messages with a JSON schema) by running the Claude Code CLI (`claude -p`) on a
// dedicated sign-in folder. It lets an n8n workflow be tested against a real Claude model on the
// user's own subscription; in production the same workflow points at https://api.anthropic.com with
// an API key. PERSONAL LOCAL TESTING ONLY, never for client or business production. See README.md.
//
// Zero dependencies (Node built-ins only).

import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSchemaDefinition, validate } from './schema-validate.mjs';

const DEFAULT_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
const LIMITS = {
  bodyBytes: 256 * 1024,
  drainBytes: 2 * 1024 * 1024, // oversize bodies are discarded up to this, then the socket is dropped
  systemBytes: 16 * 1024,
  userBytes: 32 * 1024,
  outputBytes: 2 * 1024 * 1024,
};
// The child gets ONLY these variables (plus CLAUDE_CONFIG_DIR). USER is load-bearing: the CLI looks
// up its Keychain credential with account = $USER; without it the CLI reports "not logged in".
const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'];
const DEFAULT_SYSTEM = 'Answer the user message. Reply only with data that matches the provided JSON schema.';
const CANARY_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/i;

class BridgeError extends Error {
  constructor(status, type, message, retryAfter) {
    super(message);
    this.status = status;
    this.type = type;
    this.retryAfter = retryAfter;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const delay = ms => new Promise(done => setTimeout(done, ms));
const sha256 = value => createHash('sha256').update(String(value)).digest();

// ---------------------------------------------------------------------------------------------
// Process groups. Every child is spawned detached (its own process group) so a timeout, abort or
// shutdown can kill the CLI and anything it started. A process 'exit' hook SIGKILLs leftovers.
const liveGroups = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const pid of liveGroups) signalGroup(pid, 'SIGKILL');
  });
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch { /* group already gone */ }
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function terminateGroup(pid, graceMs) {
  if (!pid) return;
  signalGroup(pid, 'SIGTERM');
  const soft = Date.now() + graceMs;
  while (Date.now() < soft) {
    if (!groupAlive(pid)) return;
    await delay(50);
  }
  signalGroup(pid, 'SIGKILL');
  const hard = Date.now() + 2000;
  while (Date.now() < hard && groupAlive(pid)) await delay(25);
}

// Runs one CLI process in a fresh temp folder. Never uses a shell. Resolves (never rejects) with
// { code, signal, stdout, stderr } plus one of { spawnError | stopped: 'timeout'|'overflow'|'aborted' }.
async function runProcess({ cli, args, env, input = '', timeoutMs, killGraceMs, signal }) {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-bridge-'));
  try {
    return await new Promise(settle => {
      let child;
      try {
        child = spawn(cli, args, { shell: false, cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true });
      } catch (error) {
        settle({ spawnError: error.code || error.message });
        return;
      }
      const pid = child.pid;
      if (pid) liveGroups.add(pid);
      const out = [];
      const err = [];
      let outBytes = 0;
      let errBytes = 0;
      let stopped = null;
      let settled = false;

      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (pid) {
          if (groupAlive(pid)) signalGroup(pid, 'SIGKILL'); // stragglers the CLI left behind
          liveGroups.delete(pid);
        }
        settle({
          ...result,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        });
      };
      const stop = reason => {
        if (stopped || settled) return;
        stopped = reason;
        child.stdout.destroy();
        child.stderr.destroy();
        terminateGroup(pid, killGraceMs).then(() => finish({ stopped: reason, code: child.exitCode, signal: child.signalCode }));
      };
      const onAbort = () => stop('aborted');

      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      if (signal?.aborted) stop('aborted');
      else signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', chunk => {
        outBytes += chunk.length;
        if (outBytes > LIMITS.outputBytes) return stop('overflow');
        out.push(chunk);
      });
      child.stderr.on('data', chunk => {
        errBytes += chunk.length;
        if (errBytes <= LIMITS.outputBytes) err.push(chunk);
      });
      child.on('error', error => {
        if (!pid) finish({ spawnError: error.code || error.message });
      });
      child.on('close', (code, sig) => {
        if (pid && !stopped) finish({ code, signal: sig });
      });
      // The prompt goes on stdin, never argv: no 3 s "no stdin" wait, and text that starts with
      // "--" can never be parsed as a CLI flag.
      if (child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      }
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Config dir and environment.

export async function resolveConfigDir(configDir) {
  if (typeof configDir !== 'string' || !configDir.trim()) {
    throw new Error('claude-bridge: configDir is required (a dedicated sign-in folder). Create one with: CLAUDE_CONFIG_DIR="$HOME/.claude-<purpose>" claude auth login');
  }
  let raw = configDir.trim();
  if (raw === '~' || raw.startsWith('~/')) raw = join(homedir(), raw.slice(1));
  else if (raw.startsWith('~')) throw new Error(`claude-bridge: configDir "${configDir}" uses ~user syntax; give an absolute path instead`);
  const resolved = resolve(raw);
  let info;
  try { info = await stat(resolved); } catch { info = null; }
  if (!info?.isDirectory()) {
    throw new Error(`claude-bridge: config dir ${resolved} does not exist or is not a directory. Sign in to it first: CLAUDE_CONFIG_DIR="${resolved}" claude auth login`);
  }
  const defaultDir = join(homedir(), '.claude');
  const [real, realDefault] = await Promise.all([realpath(resolved), realpath(defaultDir).catch(() => null)]);
  if (real === realDefault) {
    throw new Error('claude-bridge: config dir points at the default ~/.claude sign-in. Use a dedicated folder such as ~/.claude-n8n-bridge.');
  }
  return resolved; // not the realpath: the CLI keys its Keychain entry on the path as given
}

function buildChildEnv(configDir) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (typeof process.env[key] === 'string' && process.env[key] !== '') env[key] = process.env[key];
  }
  let username;
  try { username = userInfo().username; } catch { username = undefined; }
  env.HOME ??= homedir();
  if (username) {
    env.USER ??= username;
    env.LOGNAME ??= username;
  }
  env.PATH ??= '/usr/bin:/bin:/usr/sbin:/sbin';
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

// ---------------------------------------------------------------------------------------------
// Request parsing.

function textFromContent(content, where) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new BridgeError(400, 'invalid_request_error', `${where} must be a string or an array of text blocks`);
  const parts = [];
  for (const block of content) {
    if (!isPlainObject(block) || block.type !== 'text') {
      const kind = isPlainObject(block) && typeof block.type === 'string' ? block.type.slice(0, 40) : typeof block;
      throw new BridgeError(400, 'invalid_request_error', `${where}: content block type "${kind}" is not supported by the bridge (text blocks only)`);
    }
    if (typeof block.text !== 'string') throw new BridgeError(400, 'invalid_request_error', `${where}: text block is missing "text"`);
    parts.push(block.text);
  }
  return parts.join('\n\n');
}

export function parseMessagesRequest(body, allowedModels) {
  const bad = message => new BridgeError(400, 'invalid_request_error', message);
  if (!isPlainObject(body)) throw bad('request body must be a JSON object');
  const { model } = body;
  if (typeof model !== 'string' || !allowedModels.includes(model)) {
    throw bad(`model must be one of: ${allowedModels.join(', ')}`);
  }
  if (body.stream === true) throw bad('stream: true is not supported by the bridge');
  for (const key of ['tools', 'tool_choice', 'mcp_servers', 'container']) {
    const value = body[key];
    if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) {
      throw bad(`"${key}" is not supported by the bridge (structured text output only)`);
    }
  }
  if (body.metadata !== undefined) {
    if (!isPlainObject(body.metadata)) throw bad('metadata must be an object');
    const userId = body.metadata.user_id;
    if (userId !== undefined && userId !== null && (typeof userId !== 'string' || userId.length > 256)) {
      throw bad('metadata.user_id must be a string of at most 256 characters');
    }
  }

  let system = '';
  if (body.system !== undefined && body.system !== null) system = textFromContent(body.system, 'system');
  if (Buffer.byteLength(system) > LIMITS.systemBytes) throw bad(`system text exceeds ${LIMITS.systemBytes} bytes`);
  if (system.includes('\0')) throw bad('system text must not contain NUL characters');

  const { messages } = body;
  if (!Array.isArray(messages) || messages.length !== 1) throw bad('messages must contain exactly one user message');
  const [message] = messages;
  if (!isPlainObject(message) || message.role !== 'user') throw bad('messages[0].role must be "user"');
  const userText = textFromContent(message.content, 'messages[0].content');
  if (!userText.trim()) throw bad('messages[0] has no text');
  if (Buffer.byteLength(userText) > LIMITS.userBytes) throw bad(`user text exceeds ${LIMITS.userBytes} bytes`);

  const format = body.output_config?.format ?? body.output_format;
  if (!isPlainObject(format) || format.type !== 'json_schema' || format.schema === undefined) {
    throw bad('a JSON schema is required: output_config.format = { type: "json_schema", schema: {...} }');
  }
  try {
    checkSchemaDefinition(format.schema);
  } catch (error) {
    throw bad(`output schema: ${error.message}`);
  }
  return { model, system, userText, schema: format.schema };
}

function buildCliArgs(job) {
  // `--name=value` keeps values that start with "-" from being read as flags. `--tools ''` must be
  // followed by another flag because the option is variadic.
  return [
    '-p',
    `--model=${job.model}`,
    '--output-format', 'json',
    `--json-schema=${JSON.stringify(job.schema)}`,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    `--system-prompt=${job.system || DEFAULT_SYSTEM}`,
  ];
}

function parseCliJson(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through: last JSON line */ }
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
  }
  return null;
}

function modelMatches(requested, used) {
  if (used === requested) return true;
  if (!used.startsWith(requested)) return false;
  return /^(-\d{8})?(\[[^\]]*\])?$/.test(used.slice(requested.length));
}

function snippet(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function mapCliFailure(result, exitCode, configDir) {
  const text = `${result.result ?? ''} ${result.error ?? ''} ${result.terminal_reason ?? ''}`;
  const status = Number(result.api_error_status) || null;
  const detail = snippet(result.result ?? result.error ?? '');
  if (status === 401 || /not logged in|please run \/login|invalid api key|oauth token|authentication[_ ]error|unauthori[sz]ed/i.test(text)) {
    return new BridgeError(503, 'authentication_error', `claude CLI is not signed in to ${configDir}. Run: CLAUDE_CONFIG_DIR="${configDir}" claude auth login${detail ? ` (CLI said: ${detail})` : ''}`, 60);
  }
  if (status === 429 || /usage limit|rate[ _-]?limit|limit reached|hit your limit|out of extra usage|too many requests/i.test(text)) {
    return new BridgeError(429, 'rate_limit_error', `claude CLI hit a plan usage or rate limit${detail ? `: ${detail}` : ''}`, 60);
  }
  if (status === 529 || /overloaded/i.test(text)) {
    return new BridgeError(503, 'overloaded_error', `Claude is overloaded${detail ? `: ${detail}` : ''}`, 30);
  }
  const parts = [`subtype=${snippet(result.subtype) || 'none'}`, `exit=${exitCode}`];
  if (status) parts.push(`api_error_status=${status}`);
  return new BridgeError(502, 'api_error', `claude CLI reported an error (${parts.join(', ')})${detail ? `: ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------------------------

export async function startBridge({
  host = '127.0.0.1',
  port = 0,
  token,
  configDir,
  cli = 'claude',
  maxCalls = 60,
  timeoutMs = 90000,
  maxQueue = 4,
  allowedModels = DEFAULT_MODELS,
  // Optional extras (not part of the fixed contract): a log sink and the SIGTERM→SIGKILL grace.
  logger = line => process.stderr.write(`${line}\n`),
  killGraceMs = 5000,
} = {}) {
  if (host !== '127.0.0.1') throw new Error(`claude-bridge: host must be 127.0.0.1 (got ${JSON.stringify(host)}); the bridge never listens on other interfaces`);
  if (typeof token !== 'string' || token.length < 24) {
    throw new Error('claude-bridge: token must be a string of at least 24 characters. Generate one per run: openssl rand -hex 24');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('claude-bridge: port must be an integer 0-65535');
  if (!Number.isInteger(maxCalls) || maxCalls < 1) throw new Error('claude-bridge: maxCalls must be an integer >= 1 (the startup canary uses one)');
  if (!Number.isInteger(maxQueue) || maxQueue < 0) throw new Error('claude-bridge: maxQueue must be an integer >= 0');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('claude-bridge: timeoutMs must be a positive number');
  if (!Array.isArray(allowedModels) || allowedModels.length === 0 || !allowedModels.every(m => typeof m === 'string' && MODEL_ID.test(m))) {
    throw new Error('claude-bridge: allowedModels must be a non-empty array of model ids');
  }
  if (typeof cli !== 'string' || !cli) throw new Error('claude-bridge: cli must be a command name or path');

  const resolvedConfigDir = await resolveConfigDir(configDir);
  const childEnv = buildChildEnv(resolvedConfigDir);
  const models = [...allowedModels];
  const tokenDigest = sha256(token);
  installExitHook();

  let cliVersion = 'unknown';
  let account = null;
  let ready = false;
  let closing = false;
  let closePromise = null;
  let calls = 0;
  let errors = 0;
  let avgMs = 15000;
  const waiting = [];
  let running = null;
  let actualPort = null;

  const log = fields => {
    const line = Object.entries(fields).map(([k, v]) => `${k}=${v ?? '-'}`).join(' ');
    try { logger(`claude-bridge ${line}`); } catch { /* logging must never break a request */ }
  };

  // --- the production call path (used by HTTP requests and by the startup canary) -------------
  async function execute(job, signal) {
    const started = Date.now();
    const run = await runProcess({ cli, args: buildCliArgs(job), env: childEnv, input: job.userText, timeoutMs, killGraceMs, signal });
    const wallMs = Date.now() - started;
    avgMs = Math.round(avgMs * 0.7 + wallMs * 0.3);
    if (run.spawnError) throw new BridgeError(502, 'api_error', `could not start the claude CLI "${cli}" (${run.spawnError})`);
    if (run.stopped === 'timeout') throw new BridgeError(504, 'timeout_error', `claude CLI did not finish within ${timeoutMs} ms; its process group was killed`);
    if (run.stopped === 'overflow') throw new BridgeError(502, 'api_error', `claude CLI output exceeded ${LIMITS.outputBytes} bytes`);
    if (run.stopped === 'aborted') {
      throw closing
        ? new BridgeError(503, 'overloaded_error', 'bridge shut down while the call was running', 5)
        : new BridgeError(499, 'api_error', 'client disconnected; the CLI call was cancelled');
    }
    const result = parseCliJson(run.stdout);
    if (!isPlainObject(result)) throw new BridgeError(502, 'api_error', `claude CLI exited ${run.code ?? run.signal} without JSON output`);
    if (result.is_error === true || run.code !== 0 || (result.subtype && result.subtype !== 'success')) {
      throw mapCliFailure(result, run.code, resolvedConfigDir);
    }
    if (result.structured_output === undefined || result.structured_output === null) {
      throw new BridgeError(502, 'api_error', 'claude CLI returned no structured_output');
    }
    const problems = validate(job.schema, result.structured_output);
    if (problems.length) {
      throw new BridgeError(502, 'api_error', `structured_output does not match the request schema: ${problems.slice(0, 5).join('; ')}`);
    }
    const used = Object.keys(isPlainObject(result.modelUsage) ? result.modelUsage : {});
    if (!used.some(id => modelMatches(job.model, id))) {
      throw new BridgeError(502, 'api_error', `model mismatch: requested ${job.model}, CLI used ${used.map(snippet).join(', ') || 'nothing'}`);
    }
    const usage = isPlainObject(result.usage) ? result.usage : {};
    const n = value => (Number.isFinite(value) ? value : 0);
    return {
      id: `msg_bridge_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: job.model,
      content: [{ type: 'text', text: JSON.stringify(result.structured_output) }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.cache_read_input_tokens),
        output_tokens: n(usage.output_tokens),
      },
      bridge: {
        via: 'claude-code-cli',
        cli_version: cliVersion,
        duration_ms: Number.isFinite(result.duration_ms) ? result.duration_ms : wallMs,
        notional_cost_usd: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null,
        request_id: job.requestId,
      },
    };
  }

  // --- FIFO queue: exactly one CLI process at a time -------------------------------------------
  function pump() {
    if (running || waiting.length === 0) return;
    const entry = waiting.shift();
    entry.signal?.removeEventListener('abort', entry.onAbort);
    running = entry;
    calls += 1;
    entry.started = Date.now();
    execute(entry.job, entry.controller.signal)
      .then(entry.resolve, error => { errors += 1; entry.reject(error); })
      .finally(() => { running = null; pump(); });
  }

  function enqueue(job, signal) {
    if (closing) return Promise.reject(new BridgeError(503, 'overloaded_error', 'bridge is shutting down', 5));
    if (calls + waiting.length >= maxCalls) {
      return Promise.reject(new BridgeError(429, 'rate_limit_error', `bridge call budget spent (${maxCalls} calls this run). Restart the bridge to reset it.`, 3600));
    }
    if (running && waiting.length >= maxQueue) {
      const retryAfter = Math.max(1, Math.ceil((avgMs * (waiting.length + 1)) / 1000));
      return Promise.reject(new BridgeError(429, 'rate_limit_error', `bridge queue is full (${maxQueue} waiting); retry later`, retryAfter));
    }
    return new Promise((resolveJob, rejectJob) => {
      const controller = new AbortController();
      const entry = { job, signal, controller, resolve: resolveJob, reject: rejectJob };
      entry.onAbort = () => {
        const index = waiting.indexOf(entry);
        if (index !== -1) {
          waiting.splice(index, 1); // left before its turn: no CLI call, no budget used
          rejectJob(new BridgeError(499, 'api_error', 'client disconnected while queued'));
        } else if (running === entry) {
          controller.abort();
        }
      };
      if (signal?.aborted) return entry.onAbort();
      signal?.addEventListener('abort', () => entry.onAbort(), { once: true });
      waiting.push(entry);
      pump();
    });
  }

  // --- HTTP ------------------------------------------------------------------------------------
  const send = (res, status, body, headers = {}) => {
    if (res.headersSent || res.destroyed) return;
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    res.end(payload);
  };
  const sendError = (res, error, requestId) => {
    const known = error instanceof BridgeError;
    const status = known ? error.status : 500;
    const type = known ? error.type : 'api_error';
    const message = known ? error.message : 'internal bridge error';
    const headers = { 'request-id': requestId };
    if (error.retryAfter) headers['retry-after'] = String(error.retryAfter);
    if (status === 413) headers.connection = 'close';
    send(res, status === 499 ? 400 : status, { type: 'error', error: { type, message } }, headers);
    return type;
  };

  const tokenOk = req => {
    let supplied = req.headers['x-api-key'];
    if (supplied === undefined) {
      const auth = req.headers.authorization;
      if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) supplied = auth.replace(/^bearer\s+/i, '').trim();
    }
    if (typeof supplied !== 'string' || supplied.length === 0) return false;
    return timingSafeEqual(sha256(supplied), tokenDigest); // equal-length digests, constant time
  };

  const readBody = req => new Promise((resolveBody, rejectBody) => {
    const declared = Number(req.headers['content-length']);
    const tooLarge = () => new BridgeError(413, 'request_too_large', `request body exceeds ${LIMITS.bodyBytes} bytes`);
    if (Number.isFinite(declared) && declared > LIMITS.drainBytes) {
      rejectBody(tooLarge()); // answered with Connection: close, so the socket is dropped after
      return;
    }
    const chunks = [];
    let total = 0;
    let over = false;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > LIMITS.bodyBytes) over = true;
      if (total > LIMITS.drainBytes) { req.pause(); rejectBody(tooLarge()); return; }
      if (!over) chunks.push(chunk);
    });
    req.on('end', () => (over ? rejectBody(tooLarge()) : resolveBody(Buffer.concat(chunks))));
    req.on('error', () => rejectBody(new BridgeError(400, 'invalid_request_error', 'request body could not be read')));
  });

  async function handleMessages(req, res, ctx) {
    const raw = await readBody(req);
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') throw new BridgeError(400, 'invalid_request_error', 'content-type must be application/json');
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { throw new BridgeError(400, 'invalid_request_error', 'request body is not valid JSON'); }
    const job = parseMessagesRequest(body, models);
    job.requestId = ctx.requestId;
    ctx.model = job.model;
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableFinished) gone.abort(); });
    const message = await enqueue(job, gone.signal);
    send(res, 200, message, { 'request-id': ctx.requestId });
  }

  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
    const ctx = { requestId: `req_bridge_${randomUUID()}`, model: null, errorType: null, started: Date.now() };
    res.on('close', () => {
      log({
        req: ctx.requestId,
        model: ctx.model,
        status: res.headersSent ? res.statusCode : 'aborted',
        duration_ms: Date.now() - ctx.started,
        error: ctx.errorType,
        budget_left: Math.max(0, maxCalls - calls),
      });
    });
    try {
      const hostHeader = String(req.headers.host || '').toLowerCase();
      if (hostHeader !== `127.0.0.1:${actualPort}` && hostHeader !== `localhost:${actualPort}`) {
        throw new BridgeError(403, 'permission_error', 'Host header must be 127.0.0.1:<port> or localhost:<port>');
      }
      if (req.headers.origin !== undefined) throw new BridgeError(403, 'permission_error', 'browser requests (Origin header) are not allowed');
      if (!tokenOk(req)) throw new BridgeError(401, 'authentication_error', 'missing or invalid token (x-api-key or Authorization: Bearer)');
      if (closing) throw new BridgeError(503, 'overloaded_error', 'bridge is shutting down', 5);
      if (!ready) throw new BridgeError(503, 'overloaded_error', 'bridge is still running its startup checks', 5);
      const path = String(req.url || '').split('?')[0];
      if (req.method === 'GET' && path === '/health') {
        send(res, 200, { ok: true, cli_version: cliVersion, account, stats: stats(), budget_left: Math.max(0, maxCalls - calls) }, { 'request-id': ctx.requestId });
        return;
      }
      if (req.method === 'POST' && path === '/v1/messages') {
        await handleMessages(req, res, ctx);
        return;
      }
      throw new BridgeError(404, 'not_found_error', 'not found (routes: POST /v1/messages, GET /health)');
    } catch (error) {
      ctx.errorType = sendError(res, error, ctx.requestId);
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 64;

  function stats() {
    return { calls, errors, queued: waiting.length };
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const closed = new Promise(done => server.close(() => done()));
      for (const entry of waiting.splice(0)) {
        entry.reject(new BridgeError(503, 'overloaded_error', 'bridge is shutting down', 5));
      }
      if (running) {
        const current = running;
        current.controller.abort();
        while (running === current) await delay(20);
      }
      await delay(20); // let the aborted request's error response flush
      server.closeAllConnections();
      await closed;
    })();
    return closePromise;
  }

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => { server.off('error', rejectListen); resolveListen(); });
  });
  actualPort = server.address().port;

  // --- preflight: CLI present, signed in via claude.ai, canary through the production path -----
  try {
    const versionRun = await runProcess({ cli, args: ['--version'], env: childEnv, timeoutMs: 20000, killGraceMs });
    if (versionRun.spawnError) throw new Error(`could not run the claude CLI "${cli}" (${versionRun.spawnError}). Install Claude Code or pass cli/CLAUDE_BRIDGE_CLI.`);
    if (versionRun.code !== 0) throw new Error(`"${cli} --version" failed (exit ${versionRun.code ?? versionRun.stopped})`);
    cliVersion = (versionRun.stdout.match(/\d+\.\d+\.\d+/) || [versionRun.stdout.trim().slice(0, 40) || 'unknown'])[0];

    const authRun = await runProcess({ cli, args: ['auth', 'status'], env: childEnv, timeoutMs: 20000, killGraceMs });
    const status = parseCliJson(authRun.stdout);
    const login = `CLAUDE_CONFIG_DIR="${resolvedConfigDir}" claude auth login`;
    if (!isPlainObject(status)) throw new Error(`"claude auth status" did not return JSON (exit ${authRun.code ?? authRun.stopped}). Check the CLI install.`);
    if (status.loggedIn !== true) throw new Error(`not signed in to ${resolvedConfigDir}. Run: ${login}`);
    if (status.authMethod !== 'claude.ai') throw new Error(`signed in via "${snippet(status.authMethod)}", expected a claude.ai subscription sign-in. Run: ${login}`);
    if (status.apiProvider && status.apiProvider !== 'firstParty') throw new Error(`CLI provider is "${snippet(status.apiProvider)}", expected firstParty`);
    const email = typeof status.email === 'string' ? status.email : '';
    account = {
      emailDomain: email.includes('@') ? email.slice(email.lastIndexOf('@') + 1).toLowerCase() : 'unknown',
      plan: typeof status.subscriptionType === 'string' && status.subscriptionType ? status.subscriptionType : 'unknown',
    };

    const canaryModel = models.includes('claude-haiku-5-5') ? 'claude-haiku-5-5' : models[0];
    const canaryJob = parseMessagesRequest({
      model: canaryModel,
      max_tokens: 64,
      system: 'You are a health check. Set ok to true.',
      messages: [{ role: 'user', content: 'Health check: reply with ok set to true.' }],
      output_config: { format: { type: 'json_schema', schema: CANARY_SCHEMA } },
    }, models);
    canaryJob.requestId = `req_bridge_canary_${randomUUID()}`;
    const canaryStarted = Date.now();
    try {
      await enqueue(canaryJob);
      log({ req: canaryJob.requestId, model: canaryModel, status: 200, duration_ms: Date.now() - canaryStarted, error: null, budget_left: maxCalls - calls });
    } catch (error) {
      log({ req: canaryJob.requestId, model: canaryModel, status: error.status ?? 500, duration_ms: Date.now() - canaryStarted, error: error.type ?? 'api_error', budget_left: maxCalls - calls });
      throw new Error(`canary call failed (${error.status ?? 500} ${error.type ?? 'api_error'}): ${error.message}`);
    }
  } catch (error) {
    await close();
    throw new Error(error.message.startsWith('claude-bridge:') ? error.message : `claude-bridge: ${error.message}`);
  }
  ready = true;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    account: { ...account },
    stats,
    close,
  };
}

// ---------------------------------------------------------------------------------------------
// CLI mode: node claude-bridge.mjs

async function main() {
  const env = process.env;
  const intEnv = (name, fallback) => {
    if (env[name] === undefined || env[name] === '') return fallback;
    const value = Number(env[name]);
    if (!Number.isInteger(value)) throw new Error(`claude-bridge: ${name} must be an integer`);
    return value;
  };
  let bridge;
  try {
    bridge = await startBridge({
      port: intEnv('CLAUDE_BRIDGE_PORT', 0),
      token: env.CLAUDE_BRIDGE_TOKEN,
      configDir: env.CLAUDE_BRIDGE_CONFIG_DIR,
      maxCalls: intEnv('CLAUDE_BRIDGE_MAX_CALLS', 60),
      cli: env.CLAUDE_BRIDGE_CLI || 'claude',
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`ready ${bridge.url} account=${bridge.account.emailDomain}/${bridge.account.plan}\n`);
  let stopping = false;
  const shutdown = signal => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`claude-bridge: ${signal} received, shutting down (calls=${bridge.stats().calls})\n`);
    bridge.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
