#!/bin/sh
# Loads the generated workflows into this project's n8n data folder and publishes them.
# Restart n8n afterwards: publishing only takes effect on (re)start.
set -eu
cd "$(dirname "$0")"
. ./env.sh
node workflow/build-workflow.mjs
mkdir -p "$N8N_USER_FOLDER"
n8n import:workflow --input workflow/alert-on-errors.json
n8n import:workflow --input workflow/book-new-lead.json
n8n import:workflow --input workflow/handle-approval.json
n8n publish:workflow --id=pestLeadAlert001
n8n publish:workflow --id=pestLeadBook0001
n8n publish:workflow --id=pestLeadApprove1
echo "Imported and published. Restart n8n (./start.sh) to pick the workflows up."
