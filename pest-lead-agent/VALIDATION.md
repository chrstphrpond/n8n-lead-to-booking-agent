# Validation

**Result (2026-10-11, after the live-HubSpot phase 2 run):** passed. Phase 2 ran the live-HubSpot mode against the author's HubSpot developer test account 247657707 (data hosted in `na2`), with a service key that has the 8 scopes, and once with the Slack demo workspace real as well. **Still mocked:** FieldRoutes, ClickUp, Gmail, Google Sheets and the event ledger. **Claude answers were replayed**: phase 2 made no Claude call. Details in [Live HubSpot](#live-hubspot). The rest of this paragraph is from the live-Slack pass before it: Fictional demo, mocked vendor APIs, real n8n server. Slack was real for one smoke run, in the author's own throwaway workspace "Ridgeway Pest Control (demo)"; nothing was sent to a real customer or business account. This pass made **no Claude call**: the tests, the day simulation and the live Slack smoke all replay the recorded answers. (The realistic-demo-data pass before it made the 52 real calls that recorded the leads; see BUILD-LOG.md.)

| Check | Command | Outcome |
| --- | --- | --- |
| Unit tests | `node --test pest-lead-agent/tests/` | 117 passed, 0 skipped (108 in `unit.test.mjs`, 9 for the Socket Mode relay in `relay.test.mjs`) |
| End to end, replay mode | `node pest-lead-agent/tests/verify.mjs` | 36 passed, 0 skipped: 21 scenarios, the 6 earlier checks, 7 Approve / Hold checks, the live-HubSpot parity check and the execution-history check, from a clean state (fresh temp n8n folder, fresh ports, fresh mock). Every complete run's summary is kept in [`results/runs/`](results/runs/) (timestamped in UTC) |
| End to end, live Claude | `node pest-lead-agent/tests/verify.mjs --live-llm` | 15 passed, 1 skipped (`malformed_llm`, which needs a hand-written reply) of 16. **Not re-run in this pass** (and not to be run for this task): it is the run of the previous version of the workflow and of the previous, placeholder fixtures (before the ledger, the signed timestamp, the deal search, the realistic leads and the other fixes), kept as historical evidence in `results/live-llm-*`, where the old fixture names still appear. Re-run it before relying on it. |
| Day simulation | `node pest-lead-agent/scripts/simulate-day.mjs` | completes: 40 deliveries, every one answered 200 with a known status; writes [`results/day/`](results/day/) (see below; re-run in the live-HubSpot pass, after the deal lookup changed: every table identical to the run before apart from the speed figures) |
| Workflow validation | `node pest-lead-agent/tests/validate-n8n-mcp.mjs` | 0 errors, 0 warnings on all three workflows |
| Live HubSpot setup | `scripts/live-hubspot.sh setup --dry-run`, then `setup`, then `setup --dry-run` again | Planned 2 property groups (contacts, deals: `ridgeway_lead_agent`), 6 properties and the pipeline "Ridgeway Sales"; `setup` created them and wrote `results/live-hubspot/portal.json` (pipeline 2615660268, 9 stages with HubSpot-generated ids 4421631687 to 4421631695). The second dry run: "nothing to create: the portal is already set up" |
| Live HubSpot smoke, without the email fallback | `scripts/live-hubspot.sh smoke evt-d1013-001,evt-d1013-010,evt-d1013-034` (run before the fallback became the default) | **Failed, 3 of 3 with HTTP 500** after about 19 s each: HubSpot rejected the `.example` emails with `400 INVALID_EMAIL`; nothing was created in HubSpot. BUILD-LOG.md, entries 50 and 51 |
| Live HubSpot smoke, with the fallback | same command with `--hubspot-email-fallback` | Exit 0: `auto_proposed`, `approval_required`, `out_of_area`; "2 deals created, 0 reused". Read back through the API: `evt-d1013-001` in New lead ($200), `evt-d1013-010` in Needs approval ($1,255), each associated with its contact; 3 contacts, the out-of-area one tagged `out-of-area`; emails `<local>+<domain>@example.com`, phones 555-01xx |
| Live HubSpot smoke, repeated | same command again | "0 deals created, 2 reused"; still 2 deals and 3 contacts |
| Live HubSpot + live Slack, Approve | `scripts/live-hubspot.sh --slack smoke evt-d1013-010 --hubspot-email-fallback --serve` | The deal was reused and the lead posted to #leads (`C0C867WL7AR`, ts `1791690668.843009`) with Approve / Hold. A person clicked Approve in the Slack web client; the relay logged `forwarded approve_lead for evt-d1013-010 by U0C84MF082F (retry 0) -> n8n 200 approved`; the real deal 353551826643 moved to Approved, confirmed through the API and on the HubSpot record page (pipeline Ridgeway Sales, stage Approved, amount $1,255, one associated contact) |
| Live HubSpot, full day | `scripts/live-hubspot.sh day --hubspot-email-fallback`, twice | First run: exit 0, "33 deals created, 2 reused". Second run: exit 0, "0 deals created, 35 reused". Afterwards HubSpot held 35 deals in Ridgeway Sales with 35 distinct `ridgeway_event_id` values and 38 contacts with `ridgeway_lead_source`; stages New lead 27, Needs approval 7, Approved 1 (the approved deal kept its stage through both runs). Slack was mocked in the day runs |
| Slack relay, live | `scripts/live-slack.sh --check` | Slack's `hello` arrived over Socket Mode with the app token from Doppler (`connected (hello; 1 connection(s) for this app)`) |
| Live Slack smoke | `scripts/live-slack.sh --smoke evt-d1013-001,evt-d1013-010,evt-d1013-034` | 3 leads, 3 posts to #leads (`C0C867WL7AR`), each answered `ok` with a ts, no warning, no 429: `evt-d1013-001` auto_proposed (ts `1791686763.031069`), `evt-d1013-010` approval_required with Approve / Hold (ts `1791686763.981909`), `evt-d1013-034` out_of_area (ts `1791686765.139409`). [`results/live-slack/deliveries.json`](results/live-slack/deliveries.json). The full 40-lead live day was **not** run |
| Live stack, serve | `scripts/live-slack.sh` (from the saved state) | n8n, the mock and the relay came up, the relay got `hello`, the stack listed `evt-d1013-010` as waiting for a click, and Ctrl-C stopped all of it. **The click itself in Slack has not been made yet**: it is left to a person |

