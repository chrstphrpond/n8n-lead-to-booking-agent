#!/usr/bin/env node
// Fake `claude` CLI for the bridge tests. It never calls a model.
// - `--version` and `auth status` behave like the real CLI (auth output can be overridden with
//   <CLAUDE_CONFIG_DIR>/fake-auth.json).
// - `-p` reads the prompt from stdin, records argv/env/stdin/pid to <CLAUDE_CONFIG_DIR>/calls/, then
//   behaves by a MODE:<name> marker in the prompt, or by <CLAUDE_CONFIG_DIR>/fake-mode for every call.
//   (Env vars from the test process cannot steer it: the bridge passes an allowlisted env only.)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR;
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);

if (argv[0] === '--version') {
  process.stdout.write('9.9.9 (Fake Claude)\n');
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'status') {
  const file = configDir && join(configDir, 'fake-auth.json');
  const status = file && existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'tester@example.test', subscriptionType: 'max' };
  write(status);
  process.exit(0);
}

const flag = name => {
  const eq = argv.find(arg => arg.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

// Builds the smallest value that satisfies a schema (enough for the bridge's validator).
function sample(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'object': {
      const out = {};
      for (const name of schema.required || Object.keys(schema.properties || {})) out[name] = sample(schema.properties?.[name]);
      return out;
    }
    case 'array': return Array.from({ length: schema.minItems || 0 }, () => sample(schema.items));
    case 'string': return 'x'.repeat(schema.minLength || 1);
    case 'integer': return Math.ceil(schema.minimum ?? 1);
    case 'number': return schema.minimum ?? 0.5;
    case 'boolean': return true;
    default: return null;
  }
}

const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString('utf8');
  const callsDir = join(configDir, 'calls');
  mkdirSync(callsDir, { recursive: true });
  writeFileSync(join(callsDir, `${Date.now()}-${process.pid}.json`), JSON.stringify({
    argv, env: process.env, stdin, pid: process.pid, cwd: process.cwd(),
  }));

  const modeFile = join(configDir, 'fake-mode');
  const mode = (stdin.match(/MODE:([a-z-]+)/) || [])[1] || (existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'ok');
  const model = flag('model');
  const schema = JSON.parse(flag('json-schema') || '{}');
  const base = {
    type: 'result', subtype: 'success', is_error: false, duration_ms: 12, num_turns: 1,
    result: '', total_cost_usd: 0.0001, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
    modelUsage: { [model]: { inputTokens: 15, outputTokens: 3 } }, terminal_reason: 'completed',
  };

  switch (mode) {
    case 'not-logged-in':
      write({ ...base, is_error: true, result: 'Not logged in · Please run /login', structured_output: undefined, modelUsage: {} });
      process.exit(1);
      break;
    case 'rate-limit':
      write({ ...base, is_error: true, api_error_status: 429, result: "You've hit your usage limit · resets 5pm" });
      process.exit(1);
      break;
    case 'bad-output':
      write({ ...base, structured_output: { unexpected: 'value' } });
      break;
    case 'model-swap':
      write({ ...base, structured_output: sample(schema), modelUsage: { 'claude-opus-5-5': { inputTokens: 1, outputTokens: 1 } } });
      break;
    case 'slow':
      setTimeout(() => write({ ...base, structured_output: sample(schema) }), 600);
      break;
    case 'sleep': {
      // Ignore SIGTERM so the bridge must escalate to SIGKILL, and start a grandchild in the same
      // process group to prove the whole group is killed.
      process.on('SIGTERM', () => {});
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(join(configDir, 'sleep-pids.json'), JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
      setInterval(() => {}, 1000);
      break;
    }
    default:
      write({ ...base, structured_output: sample(schema) });
  }
});
