#!/bin/sh
# The live-Slack stack for the throwaway demo workspace "Ridgeway Pest Control (demo)": n8n and the vendor mock (every
# vendor except Slack is mocked, Claude answers are the recordings) plus the Socket Mode relay for Approve / Hold.
# Tokens come from Doppler (project portfolio-website, config dev: RIDGEWAY_SLACK_BOT_TOKEN, RIDGEWAY_SLACK_APP_TOKEN,
# RIDGEWAY_SLACK_RELAY_SECRET) and are never printed. Channel, team and approver ids below are not secrets.
#
#   scripts/live-slack.sh                         serve: start from results/live-slack/mock-state.json, wait for clicks
#   scripts/live-slack.sh --post <event ids>      post these leads of the simulated day to #leads, then serve
#   scripts/live-slack.sh --smoke <event ids>     post these leads, save the state, exit
#   scripts/live-slack.sh --check                 only check the app token: connect over Socket Mode, wait for hello
# Serve runs until Ctrl-C. Example: scripts/live-slack.sh --post evt-d1013-010   (a commercial lead that needs approval)
set -eu
demo=$(cd "$(dirname "$0")/.." && pwd)
export SLACK_TEAM_ID=T0C88V52NGN SLACK_LEADS_CHANNEL=C0C867WL7AR SLACK_ALERTS_CHANNEL=C0C89HQ4VML
export SLACK_APPROVER_IDS="${SLACK_APPROVER_IDS:-U0C84MF082F}"
# Secrets come from Doppler (project and config named explicitly, so the working directory does not matter).
# Without Doppler, export the variables yourself and set NO_DOPPLER=1.
run() { if [ -n "${NO_DOPPLER:-}" ]; then exec "$@"; fi; exec doppler run --project "${DOPPLER_PROJECT:-portfolio-website}" --config "${DOPPLER_CONFIG:-dev}" -- "$@"; }
case "${1:-}" in
  "") run node "$demo/scripts/simulate-day.mjs" --live-slack --serve --resume ;;
  --post) [ -n "${2:-}" ] || { echo "usage: $0 --post <event ids>" >&2; exit 2; }; run node "$demo/scripts/simulate-day.mjs" --live-slack --serve --only "$2" ;;
  --smoke) [ -n "${2:-}" ] || { echo "usage: $0 --smoke <event ids>" >&2; exit 2; }; run node "$demo/scripts/simulate-day.mjs" --live-slack --only "$2" ;;
  --check) run node "$demo/slack-relay/relay.mjs" --check ;;
  *) echo "usage: $0 [--post <event ids> | --smoke <event ids> | --check]" >&2; exit 2 ;;
esac