Runtime: n8n 2.42.6 (the global install, the same binary as the editor; the runner asserts the version), Node v24.20.0, pnpm 11.9.0, Claude Code CLI 2.1.296 for the live run. See [`results/runtime-version.txt`](results/runtime-version.txt), [`results/live-llm-runtime-version.txt`](results/live-llm-runtime-version.txt) and the commands in [`results/runtime-commands.txt`](results/runtime-commands.txt). Each scenario has its own fixed clock, `now` in [`fixtures/scenarios.json`](fixtures/scenarios.json), spread over Monday October 12 to Saturday October 17, 2026 in each branch's own time zone (the default, `2026-10-12T14:00:00Z`, applies to nothing now); the signed `x-ridgeway-timestamp` is that instant in Unix seconds, plus an offset in the two timestamp scenarios.

## Observed outcomes (replay mode)

Each row is from [`results/scenario-results.json`](results/scenario-results.json); the full request log of every scenario (endpoint, query, body, status, injected fault, Idempotency-Key, X-Run-Id, body hash) is in [`results/request-logs/`](results/request-logs/). "Claude" is the recorded real answer: pest / urgency / confidence. Every scenario also asserts what exists in the mock afterwards (contacts, deals, tasks, drafts, Slack posts, sheet rows, the ledger entry); the counts are in [`fixtures/scenarios.json`](fixtures/scenarios.json) under `expect.state`.

