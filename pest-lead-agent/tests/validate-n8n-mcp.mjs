// Validates the three workflow JSON files with the n8n-mcp server's validate_workflow tool.
//   node tests/validate-n8n-mcp.mjs
// Spawns `pnpm dlx n8n-mcp` over stdio in documentation mode (no N8N_API_URL, so it can never touch an n8n
// instance), does the MCP initialize handshake, checks the tool's real input schema with tools/list, validates
// each workflow, writes results/n8n-mcp-validation.json and fails on any error. Warnings are kept in the
// results; the ones accepted are explained in VALIDATION.md.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = join(root, 'results');
mkdirSync(resultsDir, { recursive: true });
const FILES = ['book-new-lead.json', 'alert-on-errors.json', 'handle-approval.json'];

const env = { ...process.env, MCP_MODE: 'stdio', N8N_MCP_TELEMETRY_DISABLED: 'true', LOG_LEVEL: 'error', DISABLE_CONSOLE_OUTPUT: 'true' };
for (const key of Object.keys(env)) if (/^N8N_API_(URL|KEY)$/.test(key)) delete env[key];

const child = spawn('pnpm', ['dlx', 'n8n-mcp'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
let nextId = 0;
const pending = new Map();
child.stdout.on('data', chunk => {
  buffer += chunk;
  for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    } catch { /* ignore non-JSON output */ }
  }
});
child.stderr.on('data', () => {});

const request = (method, params) => new Promise((resolveRequest, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => reject(new Error(`n8n-mcp did not answer ${method} within 180s`)), 180000);
  pending.set(id, message => { clearTimeout(timer); resolveRequest(message); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});

let failure = null;
const report = { tool: 'validate_workflow', profile: 'runtime', server: null, input_schema_required: null, results: {} };
try {
  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pest-lead-agent-validation', version: '1.0.0' } });
  assert.ok(init.result, `initialize failed: ${JSON.stringify(init.error)}`);
  report.server = init.result.serverInfo;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const listed = await request('tools/list', {});
  const tool = listed.result.tools.find(item => item.name === 'validate_workflow');
  assert.ok(tool, 'the server must offer validate_workflow');
  report.input_schema_required = tool.inputSchema.required;
  assert.deepEqual(tool.inputSchema.required, ['workflow'], 'input schema changed: re-read tools/list');
  assert.ok(tool.inputSchema.properties.options.properties.profile, 'profile option expected');

  for (const file of FILES) {
    const workflow = JSON.parse(readFileSync(join(root, 'workflow', file), 'utf8'));
    const answer = await request('tools/call', { name: 'validate_workflow', arguments: { workflow, options: { profile: 'runtime' } } });
    assert.ok(answer.result, `${file}: ${JSON.stringify(answer.error)}`);
    const data = answer.result.structuredContent ?? JSON.parse(answer.result.content[0].text);
    report.results[file] = data;
  }
} catch (error) {
  failure = error;
} finally {
  child.kill();
  writeFileSync(join(resultsDir, 'n8n-mcp-validation.json'), `${JSON.stringify(report, null, 2)}\n`);
}

if (!failure) {
  for (const [file, data] of Object.entries(report.results)) {
    const errors = data.errors ?? [];
    const warnings = data.warnings ?? [];
    console.log(`${errors.length || data.valid === false ? 'FAIL' : 'ok  '} ${file}: valid=${data.valid}, ${errors.length} error(s), ${warnings.length} warning(s), ${data.summary?.totalNodes ?? '?'} nodes`);
    for (const error of errors) console.log(`  error: ${error.nodeName ?? ''} ${error.message ?? JSON.stringify(error)}`);
    if (errors.length || data.valid === false) failure = new Error(`${file} did not validate`);
  }
}
if (failure) {
  console.error(`FAIL: ${failure.message}`);
  process.exitCode = 1;
} else {
  console.log(`PASS: n8n-mcp ${report.server?.version} validate_workflow found no errors. Results: results/n8n-mcp-validation.json`);
}
