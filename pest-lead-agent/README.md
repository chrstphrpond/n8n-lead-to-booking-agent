# Pest Lead Agent: lead to booking in n8n

A working n8n demo for one silo of a pest-control back office: a new lead arrives and leaves with a qualified HubSpot deal, proposed FieldRoutes appointment slots, a CSR task and a Slack alert. A manager approves or holds the leads that need it with buttons in Slack.

**Everything here is fictional.** Ridgeway Pest Control (branches in Jacksonville FL, Savannah GA and Mobile AL), its customers, streets, phones (555-0100 to 555-0199) and emails (`.example` domains) are made up; the ZIP codes are real and the prices are illustrative placeholders, see [Demo data](#demo-data). Every vendor API (HubSpot, ClickUp, Slack, Gmail, Google Sheets, FieldRoutes) is a **local mock** that approximates the vendor's shapes. The exceptions are two optional live modes: in [live Slack mode](#live-slack-and-the-approve--hold-buttons) Slack is real, in a throwaway workspace of the author's own ("Ridgeway Pest Control (demo)"); in [live HubSpot mode](#live-hubspot) HubSpot is real, in the author's free HubSpot developer test account. Every other vendor is still the mock. **Live HubSpot ran on 2026-10-11 (phase 2) against the author's HubSpot developer test account; see [Live HubSpot](#live-hubspot).** Nothing is sent to a real customer, no real business account is touched, and nothing here has run in production. See [Scope and limits](#scope-and-limits).

What is real: an n8n 2.42.6 server runs the imported workflows, the test runner posts HMAC-signed requests to the production webhook, the workflow's HTTP Request nodes call the (mock) vendors, and the qualification step is a real Claude Haiku 5.5 call (recorded for replay, live through a local bridge). Two fixtures are hand-written and labelled synthetic (see [Scope and limits](#scope-and-limits)). In live Slack mode the Slack Web API calls (and the Socket Mode connection for the buttons) are real as well, and in live HubSpot mode so are the HubSpot CRM calls.

## Run it

Needs Node 24, pnpm and the global n8n 2.42.6 (`pnpm add -g n8n@2.42.6 --allow-build=sqlite3`). From the repository root:

```sh
node --test pest-lead-agent/tests/          # unit tests: pure logic, Code-node glue, builder, mock, fixtures, start.sh, the Slack relay; no n8n server, no network
node pest-lead-agent/tests/verify.mjs       # full run against a real n8n server, replay mode (a few minutes)
node pest-lead-agent/tests/verify.mjs --only gmail_down,approve_lead      # just these scenarios or checks
node pest-lead-agent/tests/validate-n8n-mcp.mjs   # n8n-mcp validate_workflow on the three workflow files
node pest-lead-agent/scripts/simulate-day.mjs     # the 40-lead day, see Demo data (under a minute, no Claude call)
pest-lead-agent/scripts/live-slack.sh --post evt-d1013-010   # live Slack: post a lead to the demo workspace, then serve the buttons (see below)
pest-lead-agent/scripts/live-hubspot.sh setup --dry-run      # live HubSpot (ran in phase 2): see "Live HubSpot"
```

`verify.mjs` rebuilds the workflow JSON, asserts `n8n --version` is 2.42.6, imports and publishes the three workflows with the n8n CLI into a temporary `N8N_USER_FOLDER`, starts `n8n start` on a free port bound to 127.0.0.1 **with an allowlisted environment**, waits until both production webhooks answer, then runs 21 scenarios plus the extra checks (missing signature, two-delivery replay, error workflow, redelivery while a run is in flight, redelivery after a failed run, seven Approve / Hold checks, the live-HubSpot parity check, environment allowlist, execution history). Each scenario asserts on the HTTP response, on the mock's request log (which endpoints were called, how many times, with what bodies and headers) **and on the mock's state** (how many contacts, deals, tasks, drafts, Slack posts and sheet rows actually exist, and what the event ledger holds). n8n and the mock are stopped at the end, also on failure. Results land in [`results/`](results/), and every complete run also leaves a timestamped summary in `results/runs/`; see [`VALIDATION.md`](VALIDATION.md).

Recording and live mode (these use your Claude subscription through the bridge, and the calls count against its limits):

```sh
node pest-lead-agent/scripts/record-llm.mjs           # record Claude answers that are missing or stale; add --force for all
node pest-lead-agent/tests/verify.mjs --live-llm      # same suite, Claude answers come from the live bridge
```

Both start the shared bridge in `_shared/claude-bridge/` with `CLAUDE_BRIDGE_CONFIG_DIR` (default `~/.claude-n8n-bridge`, a dedicated sign-in folder; the default `~/.claude` login is never used).

To use the n8n editor on this project: `./import.sh` (all three workflows), then `./start.sh` (own data folder `~/.n8n-pest-lead-agent`, port 5688, 127.0.0.1 only, telemetry off, started with an allowlisted environment, see [Environment exposure](#environment-exposure)), with the mock running (`MOCK_PORT=5700 node mock/server.mjs`). `./export.sh` saves what is in the editor to `workflow/exported/` and diffs it against the generated files.

## Demo data

The leads, customers and prices are written to read like a real Southeast pest-control operation while staying obviously fictional. This is what is real and what is not.

| | Real | Invented |
| --- | --- | --- |
| Places | the ZIP codes (15 Jacksonville FL, 11 Savannah GA, 11 Mobile AL, plus four out-of-area ones: 32301 Tallahassee, 30303 Atlanta, 36104 Montgomery, 33602 Tampa), their post-office city names, area codes and time zones | the street names and house numbers, so no address is a real house |
| People and companies | nothing | every name, the company (Ridgeway Pest Control) and every business named in a lead |
| Contact details | the formats people really type: `(904) 555-0150`, `904.555.0150`, `9045550150`, `+1 904-555-0150`, and caller-ID names in capitals | phones only in 555-0100 to 555-0199 (the range reserved for fiction), emails only on `.example` domains (`gmail.example`, `outlook.example`) |
| Prices | the services priced and the kind of range a Southeast office quotes | every number: `fixtures/ops-rules.json` labels each price `"basis": "illustrative — pending sourced research"`. The sourced price research could not be done (the crawling service was out of credits), so the figures are conservative placeholders, not researched and not Ridgeway's |
| Vendors | n8n 2.42.6 and Claude (recorded answers) | every vendor API is a local mock that approximates the vendor's shapes |

**Payload shapes.** Each source looks like the system that would send it. The sender's relay adds one field of its own, `event_id`.

- `web_form`: a WordPress / Gravity Forms webhook entry: `form_id` (3 is the free inspection request, 5 the commercial quote request), `entry_id`, `date_created` (UTC), `source_url`, `user_agent`, `ip` (documentation ranges) and `fields` keyed by Gravity Forms field id (`1.3` first name, `1.6` last name, `2` phone, `3` email, `4.1`/`4.3`/`4.4`/`4.5` street, city, state, ZIP, `5` message, `6.1` text-message consent).
- `hubspot_form`: a HubSpot form submission: `portalId`, `formGuid`, `submittedAt` in epoch milliseconds, `fields: [{name, value}]` and `context: {hutk, pageUri, pageName}`.
- `call_tracking`: a CallRail-style post-call webhook: `call_id`, `start_time` (with the branch's UTC offset), `duration`, `direction`, `answered`, `voicemail`, `caller_number`, `caller_name` (often in capitals, as caller ID prints it), `tracking_number`, `source_name` and the `transcription`, written the way speech is transcribed (fillers, corrections, "uh, Lane, no wait, Road"). A call has no ZIP field, so `normalize` reads it from what the caller says ("Savannah, Georgia, 31405"; a bare five-digit number is not enough because house numbers have five digits too). `customer_email` and `sms_consent` are invented fields standing for the call flow's text-back step.

**What the workflow reads from each seed** (the rest is there so the state looks lived-in):

- FieldRoutes (`fixtures/fieldroutes/`): 25 customers (quarterly general pest, termite bond renewals, mosquito add-ons, one commercial account with 96 units, three cancelled), 7 technicians (3 Jacksonville, 2 Savannah, 2 Mobile) on route days, offices open Monday to Friday 8 to 5 and Saturday 8 to 12 local time, two-hour arrival windows. A window is taken by an existing customer's next visit or by a deterministic hash (45%, "already sold"); the 3 PM window of every route is never pre-booked, which is the emergency rule (the workflow does not know it; it simply always finds a spot when it searches today and tomorrow). The workflow reads only `customerID`, `status` and `phone1` of a customer, and `spotID`, `date`, `start`, `end` of a spot.
- HubSpot (`fixtures/hubspot/`): the custom properties the workflows write and their property group (`properties.json`, which the live setup script creates in a real portal), the deals pipeline with its nine stages (New lead, Contacted, Inspection scheduled, Needs approval, Approved, On hold, Quote sent, Won, Lost; the lead workflow writes New lead and Needs approval, the approval workflow Approved and On hold), 15 contacts (nine are also FieldRoutes customers; two are one person entered twice, with a different email, first-name spelling and phone format, which an exact phone search cannot see) and 15 deals at every stage.
- ClickUp (`fixtures/clickup/csr-queue.json`): the "CSR Queue" list, its statuses, the custom fields a pest office would use (Branch, Pest, Urgency, HubSpot deal link, Callback by) and five open tasks. Every task the workflow creates fills them (`custom_fields: [{id, value}]`, ClickUp v2): drop-down option ids for branch, pest and urgency, the HubSpot deal link, and a "Callback by" deadline (Unix ms: arrival time plus 1, 4 or 24 hours for emergency, high or normal). The field and option ids are rows of the rules sheet's Settings tab (`clickup_field_*`, `clickup_options_*`), so a re-created field is a sheet edit. A value the workflow does not know (no deal yet, no pest on a review task) is left out. The mock refuses a field id the list does not have, like ClickUp. Approve / Hold adds a comment to the CSR task.
- Ops rules (`fixtures/ops-rules.json`, the mocked Google Sheet): the service-area table (the ZIPs above), the 11-row `Pricing` tab the workflow reads (one row per pest type plus `wdo_letter`, a WDO / termite letter for a real estate closing at an illustrative $125), the `Settings` tab (thresholds, urgency windows, the ClickUp field ids, the callback hours, `wdo_keywords`, the words that mark a termite-letter request, and the HubSpot rows: `hubspot_pipeline_id`, `hubspot_stage_new_lead`, `hubspot_stage_needs_approval`, `hubspot_stage_approved`, `hubspot_stage_on_hold`, `hubspot_app_url` (the record-link base) and `hubspot_email_fallback`; the mock's sheet keeps the invented `ridgeway_*` ids, a live portal's generated ids replace them) and a `Price list` tab with 21 residential and commercial line items (general pest, ants and fire ants, roaches, termite inspection, WDO letter, liquid treatment, bait stations and bond renewal, rodent trapping and exclusion, monthly mosquito, bed bug chemical and heat, wildlife trap and exclusion, stinging insects, restaurant IPM) that the `Pricing` tab was derived from.

**The week.** The scenarios are spread over Monday October 12 to Saturday October 17, 2026 (business hours, evenings, a Saturday morning), each in its branch's own time zone: every scenario carries `now`, the instant the test clock reads when the lead reaches n8n. The 40 leads of the simulated day are in `fixtures/day/leads.json`.

**Recorded Claude answers.** Every scenario lead and every distinct lead of the day has one real Claude recording (`fixtures/llm/`, made through the shared bridge); the two hand-written fixtures stay labelled `"synthetic": true`. A recording is only valid for the exact request the workflow sends, so rewriting a lead means re-recording it (`node scripts/record-llm.mjs --dry-run` lists what is stale and what it would cost).

### Simulate a day

```sh
node pest-lead-agent/scripts/simulate-day.mjs
```

It starts the same real n8n and mock as `tests/verify.mjs` (`tests/harness.mjs`), sends the 40 deliveries of Tuesday October 13, 2026 one at a time with the test clock set to each arrival, and writes [`results/day/state.json`](results/day/state.json) (the mock's final state: contacts, deals, ClickUp tasks, Slack posts with their blocks, Sheets rows, the ledger), [`results/day/deliveries.json`](results/day/deliveries.json) (one row per delivery) and [`results/day/kpi.md`](results/day/kpi.md): leads by branch and source, status counts, speed to lead (p50 and p90), open pipeline value by stage, the approval queue and the top pests. It makes no Claude call (the recordings are replayed) and takes under a minute. `--only <event ids>` and `--limit N` send a subset (then `results/day/` is left alone). `--live-slack` sends the day's Slack posts to a real workspace instead of the mock, see the next section.

**Termite letters.** A realtor asking for a WDO report ("termite letter") for a closing is an inspection request, not a termite job. The model's labels cannot say so (the schema's pest types are fixed, and changing them would invalidate every recording): one realtor's request came back `termites`, the other's `other`. So the workflow reads the customer's own text: an inspection request whose message contains one of the sheet's `wdo_keywords` (whole words: `wdo`, `wood destroying`, `termite letter`, `termite clearance`) is priced on the `wdo_letter` row ($125, illustrative) whatever pest the model named. The approval list names Pricing rows, so a termite job still needs approval and a termite letter does not. In the simulated day this moved Priscilla Greer's letter from a $1,200 deal in the approval queue to a $125 auto-proposed one, and Candice Moreau's from $100 (priced as `other`) to $125. The deal is named "WDO letter" and the CSR task says "priced as wdo letter".

## Live Slack and the Approve / Hold buttons

Slack is the one vendor that can be real, in the author's own throwaway workspace "Ridgeway Pest Control (demo)" (the bot "Ridgeway Lead Agent (demo)" with the scopes `chat:write`, `channels:read`, `channels:manage`, `channels:join`; Socket Mode on). Every other vendor stays on the mock and Claude stays on the recordings, so a live run makes no Claude call. The tokens live only in Doppler (`RIDGEWAY_SLACK_BOT_TOKEN`, `RIDGEWAY_SLACK_APP_TOKEN`, `RIDGEWAY_SLACK_RELAY_SECRET`) and are never printed or written to `results/`.

```sh
pest-lead-agent/scripts/live-slack.sh --check                    # the app token works: Socket Mode hello, then exit
pest-lead-agent/scripts/live-slack.sh --smoke evt-d1013-001,evt-d1013-010   # post these leads to #leads, save the state, exit
pest-lead-agent/scripts/live-slack.sh --post evt-d1013-010       # post, then keep running for clicks until Ctrl-C
pest-lead-agent/scripts/live-slack.sh                            # keep running for clicks, from the saved state
```

`live-slack.sh` runs from the repository root through `doppler run` and sets the workspace's ids (team `T0C88V52NGN`, #leads `C0C867WL7AR`, #automation-alerts `C0C89HQ4VML`, approver `U0C84MF082F`; none of them is a secret). Under it is `scripts/simulate-day.mjs --live-slack [--only ids | --limit N] [--serve [--resume]]`:

- **Live mode** points `SLACK_BASE_URL` at `https://slack.com` and passes the bot token; it refuses to start when the token is missing or does not start with `xoxb-`, and when a channel is a name instead of an id (a real workspace takes channel ids; `SLACK_LEADS_CHANNEL` and `SLACK_ALERTS_CHANNEL` default to the mock's `#leads` and `#automation-alerts`, so the mock path is unchanged). It writes `results/live-slack/deliveries.json` (each delivery with the channel id and ts of its post) and `results/live-slack/mock-state.json`, not `results/day/`.
- **Rate limits.** `chat.postMessage` allows about one message per second per channel, so live mode waits 1.2 s after each answer before the next lead. A 429 is retried by n8n's normal retries (3 retries 5 s apart, longer than the one or two seconds Slack's `Retry-After` usually asks for; n8n does not read the header). The scenario `slack_rate_limited` proves it against the mock: one 429 with `Retry-After: 1`, the retry 5 s later posts, one message exists. Slack's own errors (`not_in_channel`, `invalid_auth`) come back as HTTP 200 with `ok: false`; the run records `slack_post_failed` and goes on.
- **Slack has no idempotency key for `chat.postMessage`.** The workflow still sends `Idempotency-Key` (the mock honors it), but Slack ignores it. A retry after a timeout or a 5xx that Slack had in fact processed posts the message twice. The demo does nothing beyond the retries about that: a sender's redelivery is stopped by the event ledger before any post, and a duplicate summary costs a person a second look, not a second booking. A production build that must never double-post would check `conversations.history` for the event id before a retry, which needs the `channels:history` scope this bot does not have.
- **`--serve`** keeps n8n and the mock running and starts the Socket Mode relay ([`slack-relay/`](slack-relay/README.md)) in the same process, until Ctrl-C. The mock's state (the ledger with each lead's deal, task and message ids) is saved to `results/live-slack/mock-state.json` every few seconds and on exit, and `--resume` starts from it, so a message posted by an earlier run can still be clicked.

**The click, end to end.** Slack sends the click over the relay's WebSocket. The relay acks it at once and POSTs ids only, signed, to `/webhook/ridgeway/slack-action`. The workflow "Pest Lead Agent · Handle approval" (`workflow/handle-approval.json`, id `pestLeadApprove1`):

1. verifies the relay's signature (401, no call of any kind) and the payload: exactly eight id fields, a known action (400 otherwise);
2. checks the user against `SLACK_APPROVER_IDS` (a comma list; empty means nobody, so it fails closed). Anyone else gets a `chat.postEphemeral` ("Only approvers can approve or hold a lead") and nothing else happens (403);
3. claims the decision in the event ledger. The first decision on a lead wins: a repeat click, a Slack redelivery or a late Hold answers `already_decided` with no second update, and a lead that never needed approval answers 409. The claim also hands back the ids the lead's own run stored when it finished (deal, CSR task, the message's channel and ts, and the summary's blocks without the buttons). The button carries the event id and nothing else, so nothing is trusted from Slack beyond that id;
4. reads the Settings tab of the rules sheet (the stage ids live there), moves the HubSpot deal from Needs approval to Approved or On hold, adds a comment to the ClickUp CSR task ("Approved in Slack by user U... at Oct 13, 9:37 AM EDT. Book the visit."), and runs `chat.update` on the original message, which keeps the summary and replaces the buttons with "Approved by @user at <time>" (or "Put on hold by"), in the branch's time zone;
5. marks the decision done in the ledger. Every write carries `Idempotency-Key: <event id>:<node name>` and `X-Run-Id`. A failed run goes to the error workflow, which hands the decision back (marked failed), so the next click is processed again (`approval_after_failure`).

Limits of this part: the click test in the real workspace is done by a person (the relay, the workflow and the ledger are tested against the mock, and the relay's `hello` against Slack). If `chat.update` fails, the decision still stands, the response carries `slack_update_failed` and the buttons stay. A further click then answers `already_decided`, so the message has to be fixed by hand. If a decision run fails after the deal stage was written and the approver then clicks the other button, a strict idempotency service (like the mock) refuses the second deal update because the key is the same and the body differs. HubSpot itself ignores the key, so there the second decision wins.

## Live HubSpot

**Status: run on 2026-10-11 (phase 2). What is real:** HubSpot, in the author's developer test account 247657707 (data hosted in `na2`), called with a service key that has the 8 scopes below; with `--slack`, Slack too, in the demo workspace. **What is still mocked:** FieldRoutes, ClickUp, Gmail, Google Sheets and the event ledger. **Claude answers are replayed recordings**, so the phase-2 runs made no Claude call. The results are in [VALIDATION.md](VALIDATION.md#live-hubspot) and `results/live-hubspot/`; the surprises are BUILD-LOG.md entries 50 to 52.

The same three workflows call the real HubSpot API (`https://api.hubapi.com`, the legacy `/crm/v3` and `/crm/v4` paths, which HubSpot still supports next to its dated versions, [versioning](https://developers.hubspot.com/docs/developer-tooling/platform/versioning)) in the author's free HubSpot developer test account (portal 247657707, data hosted in `na2`, Enterprise trial features on). Every other vendor stays on the mock, Slack can be real as well (`--slack`), and Claude answers are the recordings, so a live-HubSpot run makes no Claude call.

**The token** is a HubSpot service key in Doppler (project `portfolio-website`, config `dev`, `RIDGEWAY_HUBSPOT_TOKEN`), sent as `Authorization: Bearer`. The setup script and the runner refuse to start when it is missing or not shaped `pat-<region>-<uuid>`, and they say only that; the key is never printed, logged or written to `results/`. A production build would use a service key in the company's own HubSpot account with the same header: the workflow does not change, only the base URL and the key do.

**Scopes** (exactly these eight; the setup script and the live mode need nothing else, and the account-info call works with them):

| Scope | Used by |
| --- | --- |
| `crm.objects.contacts.read` | contact search, the read by email after a refused create |
| `crm.objects.contacts.write` | contact create and update, the deal-to-contact association |
| `crm.objects.deals.read` | the deal read by `ridgeway_event_id`, reading the deal pipelines |
| `crm.objects.deals.write` | deal create, stage updates (Needs approval, Approved, On hold), the association |
| `crm.schemas.contacts.read` | setup: reading the contact property group and properties |
| `crm.schemas.contacts.write` | setup: creating the contact property group and properties |
| `crm.schemas.deals.read` | setup: reading the deal property group, properties and pipelines |
| `crm.schemas.deals.write` | setup: creating the deal property group, `ridgeway_event_id`, the pipeline and its stages |

**Commands** (from anywhere; the script changes to the repository root for Doppler):

```sh
pest-lead-agent/scripts/live-hubspot.sh setup --dry-run     # reads the portal, prints what it would create, writes nothing
pest-lead-agent/scripts/live-hubspot.sh setup               # creates what is missing, writes results/live-hubspot/portal.json
pest-lead-agent/scripts/live-hubspot.sh smoke evt-d1013-001,evt-d1013-010,evt-d1013-034   # 3 leads (010 needs approval)
pest-lead-agent/scripts/live-hubspot.sh day                 # the 40-lead day, paced (a few minutes)
pest-lead-agent/scripts/live-hubspot.sh --slack smoke <ids> # with Slack real too; add --serve for the Approve / Hold buttons
```

`scripts/hubspot-setup.mjs` refuses any account whose account-info `accountType` is not `DEVELOPER_TEST`. It reads first and creates only what is missing: the property group `ridgeway_lead_agent` on contacts and deals, the five contact properties and `ridgeway_event_id` from `fixtures/hubspot/properties.json`, and the deal pipeline "Ridgeway Sales" with the nine stages of `fixtures/hubspot/pipeline.json`, or the stages an existing "Ridgeway Sales" lacks. It never deletes, renames or changes anything; a property that exists with another type, or a `ridgeway_event_id` that is not unique, stops it before any write. A second run creates nothing. It writes the non-secret ids to `results/live-hubspot/portal.json`: portal id, account type, data hosting location, the record-link base, the pipeline id and the stage ids. `simulate-day.mjs --live-hubspot` refuses to start without that file, then puts the ids into the mocked rules sheet (Settings tab), which both workflows read.

**What a real portal does differently, and what the workflow does about it** (each checked in HubSpot's public docs, read logged out; the mock now behaves the same way, so the replay suite runs these paths):

| Real HubSpot | Docs | What the demo does |
| --- | --- | --- |
| A custom pipeline's ids are generated: the create body takes a label, an order and per stage a label, an order and `metadata.probability` (required for deals); the guide offers no way to choose ids (the reference schema lists bare `pipelineId` and `stageId` fields with no description; not used). Additional pipelines need a paid tier or the test account's trial | [pipelines guide](https://developers.hubspot.com/docs/api-reference/legacy/crm/pipelines/guide), [create pipeline](https://developers.hubspot.com/docs/api-reference/legacy/crm/pipelines/create-pipeline) | pipeline and stage ids are rows of the rules sheet; setup reads the generated ids back; the mock generates numeric ids for a fresh portal and refuses an unknown stage |
| `hasUniqueValue: true` makes a property unique (up to ten per object), and a record can be read by it: `GET /crm/v3/objects/deals/<value>?idProperty=<name>` | [properties guide](https://developers.hubspot.com/docs/api-reference/legacy/crm/properties/guide), [get deal](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/get-deal) | `ridgeway_event_id` is unique; the deal is read by it before the create, never searched. 404 means none |
| Search is eventually consistent: "It may take a few moments for newly created or updated CRM objects to appear in search results" (no delay is stated); five search requests per second per account; phone numbers are matched on area code and local number, so do not send the country code | [search](https://developers.hubspot.com/docs/api-reference/legacy/crm/search-the-crm) | deals do not use search at all; the contact search sends the email, the phone as typed and its 10 digits |
| A second create with the same unique value is refused, and a contact create with an email that exists is refused. The error bodies for both are **not in the public docs** (only the general error format is) | [error handling](https://developers.hubspot.com/docs/api-reference/error-handling), [contacts guide](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide) (read by `?idProperty=email`) | the workflow does not parse the body: a refused deal create reads the deal by `ridgeway_event_id` and reuses it (`hubspot_deal_create_conflict`); a refused contact create reads the contact by email and updates it (`hubspot_contact_create_conflict`); not found either way fails the run with both answers. The mock answers 409 with the body commonly seen from HubSpot ("Contact already exists. Existing ID: ...") |
| `Idempotency-Key` is not a HubSpot feature | (not mentioned anywhere in the docs) | the workflow keeps sending it (house rule); see the table below for what actually protects each write |
| The default association is `PUT /crm/v4/objects/{fromObjectType}/{fromObjectId}/associations/default/{toObjectType}/{toObjectId}`, no body, answering a batch response; 100 association requests per 10 s on Free and Starter | [associate records](https://developers.hubspot.com/docs/api-reference/legacy/crm/associations/associate-records/guide) | the workflow's path already matched; the mock now answers the documented response shape |
| Privately distributed apps: 100 requests per 10 s (Free, Starter) or 190 (Professional, Enterprise), 250,000 a day; a 429 carries `errorType: RATE_LIMIT` and a `policyName`; `Retry-After` is documented only for 477 | [usage guidelines](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines) | see "Rate limits" below |
| Record pages are `https://<app host>/contacts/<portal id>/record/<object type id>/<record id>` (0-1 contacts, 0-3 deals); account-info gives `portalId`, `accountType`, `uiDomain`, `dataHostingLocation` | [using object APIs](https://developers.hubspot.com/docs/api-reference/latest/crm/using-object-apis) (the `url` field), [object type ids](https://developers.hubspot.com/docs/api-reference/legacy/crm/understanding-the-crm), [account info](https://developers.hubspot.com/docs/api-reference/legacy/account/account-information/guide) | the link base is a sheet row: the mock keeps `https://app.hubspot.example/contacts/0000000/record`; setup builds it from the portal id and the data hosting location (`na1`: `app.hubspot.com`, otherwise `app-<location>.hubspot.com`, so this portal's links are `https://app-na2.hubspot.com/contacts/247657707/record/0-3/<deal id>`) |
| Developer test accounts are free accounts with a 90-day trial of many Enterprise features | [account types](https://developers.hubspot.com/docs/getting-started/account-types) | setup refuses anything else; if the trial lapses, creating a second pipeline is expected to fail (not handled, and not exercised: the trial had not lapsed during phase 2) |

**Which HubSpot writes are protected by what.** HubSpot ignores `Idempotency-Key`, so the key protects nothing there:

| Write | Retry inside one run (n8n's 3 retries after a timeout or 5xx) | Redelivery of the event, or a re-run of the day |
| --- | --- | --- |
| Deal create | the unique `ridgeway_event_id`: the retry is refused and the deal is read back (`deal_create_conflict_after_timeout`) | the read by `ridgeway_event_id` before the create finds it; nothing is created |
| Contact create, lead with an email | the email is unique in HubSpot: the retry is refused and the contact is read by email (`existing_email_contact_create`) | the search by email finds it; if the search lags, the same email conflict |
| Contact create, **phone-only lead** | **not protected**: a create that committed but timed out is created again on the retry; two contacts with the same phone | the search by phone; a lagging search could also create a second one |
| Contact and deal updates, stage moves, the association | not needed: repeating them writes the same values (a PATCH to the same stage, a PUT of the same association) | a reused deal that already moved on (Needs approval, Approved, On hold) keeps its stage, so a re-run never undoes a manager's decision |
| Approve / Hold stage move | the event ledger's decision claim (first decision wins) | the same; if a decision run fails after the stage write and the approver then clicks the other button, HubSpot takes the second decision (the strict mock refuses it) |

**Re-running the day against the same portal must not create duplicates** (phase 2 confirmed it): deals are found by `ridgeway_event_id`, contacts by the search (email, then phone), and an email the search misses conflicts and is read by email. The runner prints "N deals created, M reused" after each live run; on a second run every deal is "reused" (phase 2: the full day printed "33 deals created, 2 reused", then "0 deals created, 35 reused"; HubSpot held 35 deals with 35 distinct `ridgeway_event_id` values). What a re-run does repeat: it posts the Slack summaries again (mocked unless `--slack`), and the CSR tasks and drafts go to a fresh mock. Nothing here deletes, archives or resets anything in HubSpot.

**Rate limits.** The conservative reading for a test account is the Free tier, 100 requests per 10 s for the app (whether a service key counts as a "privately distributed app" is my reading; the docs do not say). A lead makes 5 to 7 HubSpot calls (1 search), so live HubSpot waits 1.5 s after each answer before the next lead (the larger of this and Slack's 1.2 s when both are live): about 45 calls per 10 s and well under 5 searches per second. A 429 is retried by n8n's normal retries (fixed 5 s, three times: 15 s, longer than HubSpot's 10 s window; n8n does not read headers). Two costs of n8n's retries: they retry a 409 like any error, so a conflict costs 15 s before the lookup runs; and they would retry a 404 too, so the three reads by unique value use n8n's "never error" and "full response" options. Those three reads therefore get no n8n retry for a 429 or 5xx (network errors and timeouts are still retried): such an answer fails the run into the error workflow, which hands the claim back for the sender's redelivery.

**Fictional data in a real CRM.** Contacts keep their 555-01xx phones, but HubSpot rejects the fictional `.example` emails: every create failed with `400 INVALID_EMAIL` in the first phase-2 smoke run (BUILD-LOG.md, entry 50). So live-HubSpot mode stores `<local>+<domain>@example.com` by default (`jo.rivera@mail.example` becomes `jo.rivera+mail@example.com`; example.com is reserved by RFC 2606 and can never reach a person; no other domain is ever used). It is a sheet row (`hubspot_email_fallback`) that the runner sets to `example_com` with `--live-hubspot`; `--no-hubspot-email-fallback` turns it off, `--hubspot-email-fallback` is still accepted and changes nothing, and both are refused without `--live-hubspot` (the mock keeps `.example`). The HubSpot search and the read by email use the same mapped address. The runner's personal-data check also forbids the mapped form in Slack, ClickUp and Sheets bodies.

**Observed in phase 2 (2026-10-11).** `live-hubspot.sh setup --dry-run` planned 2 property groups, 6 properties and the pipeline "Ridgeway Sales"; `setup` created them (pipeline 2615660268, nine stages with HubSpot-generated ids 4421631687 to 4421631695) and a second dry run said "nothing to create: the portal is already set up". The 3-lead smoke with the fallback answered `auto_proposed`, `approval_required`, `out_of_area` ("2 deals created, 0 reused"); the same command again said "0 deals created, 2 reused". Read back through the API, the deals sat in New lead ($200) and Needs approval ($1,255), each associated with its contact. With `--slack ... --serve`, the lead was posted to #leads with Approve / Hold, a person clicked Approve in the Slack web client, the relay forwarded it and the real deal moved to Approved, which the API and the HubSpot record page both showed. The full day created 33 deals and reused 2 (the smoke ones); a second run created none and reused 35. Slack was mocked in the day runs. The approved deal kept its stage through both day runs. Not exercised live: the create-conflict paths (0 conflicts in every run), an unknown `dealstage`, the rate-limit tier (no 429 at 1.5 s pacing) and a lapsed trial.

**Tested offline:** the `live_hubspot_parity` check in `tests/verify.mjs` runs the real setup script against a fresh mock portal (dry run, then for real, then again), puts the generated ids into the sheet with the email fallback on and `.example` emails refused, books and approves the termite lead, then re-runs it against the same portal with the contact missing from the search index: one contact, one deal, the Approved stage kept. A separate rehearsal of the exact phase-2 sequence (setup `--dry-run`, setup, the 3-lead smoke, the same smoke again) ran against a standalone mock standing in for `api.hubapi.com`: 2 deals created, then 0 created and 2 reused (VALIDATION.md).

## Three ways to answer the Claude step

The workflow's "Qualify lead with Claude" node always calls `{ANTHROPIC_BASE_URL}/v1/messages` with a Messages API request that asks for a JSON-schema output. Only the base URL changes:

| Mode | `ANTHROPIC_BASE_URL` | Used by |
| --- | --- | --- |
| Replay | the vendor mock, which answers from `fixtures/llm/<event_id>.json` keyed by `metadata.user_id` | `verify.mjs` (default), CI-style runs |
| Live bridge | the local Claude bridge, which answers by running `claude -p` on a dedicated sign-in folder | `record-llm.mjs`, `verify.mjs --live-llm` |
| Production | `https://api.anthropic.com` with a real API key | not part of this demo |

The bridge is for local personal testing on a Claude subscription only. Anything that runs on its own for a business should use the official API with a workspace API key; going there changes the base URL and the key, and the workflow does not change. The request is built in one module, [`workflow/anthropic.js`](workflow/anthropic.js), shared by the workflow, the recorder and the tests. Only the inquiry text, the source and the ZIP are sent to the model: no name, phone or email field. (If the customer typed a phone number or an email into the message itself, that text goes along. A model can echo it, which is why everything the model writes is redacted, see below.)

## Architecture

```
 signed POST /webhook/ridgeway/lead   (x-ridgeway-signature = HMAC over "<x-ridgeway-timestamp>.<raw body>")
        |
  [1 Intake]  Verify signature + 300 s replay window --401--> exit     Normalize (3 sources) --400--> exit
        |     Claim event_id in the event ledger --in_flight--> 409 + Retry-After     --done--> 200 duplicate
        v
  [2 AI]  Fetch ops settings (Sheet) -> Qualify lead with Claude (JSON schema)
        |   -> Apply AI guardrails (allowlists, phone/email redaction, confidence >= sheet threshold)
        |
  [3 Routing]  Fetch service area rules (Sheet) -> Check service area -> Route lead by path
        |
        +-- qualified ------> [4] Find FieldRoutes customer --existing--> [5] ClickUp task + Slack  (service_request)
        |                          |new
        +-- needs_review ----------+--> [6] HubSpot contact search -> update/create (original message stored here;
        |                                     a create refused because the email exists reads it by email, updates it)
        +-- out_of_area ---------------> [6] ...
                                              |
                  out_of_area:   [7] Slack note                                     (out_of_area)
                  needs_review:  [7] ClickUp review task + Slack                    (needs_review)
                  qualified:     [8] Fetch pricing (Sheet) -> read HubSpot deal by ridgeway_event_id (GET ?idProperty=,
                                     a unique-value property; 404 = none) -> reuse it, or create deal "New lead"
                                     (a create that conflicts reads the deal again and reuses it) -> associate
                                     FieldRoutes spot search (window by urgency, branch time zone)
                                       failure -> ClickUp callback task + Slack warning, slots []
                                     approval gate -> deal "Needs approval" when required
                                 [9] Gmail draft (never sent; a failed draft is reported as failed), SMS proposal only with consent
                                     ClickUp CSR task, Slack #leads summary (Approve/Hold buttons if gated)
        all paths --> [10] Compose result, Sheets speed-to-lead row, mark event done in the ledger (with the deal, task
                           and Slack message ids for Approve / Hold), respond 200 {status, ...}

 any required step fails after 3 retries --> "Pest Lead Agent · Alert on errors":
     give the claim back to the ledger (marked failed) -> Slack #automation-alerts (with the event id) + Sheets error row

 click on Approve / Hold in #leads --> Slack Socket Mode --> slack-relay (ack, ids only, signed)
     --> POST /webhook/ridgeway/slack-action  "Pest Lead Agent · Handle approval":
     verify signature --401   validate ids --400   approver? --no--> ephemeral notice, 403
     claim the decision in the ledger --decided / in flight--> 200 already_decided   --unknown--> 409
     Settings (Sheet: stage ids) -> HubSpot deal stage (Approved / On hold) -> ClickUp CSR task comment -> chat.update (buttons replaced) -> decision done
```

Three workflows, generated by [`workflow/build-workflow.mjs`](workflow/build-workflow.mjs) into [`book-new-lead.json`](workflow/book-new-lead.json) (80 nodes plus 11 sticky notes), [`alert-on-errors.json`](workflow/alert-on-errors.json) (6 nodes plus 2 sticky notes) and [`handle-approval.json`](workflow/handle-approval.json) (28 nodes plus 5 sticky notes, see [the click, end to end](#live-slack-and-the-approve--hold-buttons)). Business logic is in small plain-JS modules in `workflow/` that are unit tested and injected into the Code nodes; the Code nodes are thin glue (and the one with real branching, the Gmail outcome, is run in a unit test with fake n8n globals). Warnings a 200 can carry include `gmail_draft_failed`, `slack_post_failed`, `fieldroutes_availability_unavailable`, `hubspot_contact_create_conflict` and `hubspot_deal_create_conflict` (a refused HubSpot create resolved by a lookup). Statuses returned: `approval_required`, `auto_proposed`, `service_request`, `out_of_area`, `needs_review`, `duplicate` (200), `invalid` (400), `unauthorized` (401), `in_flight` (409 with a `Retry-After` header). The approval webhook answers `approved`, `on_hold`, `already_decided` (200), `invalid` (400), `unauthorized` (401), `not_approver` (403) and `not_awaiting_approval` (409).

### Design decisions worth knowing

- **Never trust the model.** The structured output is parsed again and every field is checked against allowlists. Invalid output, a refusal, a truncated reply, a failed call, or confidence under the sheet's threshold (0.6 today) becomes `needs_review`: contact upsert, a ClickUp review task and a Slack note, no deal and no slot. A model can also echo contact details it was shown, so email addresses and phone numbers are removed from `summary`, `red_flags` and any invalid-output reason before they reach Slack, ClickUp, Sheets or the response. Phone formats covered: 7-digit local (`555-0142`), 10-digit US with dashes, dots, spaces, parentheses or none (`(904) 555-0142`, `904.555.0142`, `9045550142`), with a leading `1` or `+1` (`1-904-555-0142`, `+1 904 555 0142`), and E.164 or other international numbers (`+19045550142`, `+44 20 7946 0958`). The fixture `pii_in_model_output` proves it with a hand-written model reply that echoes both (synthetic, labelled as such). Redaction is a safety net, not a parser: an unusual format can slip through, and the hard rule stays that n8n sends ids, not content.
- **Retries and idempotency.** Every network call is retried 3 times, 5 seconds apart (n8n `retryOnFail`, `maxTries: 4`). n8n's retry re-sends the request, and the sender may redeliver the whole event, so every call that changes state sends `Idempotency-Key: <event id>:<node name>` (the same on every retry and every redelivery) and `X-Run-Id: <execution id>` for traceability. The receiving service answers a repeat with the original result. The mock implements that contract, refuses a reused key with a different body (like Stripe), and the scenario `clickup_timeout_after_commit` proves it: the task is committed, the answer arrives after the node timeout, the retry carries the same key, and exactly one task exists. The runner checks every reuse of a key: identical bytes, and either an injected fault as the cause (a retry) or a redelivery in the scenarios about redelivery. Real vendors differ (see limits).
- **One claim per event, in a service.** The first thing a valid request does is claim its `event_id` in the **event ledger**, a small service n8n calls (a mock here; a database or Redis in production). Answers: `claimed` (go ahead), `in_flight` (another run holds the event: the webhook answers **409** with `Retry-After: 30` and `{status: "in_flight"}`), `done` (answers 200 `duplicate`). It is not workflow static data on purpose: n8n saves static data only when an execution ends, so a claim written at the start of a run is invisible to a redelivery that arrives mid-run (BUILD-LOG, entry 21). A run that fails hands its claim back through the error workflow (the ledger marks it `failed` with a timestamp), so the sender's redelivery is processed again; the steps the first run completed are replayed by key, and the HubSpot deal, whose API does not honor the key, is read again by its unique `ridgeway_event_id` property and reused (a deal that already moved on, to Needs approval, Approved or On hold, keeps its stage). A run that dies without reporting (n8n crash) goes stale after 10 minutes and can then be reclaimed.
- **Rules live in a service, not in n8n.** Service area, pricing, approval thresholds, the confidence threshold, the urgency windows (days to look ahead per urgency) and "commercial properties require approval" are read from a mocked Google Sheet, "Ridgeway ops rules", with `values.get`. A malformed sheet fails the run into the error workflow instead of routing on bad rules. (The 0.6 mentioned in the Claude prompt is guidance to the model, not the gate; changing the prompt would invalidate the recordings.)
- **n8n passes ids, not content.** Slack, ClickUp and Sheets receive HubSpot contact and deal ids, links, the first name and the ZIP; never the full phone, email or address. The customer's original message and service address are stored on the HubSpot contact. The test runner checks every Slack, ClickUp and Sheets body of every scenario against strings written out per fixture in `fixtures/scenarios.json` (the lead's email, phone as E.164, 10 digits, dashed, parenthesized and as typed, last name and street address), not derived from the code under test.
- **Execution history keeps no lead data for successful runs (almost).** The main workflow sets `saveDataSuccessExecution: none` (and `saveDataErrorExecution: all`): n8n's execution history is a second copy of the lead (names, phones, emails sit in node data). What actually happens in n8n 2.42.6, observed in its database: it still writes the first row of every execution (that row holds the webhook payload, so the lead), soft-deletes it when the run succeeds (invisible in the UI and API), and keeps the payload until the pruner hard-deletes the row, once it is older than `EXECUTIONS_DATA_HARD_DELETE_BUFFER` hours (default 1) at the next pass (every `EXECUTIONS_DATA_PRUNE_HARD_DELETE_INTERVAL` minutes, default 15). `env.sh` sets the buffer to 0, so a successful run's lead data is gone within about 15 minutes. Failed runs stay saved with the lead so they can be debugged: prune them with `EXECUTIONS_DATA_MAX_AGE` and restrict access to the n8n UI. The runner reads n8n's SQLite file after a full run and asserts that every visible row of the main workflow is a failed run with its data, and that the pruner hard-deleted soft-deleted rows during the run (BUILD-LOG, entry 28). If even those minutes matter, the real fix is to keep the lead out of n8n's data: send the webhook body to the ledger or CRM and pass only ids (the house rule).
- **Replay protection.** The sender sends `x-ridgeway-timestamp` (Unix seconds) and signs `<timestamp>.<raw body>`. A request older than 300 s or more than 60 s in the future is refused with 401 and no vendor call; so is a missing timestamp or a missing raw body (an empty buffer is never hashed). The hash is over the exact bytes received, never a re-serialization: the scenario `pretty_printed_unicode_body` posts a pretty-printed body with `Peña` and `Café` and then the same bytes signed over the compact form, which is refused. The 60 s allowance covers sender clock skew. Inside the 300 s window a captured request can still be replayed; the event ledger answers that with `duplicate`.
- **Nothing is sent to customers.** Email is a Gmail draft; the mock fails the test if a send endpoint is ever called. SMS is proposed in the CSR task only when the lead's `sms_consent` normalizes to true: boolean `true`, or the form strings `true`, `yes`, `checked` or `on` (any case); anything else records the reason. If Gmail refuses the draft after its retries, the booking still completes, the response carries a `gmail_draft_failed` warning and the CSR task says "Email draft: FAILED, no draft was created".
- **Required vs non-critical steps.** HubSpot, ClickUp, the rules sheet, the settings and the event ledger claim are required (failure stops the run and triggers the error workflow). Claude, FieldRoutes, Gmail, Slack, the Sheets log and the ledger's done mark use `onError: continueErrorOutput` so a failure is recorded and the booking still completes.
- **Deterministic time.** The runner sends `x-ridgeway-test-now`, honored only when `RIDGEWAY_TEST_MODE=true`, so slot windows and the replay window are reproducible. Windows are computed in the branch time zone (Jacksonville and Savannah: America/New_York, Mobile: America/Chicago); `emergency_commercial` asserts the first slot (10:00 local in Mobile) so the Chicago window is proven end to end.
- **Production should answer 202 right after the claim.** This demo answers synchronously: the webhook responds only when the whole run is finished, with the real outcome (`approval_required`, `auto_proposed`, ...). That makes the tests simple, because one HTTP response carries everything to assert, and it makes the 409 and the redelivery timing easy to observe. In production a sender with a short timeout would give up and redeliver while the run is still going. A production build should claim the event, answer **202 Accepted** straight away, and process asynchronously (a queue, or a second workflow started by the first), reporting the outcome through the ledger, a callback or Slack. The claim, the 409 and the keyed writes here are what make that safe.

### Configuration (environment)

| Variable | Purpose |
| --- | --- |
| `LEAD_WEBHOOK_SECRET` | HMAC secret for the webhook |
| `EVENT_LEDGER_BASE_URL`, `EVENT_LEDGER_TOKEN` | the event ledger (one claim per event id) |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` | Claude step (mock, bridge, or the official API) |
| `HUBSPOT_BASE_URL`, `HUBSPOT_TOKEN` | CRM (the mock, or `https://api.hubapi.com` and the service key in live HubSpot mode) |
| `CLICKUP_BASE_URL`, `CLICKUP_TOKEN`, `CLICKUP_LIST_ID` | CSR tasks |
| `SLACK_BASE_URL`, `SLACK_BOT_TOKEN` | alerts, the leads summary, Approve / Hold updates |
| `SLACK_LEADS_CHANNEL`, `SLACK_ALERTS_CHANNEL` | channel names for the mock (default `#leads`, `#automation-alerts`), channel ids for a real workspace |
| `SLACK_APPROVER_IDS` | Slack user ids allowed to Approve / Hold (comma list; empty means nobody) |
| `SLACK_RELAY_SECRET` | HMAC secret between the Socket Mode relay and the approval webhook |
| `GMAIL_BASE_URL`, `GMAIL_TOKEN` | drafts |
| `SHEETS_BASE_URL`, `SHEETS_TOKEN`, `SHEETS_SPREADSHEET_ID`, `OPS_RULES_SHEET_ID` | speed-to-lead log and the rules sheet |
| `FIELDROUTES_BASE_URL`, `FIELDROUTES_AUTH_KEY`, `FIELDROUTES_AUTH_TOKEN` | scheduling |
| `RIDGEWAY_TEST_MODE` | test-only fixed clock |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, `NODE_FUNCTION_ALLOW_BUILTIN=crypto` | n8n blocks both by default; the signature check and the env reads need them. **See the warning below.** |

No `.env` files. The runner generates random test secrets for each run; [`env.sh`](env.sh) holds placeholders for the local editor only (and leaves `SLACK_APPROVER_IDS` empty). The live Slack tokens, the relay secret and the HubSpot service key (`RIDGEWAY_HUBSPOT_TOKEN`) are Doppler secrets. No secret is written into the workflow JSON.

### Environment exposure

> **Warning.** `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` lets **any workflow, and any Code node, read every variable in n8n's environment**: every token above, and whatever else n8n inherited from the shell that started it. This demo needs it only because it reads its config with `$env`. Therefore n8n is started with an **allowlisted environment**: `start.sh` runs `env -i` plus `PATH`, `HOME`, `TMPDIR`, `LANG`, the `N8N_*` settings, the vendor base URLs and the demo tokens and secrets; the test runner builds the same list in `tests/n8n-env.mjs` and never copies its own environment. `verify.mjs` proves it from inside n8n (a throwaway probe workflow asks which of the runner's ~110 variables a Code node can read: none outside the allowlist, and a canary variable is not among them), and a unit test runs `start.sh` against a stub `n8n` and checks what it receives. **A production deployment should keep `N8N_BLOCK_ENV_ACCESS_IN_NODE` at its default (`true`) and use n8n credentials** (Header Auth, HubSpot, Slack, Google and so on) instead of `$env` reads, so a workflow can only use a secret it is explicitly given.

## Scope and limits

- **Fictional company, mocked vendors, no production use.** The mock shapes approximate HubSpot CRM v3/v4, ClickUp v2, the Slack Web API, Gmail v1 and Sheets v4. **The FieldRoutes (PestRoutes) shapes are the weakest approximation**: endpoint paths, query parameters (`phone`, `officeIDs`, `dateStart`, `dateEnd`, `includeData`), the `customers` and `spots` response fields and the `status: "1"` meaning of an active customer are my reading of the public docs, not verified against a live FieldRoutes account. Expect to adjust them. HubSpot properties such as `ridgeway_lead_status`, `ridgeway_tags` and `ridgeway_last_inquiry` are custom properties: `scripts/hubspot-setup.mjs` creates them in a real portal, and the mock's pipeline and stage ids are invented (a real portal generates its own; they are sheet rows).
- **Idempotency keys are a contract the mock honors.** Real services differ: Slack (`chat.postMessage`, `chat.update`, `chat.postEphemeral`), HubSpot CRM writes, ClickUp comments and Gmail drafts do not honor an `Idempotency-Key` header. Against them a retry could duplicate a post or a deal, so a real build needs dedupe on the service side (search-before-create for contacts, a read by the unique `ridgeway_event_id` for deals, see [Live HubSpot](#live-hubspot), or a middleware). The scenario `redelivery_after_failure` tells the mock to ignore the key on deal creation, like HubSpot, so only the lookup prevents a second deal. A key whose body differs from its first use (for example because a live model wrote a different summary on the redelivery) is refused by a strict service like the mock; a production build would keep the first qualification in the ledger and reuse it.
- **The event ledger is a mock.** One mock process holds the claims in memory, so there is no real concurrency control, durability or multi-node safety; production uses a database or Redis with an atomic claim (`SET NX`, a unique index). The ledger's calls are idempotent on `(event_id, run_id)` and are the only state-changing calls that do not send an `Idempotency-Key`, because the ledger is the dedupe authority itself. If the error workflow cannot reach the ledger, the claim stays `in_flight` for 10 minutes, during which redeliveries get 409.
- **Retry timing is fixed, not exponential.** n8n's built-in retry waits a fixed 5 seconds. The original brief said "backoff"; the house rule (3 retries 5 seconds apart) applies.
- **Two fixtures are hand-written.** `malformed_llm` (an out-of-allowlist pest type) and `pii_in_model_output` (a reply that echoes a phone number and an email). Both are in `fixtures/llm/`, carry `"synthetic": true` and a `synthetic_reason`, and are skipped in `--live-llm`. The two redelivery checks are skipped in live mode too: they need the mock to delay the Claude answer, and two live answers would differ.
- **Recordings are real Claude output, but not raw API responses.** They come from `claude -p` through the bridge, wrapped into a Messages API shape: no real message id, token usage that includes the CLI's own overhead, and `stop_reason` synthesized as `end_turn`. They carry `via: "claude-code-cli-bridge"`, `recorded_at`, and the exact request (`recorded_request`), which the mock compares with the request the workflow sends, so a changed prompt fails loudly until re-recorded. The CLI path ignores `max_tokens`, `effort` and `metadata.user_id` (the last is used only for matching). Output varies between runs; the live run shows the differences ([VALIDATION.md](VALIDATION.md)).
- **Not built:** any SMS gateway, real OAuth flows, a hosted relay (the Socket Mode relay runs on the same machine as n8n), and a production deployment. The existing-customer path stores nothing in HubSpot, so the original message is not kept anywhere for those leads (the CSR task carries the model's one-line summary).
- **Pricing is illustrative**, not Ridgeway's, and not researched: every price carries `"basis": "illustrative — pending sourced research"` (the sourced research was blocked). The deal values, the approval threshold and the KPI table inherit that.
- **A termite letter is found by keywords.** The schema's pest types are fixed (changing them would invalidate every recording), so a WDO request is recognised by words in the customer's own message (the sheet's `wdo_keywords`), not by the model. A request worded differently ("pest certificate for the buyer's lender") is priced as whatever pest the model named, and a termite one then waits for approval at $1,200.

## Files

| Path | What it is |
| --- | --- |
| `workflow/*.js` | pure logic modules: time zones, signature, normalize, Claude request, guardrails, rules sheet parsing, routing, slots, messages, vendor requests, idempotency, context helpers |
| `workflow/modules.mjs` | loads the modules for tests and injects them into Code nodes |
| `workflow/approval.js` | Approve / Hold logic: the relay payload's shape, the approver list, the ledger's decision answer, the updated message and the CSR comment |
| `workflow/build-workflow.mjs` | generates the three workflow JSON files (`--check` fails if stale) |
| `workflow/book-new-lead.json`, `alert-on-errors.json`, `handle-approval.json` | the generated workflows |
| `slack-relay/relay.mjs`, `slack-relay/README.md` | the zero-dependency Socket Mode relay for the buttons |
| `mock/server.mjs` | zero-dependency vendor mock with fault injection, idempotency, HubSpot's schema behaviours (unique values, refused unknown properties and stages, generated pipeline and stage ids, reads by `idProperty`, 409 conflicts, search lag on request), the event ledger (lead claims and approval decisions), request log (`/__log`, `/__state`, `/__control`, `/__reset`) and a state snapshot for the live stack |
| `fixtures/scenarios.json` | the 21 scenarios and five checks (one of them the Approve / Hold check), with expectations (calls, state, forbidden strings) and the test-clock instant of each |
| `fixtures/day/leads.json` | the 40 deliveries of the simulated day |
| `fixtures/ops-rules.json` | contents of the mocked "Ridgeway ops rules" sheet: service area, pricing, settings, price list |
| `fixtures/fieldroutes/*.json` | the 25 FieldRoutes customers and the schedule (technicians, route days, windows, booked visits) |
| `fixtures/hubspot/*.json`, `fixtures/clickup/csr-queue.json` | the seeded HubSpot contacts, deals and pipeline, and the "CSR Queue" list with its custom fields and open tasks |
| `fixtures/llm/<event_id>.json` | recorded Claude answers (two synthetic files labelled as such) |
| `scripts/record-llm.mjs` | records Claude answers through the shared bridge (`--dry-run` costs nothing) |
| `scripts/simulate-day.mjs` | runs the simulated day through the real workflow and writes `results/day/`; `--only`, `--limit`, `--live-slack`, `--serve`, `--resume` |
| `scripts/live-slack.sh` | the live-Slack stack through Doppler, with the demo workspace's ids |
| `scripts/hubspot-setup.mjs` | prepares the HubSpot developer test account (property group, properties, pipeline and stages; idempotent, `--dry-run`) and writes `results/live-hubspot/portal.json` |
| `scripts/live-hubspot.sh` | the live-HubSpot mode through Doppler: `setup [--dry-run]`, `smoke <ids>`, `day`, optionally `--slack` |
| `fixtures/hubspot/properties.json` | the custom HubSpot properties and their group, shared by the setup script and the mock |
| `tests/unit.test.mjs`, `tests/relay.test.mjs`, `tests/index.js` | unit tests (`index.js` lets `node --test <dir>` work on Node 24) |
| `tests/code-node.mjs`, `tests/key-reuse.mjs`, `tests/n8n-env.mjs` | test helpers: run a Code node with fake n8n globals, the Idempotency-Key assertions, the n8n environment allowlist |
| `tests/harness.mjs` | the real-n8n harness (mock, temporary n8n folder, signed requests) shared by `verify.mjs` and `simulate-day.mjs` |
| `tests/verify.mjs` | end-to-end runner against a real n8n server |
| `tests/validate-n8n-mcp.mjs` | n8n-mcp `validate_workflow` for the three workflows |
| `env.sh`, `start.sh`, `import.sh`, `export.sh` | local editor setup (`~/.n8n-pest-lead-agent`); `start.sh` uses an allowlisted environment |
| `results/` | evidence from the last runs (`results/runs/` keeps a timestamped summary of every complete run; `results/live-slack/` the last live Slack run; `results/live-hubspot/` holds `portal.json` and the last live HubSpot run) |
| `VALIDATION.md`, `BUILD-LOG.md` | observed outcomes and an honest build log |
| `../_shared/claude-bridge/` | the shared Claude bridge (owned separately) |
