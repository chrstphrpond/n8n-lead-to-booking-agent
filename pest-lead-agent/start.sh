#!/bin/sh
# Starts this project's n8n editor on 127.0.0.1 with its own data folder (see env.sh).
# Start it from your terminal, or detached:  nohup ./start.sh > ~/.n8n-pest-lead-agent/n8n.log 2>&1 &
# (A copy started as a background job inside an agent session can be stopped along with that session.)
#
# n8n is started with an allowlisted environment (env -i plus the names below), never with your whole shell
# environment: this demo sets N8N_BLOCK_ENV_ACCESS_IN_NODE=false, which lets every workflow read every variable
# n8n has. tests/n8n-env.mjs holds the same list for the test runner, and a unit test keeps the two in sync.
set -eu
cd "$(dirname "$0")"
. ./env.sh
if [ "$(n8n --version)" != "2.42.6" ]; then
  echo "start.sh: expected n8n 2.42.6, found $(n8n --version). Install with: pnpm add -g n8n@2.42.6 --allow-build=sqlite3" >&2
  exit 1
fi
mkdir -p "$N8N_USER_FOLDER"

SYSTEM_VARS="PATH HOME TMPDIR LANG"
DEMO_VARS="GENERIC_TIMEZONE EXECUTIONS_DATA_PRUNE EXECUTIONS_DATA_MAX_AGE EXECUTIONS_DATA_PRUNE_MAX_COUNT \
EXECUTIONS_DATA_HARD_DELETE_BUFFER EXECUTIONS_DATA_PRUNE_HARD_DELETE_INTERVAL \
NODE_FUNCTION_ALLOW_BUILTIN RIDGEWAY_TEST_MODE LEAD_WEBHOOK_SECRET \
ANTHROPIC_BASE_URL ANTHROPIC_API_KEY HUBSPOT_BASE_URL HUBSPOT_TOKEN \
CLICKUP_BASE_URL CLICKUP_TOKEN CLICKUP_LIST_ID SLACK_BASE_URL SLACK_BOT_TOKEN \
GMAIL_BASE_URL GMAIL_TOKEN SHEETS_BASE_URL SHEETS_TOKEN SHEETS_SPREADSHEET_ID OPS_RULES_SHEET_ID \
FIELDROUTES_BASE_URL FIELDROUTES_AUTH_KEY FIELDROUTES_AUTH_TOKEN EVENT_LEDGER_BASE_URL EVENT_LEDGER_TOKEN \
SLACK_LEADS_CHANNEL SLACK_ALERTS_CHANNEL SLACK_APPROVER_IDS SLACK_RELAY_SECRET"
N8N_VARS=$(env | sed -n 's/^\(N8N_[A-Za-z0-9_]*\)=.*/\1/p')

set --
for name in $SYSTEM_VARS $DEMO_VARS $N8N_VARS; do
  if [ -n "$(eval "printf %s \"\${$name+set}\"")" ]; then
    eval "value=\${$name}"
    set -- "$@" "$name=$value"
  fi
done
exec env -i "$@" n8n start