| Scenario | HTTP | Status | Branch | Claude | Slots (local) | What the request log and the mock's state show |
| --- | --- | --- | --- | --- | --- | --- |
| `termite_fl_new` | 200 | `approval_required` | jacksonville | termites / high / 0.9 | Mon Oct 12 1:00 PM, Mon Oct 12 3:00 PM, Tue Oct 13 3:00 PM | test clock Mon 09:12 EDT; deal created in `ridgeway_new_lead` at $1200 (after a deal search by `ridgeway_event_id` found none), then PATCHed to `ridgeway_needs_approval`; the contact carries the street address, city and state from the form; Slack message has Approve and Hold buttons whose value is the event id only; the CSR task fills the five ClickUp custom fields (Jacksonville `b1`, termites `p4`, high `u2`, the deal link, callback by = arrival + 4 h); the ledger's done mark keeps the deal, task and message ids and the summary without its buttons; one Gmail draft; SMS not proposed (`no_sms_consent`). State beyond the seed: 1 contact, 1 deal, 1 task, 1 draft, 1 Slack post, 1 sheet row, ledger `done` |
| `ants_ga_recurring` | 200 | `auto_proposed` | savannah | ants / normal / 0.9 | Tue Oct 13 1:00 PM, Wed Oct 14 8:00 AM, Thu Oct 15 3:00 PM | a CallRail-style call (test clock Tue 11:23 EDT); the ZIP 31405 is read from the transcript ("Savannah, Georgia, 31405"); three slots on three different days inside the 7-day window (the 7 comes from the Settings tab), no window offered twice, SMS proposed (consent given), deal stays in New lead; the rules sheet is read settings first, then service area, then pricing; the contact search sends the email, `+19125550163` and `9125550163`; the deal is read with `GET /crm/v3/objects/deals/evt-ants-ga-002?idProperty=ridgeway_event_id` (404, so it is created), no deal search |
| `existing_customer_al` | 200 | `service_request` | mobile | roaches / normal / 0.85 | none | FieldRoutes customer #53002 (an active quarterly customer in office 3) matched by phone; one ClickUp task tagged `service-request`, one Slack note; zero HubSpot calls, no deal. State beyond the seed: 0 contacts, 0 deals |
| `duplicate_delivery` | 200 | `duplicate` | n/a | n/a | none | the ledger already holds the event as `done` (seeded); the only logged call is `ledger.claim`; nothing else exists in the mock |
| `out_of_area` | 200 | `out_of_area` | none | ants / normal / 0.85 | none | Tallahassee (32301), an hour after closing; contact created with `ridgeway_tags: out-of-area`; one Slack note; no deal, no FieldRoutes calls |
| `bad_signature` | 401 | `unauthorized` | n/a | n/a | none | zero calls of any kind (no ledger claim, no Anthropic call) |
| `invalid_payload` | 400 | `invalid` | n/a | n/a | none | zero calls; error says a phone or email is required |
| `vague_low_confidence` | 200 | `needs_review` | jacksonville | other / normal / 0.3 | none | "something is going on at our house, not sure what exactly": confidence under the sheet's 0.6: contact upserted, ClickUp review task, Slack note; no deal, no slot |
| `malformed_llm` | 200 | `needs_review` | savannah | synthetic: pest_type `gremlins` | none | guardrail reason `invalid_output: pest_type is not an allowed value: "gremlins"`; same review path |
| `hubspot_429` | 200 | `auto_proposed` | jacksonville | ants / high / 0.92 | Fri Oct 16 1:00 PM, Fri Oct 16 3:00 PM, Sat Oct 17 8:00 AM | contact search statuses `[429, 429, 200]` (exactly 3 calls, 10.8 s with two 5-second waits; it succeeds on the third of four allowed tries); the contact 5001 the scenario injects was updated, not recreated (fire ants and two dogs: Claude calls it `ants`, urgency high) |
| `fieldroutes_down` | 200 | `auto_proposed` | mobile | roaches / high / 0.9 | `[]` | spot search statuses `[503, 503, 503, 503]` (the first try and 3 retries, 15.8 s); a "Call back to book" ClickUp task plus the CSR task (2 tasks), a Slack warning plus the summary (2 posts) |
| `clickup_timeout_after_commit` | 200 | `auto_proposed` | jacksonville | spiders / normal / 0.8 | Sat Oct 17 10:00 AM, Mon Oct 19 8:00 AM, Tue Oct 20 8:00 AM | a Saturday-morning lead (08:05 EDT); ClickUp CSR task committed, answer delayed past the 10 s node timeout; n8n retried 5 s later with the same `Idempotency-Key` (`evt-clickup-timeout-014:Create ClickUp CSR task`) and the same `X-Run-Id`; the mock replayed the original answer; exactly one task exists beyond the seed (mock state) |
| `emergency_commercial` | 200 | `approval_required` | mobile | rodents / emergency / 0.95 | Tue Oct 13 10:00 AM, Tue Oct 13 1:00 PM, Tue Oct 13 3:00 PM | a restaurant kitchen manager's call, test clock Tue 08:33 in Mobile; search window `2026-10-13` to `2026-10-14` for office 3 only; **`slots[0]` is Oct 13 at 10:00:00 local**, which is 08:33 in Mobile plus the one-hour lead time and so proves the America/Chicago window end to end (read as Eastern, 10:00 would already be inside the hour and the first slot would be 1:00 PM); deal moved to Needs approval (commercial) |
| `gmail_down` | 200 | `auto_proposed` | savannah | ants / normal / 0.9 | three | Gmail answers 503 on every try (4 calls, 15.8 s); the booking completes; response has `warnings: ["gmail_draft_failed"]` and `outreach.email.draft_failed: true`; the CSR task says "Email draft: FAILED, no draft was created" and never "created in Gmail". State beyond the seed: 0 drafts, 1 task |
| `stale_timestamp` | 401 | `unauthorized` (`stale_timestamp`) | n/a | n/a | none | correctly signed, timestamp 400 s old: zero calls of any kind |
| `future_timestamp` | 401 | `unauthorized` (`future_timestamp`) | n/a | n/a | none | correctly signed, timestamp 61 s ahead: zero calls |
| `pretty_printed_unicode_body` | 200 | `auto_proposed` | jacksonville | roaches / normal / 0.9 | three | pretty-printed body with `Peña` and `Café`, signed over its exact bytes; HubSpot receives `lastname: "Peña"`. The same bytes signed over the compact re-serialization are then refused (401 `signature_mismatch`, no new calls) |
| `pii_in_model_output` | 200 | `auto_proposed` | jacksonville | synthetic: echoes phone and email | three | the hand-written model reply carries `(904) 555-0188` and `jo.rivera@mail.example` in `summary` and `red_flags`; the response, the ClickUp task, Slack and Sheets carry `[phone removed]` / `[email removed]` instead; HubSpot keeps the customer's own message |
| `deal_create_conflict_after_timeout` | 200 | `auto_proposed` | savannah | ants / normal / 0.9 | three | the deal create commits but answers after the 10 s node timeout, and the mock ignores the key (like HubSpot); create statuses `[201 (late), 409, 409, 409]`: the retries conflict on the unique `ridgeway_event_id`; the deal is read by it (`get_deal` `[404, 200]`) and reused, `deal_reused: true`, warning `hubspot_deal_create_conflict`; exactly one deal beyond the seed; 25.9 s |
| `existing_email_contact_create` | 200 | `approval_required` | jacksonville | termites / high / 0.9 | three | contact 5002 has the lead's email but is not in the search index yet; the search finds nothing, the create gets `409` (four tries: n8n retries a 409 like any error), the contact is read with `GET .../contacts/malik.hendricks@gmail.example?idProperty=email` and PATCHed without overwriting its name; warning `hubspot_contact_create_conflict`; no second contact; 16.0 s |
| `slack_rate_limited` | 200 | `auto_proposed` | savannah | ants / normal / 0.9 | three | Slack answers the leads summary with 429 and `Retry-After: 1` once; n8n retries after its fixed 5 s (later than asked), the same key on both tries, `slack.post_message` statuses `[429, 200]`, one message exists, no warning |
| `missing_signature` (extra) | 401 | `unauthorized` | n/a | n/a | none | no signature header at all: zero calls. A signature without the timestamp header: 401 `missing_timestamp`, zero calls |
| `replay_two_deliveries` (extra) | 200, 200 | first `auto_proposed`, second `duplicate` | jacksonville | roaches / normal / 0.9 | | the same signed event twice in a row: the second delivery adds exactly one call (`ledger.claim`); one deal, one CSR task, one draft |
| `error_handler_fires` (extra) | 500 | n/a | n/a | spiders / normal / 0.9 | | HubSpot search fails on all four tries (statuses `[500, 500, 500, 500]`); the run stops, nothing else is created; the error workflow releases the claim (`ledger.fail` for that run id: ledger entry `failed` with `failed_at`), posts one alert to `#automation-alerts` that names the event id, and one row to the Errors tab (event id in the sixth column), with no customer data |
| `redelivery_while_in_flight` (extra) | 200, 409, 200 | first `auto_proposed`; second `in_flight`; third `duplicate` | jacksonville | roaches / normal / 0.9 | | the mock answers Claude 5 s late; a second POST of the same event 0.1 s later gets **409** with `Retry-After: 30` and `{status: in_flight}` (ledger outcomes `claimed`, `in_flight`, `done`); after the first run finishes a third POST gets `duplicate`. One deal, one task, one Claude call |
| `redelivery_after_failure` (extra) | 500, 200 | first fails; redelivery `approval_required` | jacksonville | termites / high / 0.9 | | the first run fails at the ClickUp CSR task (4 x 503) with the deal already created and moved to Needs approval; the error workflow marks the claim failed; the redelivery reads the deal by `ridgeway_event_id` (`get_deal` `[404, 200]`, `deal_reused: true`; the mock ignores Idempotency-Key on deal creation like HubSpot, so only the lookup prevents a second one), leaves its stage alone (one stage PATCH in all) and replays the Gmail draft by key. State beyond the seed: 1 deal, 1 task, 1 draft, 2 Slack posts (alert + summary), 2 sheet rows (error + speed-to-lead) |
| `approve_lead` (Approve / Hold) | 200 | `approved` | jacksonville | termites / high / 0.9 | | after the termite lead is booked, a signed click from the approver: calls in order `ledger.claim_decision`, `sheets.get_values` (`Settings!A2:B`, the stage ids), `hubspot.update_deal` (to `ridgeway_approved`, deal id from the ledger), `clickup.create_comment` ("Approved in Slack by user U0APPROVER1 at Oct 12, 9:29 AM EDT."), `slack.update_message` (summary kept, buttons replaced by "*Approved* by <@U0APPROVER1> at Oct 12, 9:29 AM EDT"), `ledger.complete_decision`; keys `evt-termite-fl-001:<node name>` |
| `hold_lead` | 200 | `on_hold` | jacksonville | | | the same with Hold: deal `ridgeway_on_hold`, the comment says not to book, "*Put on hold* by ..." |
| `approval_repeat_click` | 200 x 3 | `already_decided` (`already_approved`) | | | | after an Approve, a second click, a Slack redelivery (`retry_attempt: 1`) and a late Hold each add exactly one `ledger.claim_decision` and nothing else; one comment, the deal stays Approved |
| `approval_non_approver` | 403 | `not_approver` | | | | a user not on `SLACK_APPROVER_IDS`: the only call is `slack.post_ephemeral` to that user in that channel; deal still Needs approval, no decision in the ledger, buttons still on the message |
| `approval_bad_signature` | 401, 401 | `unauthorized` (`signature_mismatch`, `stale_timestamp`) | | | | wrong secret, and a correct signature 400 s old: zero calls of any kind |
| `approval_malformed_payload` | 400 x 3 | `invalid` | | | | an unknown action, a payload carrying message `blocks`, and no event id: zero calls of any kind |
| `approval_after_failure` | 500, 200 | first fails; second `approved` | | | | HubSpot answers 503 on four tries; the run fails at "Move deal to decided stage", the error workflow hands the decision back (`ledger.fail` → `decision_failed`) and alerts #automation-alerts naming the event; the next click is claimed (attempt 2), the deal update commits once, one comment, one message update |
| `live_hubspot_parity` (extra) | 200, 200, 200 | booked `approval_required`, `approved`, re-run `approval_required` | jacksonville | termites / high / 0.9 | | a fresh mock portal (HubSpot's own pipeline and default properties only; unknown properties and stages refused; `ridgeway_event_id` unique; Idempotency-Key ignored on HubSpot writes; `.example` emails refused). The real setup script: dry run plans 9 creates with reads only; the run creates them with generated ids (pipeline `880100001`, stages `1290000001` to `1290000009`); a second run plans nothing. With those ids and the email fallback in the sheet: the deal sits in `880100001` / `1290000004`, the contact holds `malik.hendricks+gmail@example.com`, the CSR task links to `https://app.hubspot.example/contacts/4242424/record/...`; Approve moves it to `1290000005`. Re-run against the same portal (new ledger and mocks, the contact not searchable): contact create `409` x4, read by email, update; deal read by event id, never created; still 1 contact and 1 deal, stage still Approved |
| `n8n_environment_allowlist` (extra) | | | | | | a throwaway probe workflow asks which of the ~115 variable names in the runner's environment a Code node can read: 38 visible, all on the allowlist (or added by the `sh` launcher or macOS: `PWD`, `SHLVL`, `__CF_USER_TEXT_ENCODING`); a canary set in the runner is not among them |
| `execution_history_has_no_lead_data` (extra) | | | | | | after a full run, every visible execution of the main workflow is a failed run with its data (2); the successful ones were soft-deleted, and the pruner hard-deleted at least one of them while the run was going (the last run left 3 soft-deleted rows not yet pruned; see README for what that means) |

Checks that hold in every scenario, asserted from the mock's log and state: no email is ever sent (a send endpoint is never called); no SMS endpoint exists or is called; every state-changing call carries `Idempotency-Key` as `<event id>:<node name>` and a numeric `X-Run-Id`; ledger calls carry `X-Run-Id` only; read calls carry neither; a key repeats only with a byte-identical request body (SHA-256 of the raw bytes), and only after an injected fault in the same run (a retry) or in a redelivery scenario; no Slack (post, update, ephemeral), ClickUp (task, comment), Sheets or ledger done-mark body contains any of the strings listed for that fixture (the lead's email, phone as E.164, 10 digits, dashed and parenthesized, and last name; hardcoded in `scenarios.json`, not derived from the code under test), and the model-written text in the response carries no phone or email; the mock's record counts and the ledger entry match the fixture; no recording is missing or stale.

