#!/bin/sh
# The live-HubSpot mode: the same workflows call the real HubSpot API in the author's free developer test account;
# every other vendor stays on the mock (Slack can be real too with --slack) and Claude answers are the recordings.
# The token comes from Doppler (project portfolio-website, config dev: RIDGEWAY_HUBSPOT_TOKEN, a HubSpot service key)
# and is never printed. Run setup once before anything else; it writes results/live-hubspot/portal.json.
#
#   scripts/live-hubspot.sh setup --dry-run          read the portal, print what setup would create, write nothing
#   scripts/live-hubspot.sh setup                    create what is missing (group, properties, pipeline, stages)
#   scripts/live-hubspot.sh smoke <event ids>        send these leads of the simulated day, save results, exit
#   scripts/live-hubspot.sh day                      the whole 40-lead day (paced, a few minutes)
#   scripts/live-hubspot.sh --slack smoke <ids>      the same with Slack real as well (the demo workspace's channel ids)
# Extra options after the command go to simulate-day.mjs, e.g. --serve (with --slack). Contacts are stored with
# <local>+<domain>@example.com addresses because HubSpot rejects .example; --no-hubspot-email-fallback turns that off
# (--hubspot-email-fallback is still accepted and changes nothing).
set -eu
demo=$(cd "$(dirname "$0")/.." && pwd)
slack=""
if [ "${1:-}" = "--slack" ]; then
  slack="--live-slack"
  export SLACK_TEAM_ID=T0C88V52NGN SLACK_LEADS_CHANNEL=C0C867WL7AR SLACK_ALERTS_CHANNEL=C0C89HQ4VML
  export SLACK_APPROVER_IDS="${SLACK_APPROVER_IDS:-U0C84MF082F}"
  shift
fi
# Secrets come from Doppler (project and config named explicitly, so the working directory does not matter).
# Without Doppler, export the variables yourself and set NO_DOPPLER=1.
run() { if [ -n "${NO_DOPPLER:-}" ]; then exec "$@"; fi; exec doppler run --project "${DOPPLER_PROJECT:-portfolio-website}" --config "${DOPPLER_CONFIG:-dev}" -- "$@"; }
usage() { echo "usage: $0 [--slack] setup [--dry-run] | smoke <event ids> [options] | day [options]" >&2; exit 2; }
command="${1:-}"
[ -n "$command" ] || usage
shift
case "$command" in
  setup) run node "$demo/scripts/hubspot-setup.mjs" "$@" ;;
  smoke) [ -n "${1:-}" ] || usage; ids="$1"; shift; run node "$demo/scripts/simulate-day.mjs" --live-hubspot $slack --only "$ids" "$@" ;;
  day) run node "$demo/scripts/simulate-day.mjs" --live-hubspot $slack "$@" ;;
  *) usage ;;
esac
