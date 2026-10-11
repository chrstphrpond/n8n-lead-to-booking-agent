#!/bin/sh
# Saves the workflows as they are in the editor to workflow/exported/ and shows the diff against the
# generated files, so editor changes can be reviewed and folded back into workflow/build-workflow.mjs.
# (n8n exports a one-element array; it is unwrapped here so the diff lines up.)
set -eu
cd "$(dirname "$0")"
. ./env.sh
mkdir -p workflow/exported
n8n export:workflow --pretty --id=pestLeadBook0001 --output=workflow/exported/book-new-lead.json
n8n export:workflow --pretty --id=pestLeadAlert001 --output=workflow/exported/alert-on-errors.json
for f in book-new-lead alert-on-errors; do
  node -e "const fs=require('fs');const p='workflow/exported/$f.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));fs.writeFileSync(p,JSON.stringify(Array.isArray(j)?j[0]:j,null,2)+'\n')"
  echo "=== $f"
  diff -u workflow/$f.json workflow/exported/$f.json || true
done