## Simulated day (Tuesday, October 13, 2026)

`node scripts/simulate-day.mjs` sent the 40 deliveries of [`fixtures/day/leads.json`](fixtures/day/leads.json) through the real n8n workflow one at a time, with the test clock set to each arrival time in the branch's own time zone, against the mocked vendors and the recorded Claude answers (no Claude call). All 40 were answered 200 with a known status. The full output is in [`results/day/`](results/day/): [`kpi.md`](results/day/kpi.md) (these tables), [`state.json`](results/day/state.json) (the mock's final state: contacts, deals, ClickUp tasks, Slack posts with their blocks, Sheets rows, the ledger) and [`deliveries.json`](results/day/deliveries.json) (one row per delivery). The numbers below are from the last run; the speed figures vary by a few hundredths of a second between runs, the rest does not (the recorded answers and the fixed clock make it deterministic).

### Leads by branch and source

| Branch | Web form | HubSpot form | Call tracking | Deliveries | Share |
| --- | ---: | ---: | ---: | ---: | ---: |
| Jacksonville | 10 | 3 | 5 | 18 | 45% |
| Savannah | 5 | 2 | 4 | 11 | 28% |
| Mobile | 6 | 1 | 3 | 10 | 25% |
| Outside the service area | 1 | 0 | 0 | 1 | 3% |
| **All branches** | **22** | **6** | **12** | **40** | **100%** |

