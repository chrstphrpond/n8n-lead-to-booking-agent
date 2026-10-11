# Simulated day: Tuesday, October 13, 2026

40 deliveries (39 distinct leads and 1 redelivery) went through the real n8n 2.42.6 workflow, one at a time, with the test clock set to each arrival time in the branch's own time zone. Fictional company, mocked vendors, Claude answers replayed from recordings: nothing was sent to a real person or account, and no Claude call was made for this report.

## Leads by branch and source

| Branch | Web form | HubSpot form | Call tracking | Deliveries | Share |
| --- | ---: | ---: | ---: | ---: | ---: |
| Jacksonville | 10 | 3 | 5 | 18 | 45% |
| Savannah | 5 | 2 | 4 | 11 | 28% |
| Mobile | 6 | 1 | 3 | 10 | 25% |
| Outside the service area | 1 | 0 | 0 | 1 | 3% |
| **All branches** | **22** | **6** | **12** | **40** | **100%** |

The redelivered event is counted under its branch both times. Outside the service area: one lead from Montgomery, Alabama.

## What happened to each delivery

| Status | Deliveries |
| --- | ---: |
| `auto_proposed` | 27 |
| `approval_required` | 8 |
| `service_request` | 1 |
| `needs_review` | 2 |
| `out_of_area` | 1 |
| `duplicate` | 1 |
| **Total** | **40** |

## Speed to lead

| Measure | Leads | p50 | p90 |
| --- | ---: | ---: | ---: |
| Webhook received to CSR task created (workflow time, recorded Claude answer replayed, mocked vendors) | 38 | 0.29 s | 0.35 s |
| Webhook received to response (the whole run) | 39 | 0.34 s | 0.41 s |
| Claude call time when it was recorded (`claude -p` through the bridge, CLI overhead included) | 39 | 3.28 s | 4.65 s |
| Estimate: CSR task time plus the recorded Claude call time | 38 | 3.55 s | 4.99 s |

The first row is what this run measured: n8n and the mocks on one laptop, with the Claude answer served instantly from a recording. It leaves out the real network, the real vendors and the real model call, so read it as the workflow's own overhead, not as a promise. Leads that get no CSR task (the out-of-area note, duplicates) are not in the first row. The last row adds the recorded model time to show the order of magnitude with a live Claude call.

## Open pipeline value by stage

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

Values are the workflow's estimates from the illustrative price table (basis: "illustrative, pending sourced research"), plus the seeded deals that were already in the pipeline.

## Approval queue

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

## Top pests

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

## Timing

9 of 39 leads arrived outside office hours (8 AM to 5 PM local time): 5 before opening and 4 after closing, the last at 9:08 PM EDT. The workflow handles them the same way, so the CSR queue is ready when the office opens.

---

Reproduce with `node scripts/simulate-day.mjs` (under a minute). The data is fictional: real ZIP codes with invented streets, 555-01xx phone numbers, `.example` email addresses and illustrative prices.
