// The environment n8n is started with: an allowlist, never a copy of the caller's environment.
// With N8N_BLOCK_ENV_ACCESS_IN_NODE=false every workflow (and every Code node) can read every variable in
// n8n's environment, so n8n must not inherit anything it does not need. start.sh applies the same list with
// `env -i`; a unit test keeps the two in sync.
export const SYSTEM_VARIABLES = ['PATH', 'HOME', 'TMPDIR', 'LANG'];
export const N8N_PREFIX = 'N8N_';
export const DEMO_VARIABLES = [
  'GENERIC_TIMEZONE', 'EXECUTIONS_DATA_PRUNE', 'EXECUTIONS_DATA_MAX_AGE', 'EXECUTIONS_DATA_PRUNE_MAX_COUNT',
  'EXECUTIONS_DATA_HARD_DELETE_BUFFER', 'EXECUTIONS_DATA_PRUNE_HARD_DELETE_INTERVAL',
  'NODE_FUNCTION_ALLOW_BUILTIN', 'RIDGEWAY_TEST_MODE', 'LEAD_WEBHOOK_SECRET',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'HUBSPOT_BASE_URL', 'HUBSPOT_TOKEN',
  'CLICKUP_BASE_URL', 'CLICKUP_TOKEN', 'CLICKUP_LIST_ID', 'SLACK_BASE_URL', 'SLACK_BOT_TOKEN',
  'GMAIL_BASE_URL', 'GMAIL_TOKEN', 'SHEETS_BASE_URL', 'SHEETS_TOKEN', 'SHEETS_SPREADSHEET_ID', 'OPS_RULES_SHEET_ID',
  'FIELDROUTES_BASE_URL', 'FIELDROUTES_AUTH_KEY', 'FIELDROUTES_AUTH_TOKEN', 'EVENT_LEDGER_BASE_URL', 'EVENT_LEDGER_TOKEN',
  'SLACK_LEADS_CHANNEL', 'SLACK_ALERTS_CHANNEL', 'SLACK_APPROVER_IDS', 'SLACK_RELAY_SECRET',
];

const allowed = name => SYSTEM_VARIABLES.includes(name) || DEMO_VARIABLES.includes(name) || name.startsWith(N8N_PREFIX);

// `settings` are the variables the demo sets on purpose; a name outside the allowlist is a bug, so it throws.
// Only the four system variables are taken from `system` (normally process.env).
export function buildN8nEnv(settings, system = process.env) {
  const env = {};
  for (const name of SYSTEM_VARIABLES) if (system[name] !== undefined) env[name] = system[name];
  for (const [name, value] of Object.entries(settings)) {
    if (!allowed(name)) throw new Error(`${name} is not on the n8n environment allowlist`);
    env[name] = String(value);
  }
  return env;
}