The redelivered event is counted under its branch both times. Outside the service area: one lead from Montgomery, Alabama.

### What happened to each delivery

| Status | Deliveries |
| --- | ---: |
| `auto_proposed` | 27 |
| `approval_required` | 8 |
| `service_request` | 1 |
| `needs_review` | 2 |
| `out_of_area` | 1 |
| `duplicate` | 1 |
| **Total** | **40** |

### Speed to lead

| Measure | Leads | p50 | p90 |
| --- | ---: | ---: | ---: |
| Webhook received to CSR task created (workflow time, recorded Claude answer replayed, mocked vendors) | 38 | 0.25 s | 0.32 s |
| Webhook received to response (the whole run) | 39 | 0.29 s | 0.36 s |
| Claude call time when it was recorded (`claude -p` through the bridge, CLI overhead included) | 39 | 3.28 s | 4.65 s |
| Estimate: CSR task time plus the recorded Claude call time | 38 | 3.51 s | 4.94 s |

The first row is what this run measured: n8n and the mocks on one laptop, with the Claude answer served instantly from a recording. It leaves out the real network, the real vendors and the real model call, so read it as the workflow's own overhead, not as a promise. Leads that get no CSR task (the out-of-area note, duplicates) are not in the first row. The last row adds the recorded model time to show the order of magnitude with a live Claude call.

### Open pipeline value by stage

| Stage | Deals | Value | Added today | Value added today |
| --- | ---: | ---: | ---: | ---: |
| New lead | 29 | $9,265 | 27 | $8,505 |
| Contacted | 2 | $450 | 0 | $0 |
| Inspection scheduled | 2 | $1,150 | 0 | $0 |
| Needs approval | 10 | $9,685 | 8 | $7,235 |
| Approved | 0 | $0 | 0 | $0 |
| On hold | 0 | $0 | 0 | $0 |
| Quote sent | 3 | $6,890 | 0 | $0 |
| **Open pipeline** | **46** | **$27,440** | **35** | **$15,740** |
| Won (closed, not counted) | 2 | $500 | 0 | $0 |
| Lost (closed, not counted) | 2 | $900 | 0 | $0 |

Values are the workflow's estimates from the illustrative price table (basis: "illustrative, pending sourced research"), plus the seeded deals that were already in the pipeline. Compared with the run before the termite-letter row: Priscilla Greer's WDO letter is $125 in New lead instead of $1,200 in Needs approval, and Candice Moreau's is $125 instead of $100 (it had been priced as `other`), so the open pipeline is $1,050 lower. The simulation sends no clicks, so Approved and On hold stay empty.

### Approval queue

10 deals wait for approval (8 came in today). A manager approves or holds each one from the Slack message.

