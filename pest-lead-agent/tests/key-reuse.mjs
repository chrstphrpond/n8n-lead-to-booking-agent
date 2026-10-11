// Assertions about Idempotency-Key use, shared by the runner and the unit tests.
import assert from 'node:assert/strict';

export const WRITE_OPS = ['hubspot.create_contact', 'hubspot.update_contact', 'hubspot.create_deal', 'hubspot.update_deal', 'hubspot.associate_deal_contact',
  'clickup.create_task', 'clickup.create_comment', 'slack.post_message', 'slack.update_message', 'slack.post_ephemeral', 'gmail.create_draft', 'sheets.append'];
export const LEDGER_OPS = ['ledger.claim', 'ledger.complete', 'ledger.fail', 'ledger.claim_decision', 'ledger.complete_decision'];

// A key may be seen twice only for a reason, and the second request must be the same request:
//  - byte-identical body (a retry or redelivery that changed the body would get the wrong answer replayed);
//  - inside one run (same X-Run-Id) the first use must have carried an injected fault (an after-commit fault: answer
//    lost, the change is committed; or an error or timeout) or have been answered with an error (a vendor's 409).
//    A retry needs a cause;
//  - across runs (different X-Run-Id) it is a redelivery, allowed only where the scenario is about redelivery.
// It reads the raw request bytes (raw_sha256) and the injected fault from the mock's log, not the mock's own
// "this was a replay" flag, which is true by construction whenever a key repeats.
export function assertKeyReuse(id, log, { allowCrossRun = false } = {}) {
  const first = new Map();
  for (const entry of log.filter(item => WRITE_OPS.includes(item.op))) {
    const key = entry.idempotency_key;
    const earlier = first.get(key);
    if (!earlier) { first.set(key, entry); continue; }
    assert.equal(entry.raw_sha256, earlier.raw_sha256, `${id}: key ${key} was reused with a different request body`);
    if (entry.run_id === earlier.run_id) {
      // A retry needs a cause: an injected fault, or a vendor error answer (HubSpot's 409 conflicts are real answers, not injected).
      assert.ok(/^injected_/.test(earlier.fault ?? '') || earlier.status >= 400, `${id}: key ${key} was reused inside one run but its first use carried no injected fault or error`);
    } else {
      assert.ok(allowCrossRun, `${id}: key ${key} was reused by a different run (a redelivery) in a scenario that is not about redelivery`);
    }
  }
}

// Every state-changing call: Idempotency-Key = <event id>:<node name> (or <failed run id>:<node name> in the error
// workflow), X-Run-Id = a numeric execution id. Ledger calls send X-Run-Id only. Reads send neither.
export function assertWriteHeaders(id, log, prefixes) {
  for (const entry of log) {
    if (WRITE_OPS.includes(entry.op)) {
      assert.ok(prefixes.some(prefix => (entry.idempotency_key ?? '').startsWith(`${prefix}:`) && /^[A-Z][A-Za-z -]+$/.test(entry.idempotency_key.slice(prefix.length + 1))),
        `${id}: ${entry.op} Idempotency-Key must be <event id>:<node name>, got ${entry.idempotency_key}`);
      assert.match(entry.run_id ?? '', /^\d+$/, `${id}: ${entry.op} needs X-Run-Id`);
    } else if (LEDGER_OPS.includes(entry.op)) {
      assert.equal(entry.idempotency_key ?? null, null, `${id}: ${entry.op} is the dedupe authority and sends no Idempotency-Key`);
      assert.match(entry.run_id ?? '', /^\d+$/, `${id}: ${entry.op} needs X-Run-Id`);
    } else {
      assert.equal(entry.idempotency_key ?? null, null, `${id}: reads do not need a key (${entry.op})`);
    }
  }
}
