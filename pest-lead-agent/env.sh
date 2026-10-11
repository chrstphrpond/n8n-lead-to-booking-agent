# Source this file (". ./env.sh"); start.sh, import.sh and export.sh do it for you.
# One n8n per project, with its own data folder, listening on 127.0.0.1, with telemetry, version checks,
# templates and personalisation off and execution history pruned.
# Everything below is a fictional-demo setting: base URLs point at the local vendor mock and the tokens are
# placeholders for it. Real deployments take base URLs and secrets from the secret manager (Doppler) or n8n
# credentials instead; nothing here is a real secret and none of it is written into the workflow JSON.

export N8N_USER_FOLDER="${N8N_USER_FOLDER:-$HOME/.n8n-pest-lead-agent}"
export N8N_HOST=127.0.0.1
export N8N_LISTEN_ADDRESS=127.0.0.1
export N8N_PORT="${N8N_PORT:-5688}"
# Task runner broker for the editor. Run CLI executions on a different one:
#   N8N_RUNNERS_BROKER_PORT=5689 n8n execute --id pestLeadBook0001
export N8N_RUNNERS_BROKER_PORT="${N8N_RUNNERS_BROKER_PORT:-5690}"
export N8N_SECURE_COOKIE=false

export N8N_DIAGNOSTICS_ENABLED=false
export N8N_VERSION_NOTIFICATIONS_ENABLED=false
export N8N_TEMPLATES_ENABLED=false
export N8N_PERSONALIZATION_ENABLED=false
export N8N_HIRING_BANNER_ENABLED=false
export EXECUTIONS_DATA_PRUNE=true
export EXECUTIONS_DATA_MAX_AGE=168
export EXECUTIONS_DATA_PRUNE_MAX_COUNT=500
# The main workflow saves no data for successful runs (saveDataSuccessExecution: none). n8n 2.42.6 still writes the
# execution's first row (it holds the webhook payload, so the lead) and soft-deletes it when the run succeeds; the
# pruner hard-deletes it once it is older than this buffer (hours, default 1) at its next pass (every
# EXECUTIONS_DATA_PRUNE_HARD_DELETE_INTERVAL minutes, default 15). 0 means the next pass.
export EXECUTIONS_DATA_HARD_DELETE_BUFFER=0
export GENERIC_TIMEZONE=America/New_York

# The workflow reads env in Code nodes and expressions, and signs/verifies with crypto.
# WARNING: N8N_BLOCK_ENV_ACCESS_IN_NODE=false lets ANY workflow or Code node read EVERY variable in n8n's
# environment (all the tokens below, and anything else n8n inherited). That is why start.sh starts n8n with an
# allowlisted environment (env -i). A production deployment should keep this variable at its default (true)
# and give n8n credentials (HTTP Header Auth, Slack, HubSpot and so on) instead of $env reads.
export N8N_BLOCK_ENV_ACCESS_IN_NODE=false
export NODE_FUNCTION_ALLOW_BUILTIN=crypto

# --- demo configuration -------------------------------------------------------------------------
# Start the vendor mock first:  MOCK_PORT=5700 node mock/server.mjs
MOCK_URL="${MOCK_URL:-http://127.0.0.1:5700}"
export LEAD_WEBHOOK_SECRET="${LEAD_WEBHOOK_SECRET:-demo-local-webhook-secret}"
export RIDGEWAY_TEST_MODE="${RIDGEWAY_TEST_MODE:-true}"   # honors the x-ridgeway-test-now header; never set in production

# Replay mode: the mock answers Claude from fixtures/llm. Live mode: point this at the Claude bridge
# (_shared/claude-bridge) and set ANTHROPIC_API_KEY to the bridge token. Production: https://api.anthropic.com
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-$MOCK_URL/anthropic}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-demo-placeholder-not-a-key}"

export HUBSPOT_BASE_URL="$MOCK_URL/hubspot"       HUBSPOT_TOKEN=demo-placeholder-hubspot
export CLICKUP_BASE_URL="$MOCK_URL/clickup"       CLICKUP_TOKEN=demo-placeholder-clickup CLICKUP_LIST_ID=901100123
export SLACK_BASE_URL="$MOCK_URL/slack"           SLACK_BOT_TOKEN=demo-placeholder-slack
# Channel names for the mock; a real workspace needs channel ids (see scripts/live-slack.sh).
export SLACK_LEADS_CHANNEL="${SLACK_LEADS_CHANNEL:-#leads}"   SLACK_ALERTS_CHANNEL="${SLACK_ALERTS_CHANNEL:-#automation-alerts}"
# Approve / Hold (workflow "Handle approval"): who may decide (comma list of Slack user ids; empty means nobody,
# so the editor fails closed) and the secret the Socket Mode relay signs with (slack-relay/relay.mjs).
export SLACK_APPROVER_IDS="${SLACK_APPROVER_IDS:-}"
export SLACK_RELAY_SECRET="${SLACK_RELAY_SECRET:-demo-local-relay-secret}"
export GMAIL_BASE_URL="$MOCK_URL/gmail"           GMAIL_TOKEN=demo-placeholder-gmail
export SHEETS_BASE_URL="$MOCK_URL/sheets"         SHEETS_TOKEN=demo-placeholder-sheets
export SHEETS_SPREADSHEET_ID=demo-sheet-id        OPS_RULES_SHEET_ID=ridgeway-ops-rules
export FIELDROUTES_BASE_URL="$MOCK_URL/fieldroutes"
export FIELDROUTES_AUTH_KEY=demo-placeholder-key  FIELDROUTES_AUTH_TOKEN=demo-placeholder-token
# The event ledger (one claim per event id; a stand-in served by the mock, a database or Redis in production)
export EVENT_LEDGER_BASE_URL="$MOCK_URL/ledger"   EVENT_LEDGER_TOKEN=demo-placeholder-ledger