| Arrived | Branch | Deal | Estimate | Why it needs approval | Deal id |
| --- | --- | --- | ---: | --- | ---: |
| 9:20 AM EDT | Jacksonville | Hector Valdivia - roaches | $1,255 | commercial property; estimate of $800 or more | 70223 |
| 9:30 AM CDT | Mobile | Beatrice Lundgren - termites | $1,200 | termite jobs always need approval; estimate of $800 or more | 70227 |
| 10:45 AM EDT | Savannah | Allister Quinn - rodents | $500 | commercial property | 70229 |
| 11:47 AM EDT | Jacksonville | Roberta Hanlon - ants | $1,155 | commercial property; estimate of $800 or more | 70232 |
| 1:52 PM EDT | Jacksonville | Carla Mendes - bed bugs | $975 | estimate of $800 or more | 70238 |
| 2:10 PM EDT | Savannah | Chantal Arceneaux - roaches | $300 | commercial property | 70240 |
| 5:42 PM EDT | Jacksonville | Yolanda Prescott - termites | $1,200 | termite jobs always need approval; estimate of $800 or more | 70247 |
| 6:32 PM EDT | Savannah | Natalie Foster - wildlife | $650 | wildlife jobs always need approval | 70248 |
| before today | Mobile | Dwayne Pettigrew - termites | $1,800 | seeded, decided by hand | 70208 |
| before today | Jacksonville | Gerald Washington - wildlife | $650 | seeded, decided by hand | 70209 |

### Top pests

| Pest | Leads | Share |
| --- | ---: | ---: |
| ants | 10 | 26% |
| roaches | 7 | 18% |
| rodents | 5 | 13% |
| termites | 5 | 13% |
| stinging insects | 4 | 10% |
| mosquitoes | 3 | 8% |
| other | 2 | 5% |
| bed bugs | 1 | 3% |
| spiders | 1 | 3% |
| wildlife | 1 | 3% |

Pest type is Claude's reading of the message, as recorded; 0 lead(s) have none because the model output was unusable. 8 lead(s) were read as an emergency.

### Timing

9 of 39 leads arrived outside office hours (8 AM to 5 PM local time): 5 before opening and 4 after closing, the last at 9:08 PM EDT. The workflow handles them the same way, so the CSR queue is ready when the office opens.

## Do the new tests fail without the fixes?

Each fix was checked by undoing it alone in a throwaway copy of this folder (outside the repository) and running the matching scenario. The run fails where it should:

| Fix undone | Scenario run | How it fails |
| --- | --- | --- |
| Gmail outcome read from `$('Create Gmail draft').first()` again | `gmail_down` | `body.warnings: expected ["gmail_draft_failed"], got []` (and, run ad hoc against the old workflow JSON with a 503 from Gmail, the CSR task said "Email draft: created in Gmail, not sent") |
| Key reuse check relied on the mock's `idempotent_replay` flag (the old check) | unit tests on synthetic logs | the old check passes a changed body, an unexplained reuse and a surprise redelivery; the new one throws on each |
| Mock stops honoring ClickUp keys (so the call counts and the key checks still pass) | `clickup_timeout_after_commit` | fails only on the new state assertion: 2 tasks exist instead of 1 |
| Idempotency keys built from `$execution.id` again | `redelivery_after_failure` | the Gmail draft of the first run is created again instead of replayed |
| `in_flight` treated as `claimed` | `redelivery_while_in_flight` | the second POST gets a full booking (200) instead of 409 |
| The error workflow no longer releases the claim | `redelivery_after_failure` | timed out waiting for the claim to be released |
| Deal search ignored | `redelivery_after_failure` | a second deal exists after the redelivery |
| Redaction switched off | `pii_in_model_output` | `clickup.create_task leaked personal data` |
| No replay window | `stale_timestamp`, `future_timestamp` | the stale request is processed and booked (200) |
| Hash over a re-serialization of the parsed body | `pretty_printed_unicode_body` | the pretty-printed body is refused with `signature_mismatch` |
| n8n started with a copy of the caller's environment | the allowlist check | a workflow can read variables that are not on the allowlist |
| Mobile branch read as Eastern | `emergency_commercial` | `the Chicago window is applied end to end` |
| A window several technicians have free offered once per technician (the dedupe removed) | unit test `slots: a window several technicians have free is offered once` | fails: the emergency lead is offered Monday 3 PM twice (in the unit test; not mutation-tested end to end) |
| `saveDataSuccessExecution: all` | full run, execution-history check | `only failed runs of the main workflow are visible (saw {"success":28,"error":2})` |
| Approver check always true (live-Slack pass) | `approval_non_approver` | the visitor's click is applied: the response is `{"status":"approved", ... "decided_by":"U0VISITOR01"}` instead of 403 |
| The ledger forgets a finished decision (the mock claims it again) | `approval_repeat_click` | the second click and the redelivery are answered `approved` again (only the mock's keys keep them from writing twice: the same comment id comes back), and the late Hold fails with "Error in workflow" (its deal update reuses the key with another body, 422) |
| A failed decision run is not handed back (the mock's `fail` skips decisions) | `approval_after_failure` | `timed out waiting for the decision to be released` |
| `custom_fields` dropped from the ClickUp task body | `termite_fl_new` | `the CSR task fills the five custom fields with option ids, the deal link and the callback deadline` |
| The deal body names the literal `ridgeway_new_lead` stage again instead of the sheet's (live-HubSpot pass) | `live_hubspot_parity` | `booking against the fresh portal: {"message":"Error in workflow"}`: the fresh portal refuses the stage, the lookup finds no deal, the run fails |
| The relay forwards before it acks | unit tests `relay.test.mjs` | `acks an interactive envelope before forwarding it` fails (and, because that copy also dropped the acks of dropped envelopes, the filtering test) |

Each of the five rows above was run on its own in a scratch copy outside the repository (four `verify.mjs --only` runs in parallel, one unit-test run). Not mutation-tested end to end: the termite-letter keyword rule (unit tests and the day's numbers), the 1.2 s live pacing, the `maxTries: 4` setting and the rules-in-the-sheet change (the unit tests assert them and the scenarios use them), and the boundaries of the replay window (unit tests: 300 s and 60 s accepted, one second more refused).

## Live Claude run (previous version of the workflow, not re-run)

Command: `node tests/verify.mjs --live-llm`; results in `results/live-llm-*` (including `live-llm-request-logs/`), recorded before the review-fix pass. The workflow's Claude node pointed at the shared bridge (a personal Claude subscription, signed in through a dedicated folder), which ran `claude -p` with Haiku 5.5. The same assertions of that time ran, with two exceptions: LLM-dependent fields (pest, urgency) are recorded as notes instead of failing, and `vague_low_confidence` records its observed status instead of asserting one. `malformed_llm` is skipped because it needs a hand-written model reply. Of its 16 checks, 15 passed and 1 was skipped. (The earlier version of this file said "16 of 16", counting the skipped one as a pass.) The new scenarios would run in live mode except `pii_in_model_output` (synthetic) and the two redelivery checks (they need the mock to delay or repeat the Claude answer), which are skipped there; none of that has been run.

Differences from the recordings (pest / urgency / confidence):

| Scenario | Recording | Live |
| --- | --- | --- |
| `termite_fl_new` | termites / normal / 0.9 | termites / normal / 0.9 |
| `ants_ga_recurring` | ants / normal / 0.92 | ants / normal / 0.9 |
| `existing_customer_al` | roaches / normal / 0.8 | roaches / normal / 0.7 |
| `out_of_area` | ants / normal / 0.8 | ants / normal / 0.8 |
| `vague_low_confidence` | rodents / normal / 0.45 | other / normal / 0.4 |
| `hubspot_429` | ants / normal / 0.85 | ants / normal / 0.9 |
| `fieldroutes_down` | roaches / high / 0.92 | roaches / high / 0.92 |
| `clickup_timeout_after_commit` | spiders / normal / 0.85 | spiders / normal / 0.92 |
| `emergency_commercial` | rodents / emergency / 0.95 | rodents / emergency / 0.95 |

Every status and every vendor call count of that time matched the replay run of that time. The classification was stable except for the deliberately vague message, where the model's pest guess changes between calls but the confidence stays under 0.6 every time, so the outcome is the same. Four real calls on that message gave other 0.4, other 0.35, rodents 0.45 and other 0.4.

## Workflow validation (n8n-mcp)

`validate_workflow` from n8n-mcp 2.92.1, documentation mode (no `N8N_API_URL`, telemetry off), profile `runtime`, run by `tests/validate-n8n-mcp.mjs` after reading the tool's input schema from `tools/list`. Output: [`results/n8n-mcp-validation.json`](results/n8n-mcp-validation.json). Book new lead: valid, 80 nodes, 104 valid connections, 155 expressions checked. Alert on errors: valid, 6 nodes, 7 valid connections, 16 expressions. Handle approval: valid, 28 nodes, 30 valid connections, 47 expressions.

Warnings: none. The tool returns informational suggestions, which I accept:

- "Consider enabling `alwaysOutputData`" on HTTP nodes: not adopted. Required steps should stop the run and trigger the error workflow; non-critical steps already use `continueErrorOutput`, whose error output carries the failure to the next Code node.
- "Most nodes lack error handling" and "consider sub-workflows": not adopted. Required steps deliberately keep n8n's default stop behaviour so the error workflow fires, and the 73 nodes are one business flow with documented sections.

The first validation run (of the original build) reported 15 errors, all "Array items must be objects with json property", a false positive on Code nodes whose injected module source contained `return [ ...strings ].join()`. Fixed by writing those functions differently; see BUILD-LOG.md.

## Live HubSpot

Phase 2 ran on 2026-10-11 against HubSpot developer test account 247657707 (data hosted in `na2`), with a service key that has the 8 scopes in the README. The rows of the summary table above give the results. In short: setup created everything it planned and a second dry run had nothing to create; HubSpot rejected `.example` emails, so the example.com fallback is now the default in live-HubSpot mode; with it, the smoke, the repeated smoke, the Slack Approve click and the full day (twice) all behaved as intended and no deal was duplicated.

**Real:** HubSpot (the developer test account; contacts, deals, pipeline, properties, associations, the record pages) and, in the Approve run, Slack (the demo workspace). **Mocked:** FieldRoutes, ClickUp, Gmail, Google Sheets and the event ledger (and Slack in the day runs). **Replayed:** the Claude answers. A production build would use a service key in the company's own HubSpot account; the workflow would not change.

Before phase 2 the same sequence was rehearsed offline: `live_hubspot_parity` in the replay suite (row above), and a scratch copy of this folder where `HUBSPOT_API` pointed at a standalone mock with a fake key of the real shape (setup, then the 3-lead smoke: "2 deals created, 0 reused", then "0 deals created, 2 reused"; the copy was deleted). The refusals are tested too: `simulate-day.mjs --live-hubspot` with no key, a malformed key (not echoed) or no `portal.json` exits 2 before starting anything; `--hubspot-email-fallback` and `--no-hubspot-email-fallback` without `--live-hubspot` are refused.

What phase 2 settled: HubSpot accepted the property, group and pipeline creates as sent; `.example` emails are rejected; a read by `idProperty=ridgeway_event_id` found every deal on reruns, including deals created a few minutes earlier; HubSpot generated the stage ids; the record page of the approved deal (`app-na2.hubspot.com/contacts/247657707/record/0-3/353551826643`, the format the workflow builds its links in) opened in a browser and showed the Approved stage. The links in Slack and ClickUp messages themselves were not clicked.

Not exercised live: the create-conflict paths (0 conflicts in every run, so the real status and body of the two conflicts are still unknown), an unknown `dealstage` (the mock refuses it; HubSpot's behaviour is still assumed), the rate-limit tier (no 429 at 1.5 s pacing) and what happens when the developer test account's trial lapses. A permanent 4xx costs about 15 s of n8n retries before it fails (BUILD-LOG.md, entry 51); not fixed.

## What this does not show

- **Not production, not a real vendor.** All vendor responses come from the local mock (live HubSpot ran against a real developer test account, but everything else is the mock). FieldRoutes shapes in particular are approximations (README, "Scope and limits").
- **Idempotency is proven against the mock's contract**, not against vendors that may ignore the header. The deal path is the exception that shows the fallback: the mock ignores the key for deal creation and the search by `ridgeway_event_id` still prevents a second deal.
- **Concurrency is tested for one case**: a redelivery while a run is in flight, against a single-process in-memory ledger that answers one request at a time. That shows the workflow does the right thing with each ledger answer; it does not show that a real database or Redis ledger is atomic.
- **The 409 and the 202.** The demo answers synchronously. A production sender with a short timeout needs the claim-then-202 design described in the README.
- **The real-workspace click was observed once, for Approve.** On 2026-10-11 a person clicked Approve on `evt-d1013-010` in the Slack web client; the relay forwarded it and the real HubSpot deal moved to Approved (the "Live HubSpot + live Slack, Approve" row above). Hold, repeat clicks, non-approvers and failed decision runs are tested against the mock and with an injected socket, not in the real workspace.
- **Recovery gaps, not covered by any test.** The relay acknowledges Slack before it forwards, so a crash in between loses that click (the approver has to click again), and when forwarding exhausts its retries it only logs. If the "Mark event done" step fails, the event stays `in_flight`, and a later redelivery can post to Slack twice. The ledger's 10-minute claim has no heartbeat or fencing, and nothing re-drives stuck claims: recovery waits for the sender to redeliver.
- **Live Slack is one 3-lead smoke.** No 429 occurred, so the rate-limit handling is shown against the mock (`slack_rate_limited`), not against Slack. The 40-lead live day was not run.
- **Slack can double-post.** `chat.postMessage` has no idempotency key; the mock honors the header, Slack ignores it (README).
- **Recordings are not raw API responses** (they come through the Claude Code CLI bridge) and two fixtures are hand-written and labelled synthetic (`malformed_llm`, `pii_in_model_output`). The synthetic PII reply proves the redaction works on what a model might write; it does not show how often a real model echoes contact details (the recorded replies contain none).
- **Redaction is pattern-based.** The formats it covers are listed in the README; an unusual one can slip through, which is why the rule stays "n8n passes ids, not content".
- **A live model could change the bodies of replayed steps.** On a redelivery after a failure, a second live answer may differ from the first, and a strict idempotency service would then refuse the keyed repeat. Replay mode (recorded answers, fixed clock) cannot show this; see the README.
- **Timing figures** (for example 10.8 s for `hubspot_429`, 15.8 s for the four-try scenarios) are the fixed 5-second retry waits, not performance measurements.
- **The seeds are mine, not a vendor's data.** The FieldRoutes customers and schedule, the HubSpot pipeline, contacts and deals, and the ClickUp list are invented to look lived-in; the workflow reads only a few fields of each (README, "Demo data"). The ClickUp custom fields are filled with the seed's field and option ids; the mock checks that a field id exists on the list but does not check that an option id belongs to its field.
- **The prices are placeholders.** Every price is labelled `"basis": "illustrative — pending sourced research"`. The pipeline values, the approval queue and the $800 threshold in the day's table inherit that; none of it says what Ridgeway, or any pest company, charges.
- **The day's speed-to-lead is the workflow's own overhead.** About a quarter of a second at p50 is n8n and the mocks on one laptop with the Claude answer served from a recording. The recorded Claude call time (about 3 s at p50) is a separate row, and a real run adds real network and vendor latency.
- **Pest labels are the model's reading and sometimes surprising.** Over the 50 recorded leads: a fire-ant lead in Pooler came back `stinging_insects` while another came back `ants`; "squirrels in the attic" came back `rodents`, not `wildlife`; one realtor's WDO request came back `other` and the other's `termites` (both are now priced as a termite letter by the words in the customer's message, not by the model's label); a message with winged insects near a door ("flying ants?? or maybe termites") came back `termites` at confidence 0.55 and went to review. None of this was changed. A WDO request worded without the sheet's keywords would still be priced as whatever pest the model names.
