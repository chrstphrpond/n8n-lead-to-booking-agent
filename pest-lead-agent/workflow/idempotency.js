// Event-id idempotency, workflow side. The claim store is a service n8n calls (the event ledger; a mock here, a
// database or Redis in production), not workflow static data: n8n saves static data only when an execution
// ends, so a claim written at the start of a run is invisible to a redelivery that arrives while the run is
// still going. The ledger answers one of: claimed (go ahead), in_flight (another run holds the event), done.
const RETRY_AFTER_SECONDS = 30;

function claimRequestBody(eventId, runId) {
  return { event_id: eventId, run_id: String(runId) };
}

// Maps the ledger's answer to the next step. Anything unexpected throws, so the run fails into the error
// workflow instead of guessing and risking a duplicate lead.
function interpretClaim(response) {
  if (!response || typeof response !== 'object' || response.error) throw new Error('The event ledger did not answer the claim');
  if (response.outcome === 'claimed') return { route: 'claimed', reason: response.reclaimed || null };
  if (response.outcome === 'in_flight') return { route: 'in_flight', reason: 'in_flight' };
  if (response.outcome === 'done') return { route: 'duplicate', reason: 'already_processed' };
  throw new Error(`The event ledger returned an unknown outcome: ${JSON.stringify(response.outcome)}`);
}

// refs: the ids later steps look up by event id (the Approve / Hold workflow): HubSpot contact and deal, the CSR
// task, the branch time zone and, when the Slack summary was posted, its channel id and ts. For a lead that waits for
// approval it also keeps the summary's blocks without the buttons, so the decision can replace just the buttons.
function doneRequestBody(eventId, runId, status, refs = null) {
  const body = { event_id: eventId, run_id: String(runId), status };
  if (refs) body.refs = refs;
  return body;
}

function ledgerRefs(ctx, slackResponse, slackBody) {
  const posted = Boolean(slackResponse && slackResponse.ok === true && typeof slackResponse.ts === 'string' && slackResponse.channel);
  const waits = Boolean(ctx.approval && ctx.approval.required);
  return {
    branch: ctx.branch ? ctx.branch.id : null,
    timezone: ctx.branch ? ctx.branch.timezone : null,
    contact_id: (ctx.hubspot && ctx.hubspot.contact_id) || null,
    deal_id: (ctx.hubspot && ctx.hubspot.deal_id) || null,
    clickup_task_id: ctx.clickup_task_id || null,
    slack: posted ? {
      channel: slackResponse.channel, ts: slackResponse.ts,
      ...(waits && slackBody && Array.isArray(slackBody.blocks) ? { text: slackBody.text, blocks: slackBody.blocks.filter(block => block.type !== 'actions') } : {}),
    } : null,
  };
}

// A failed run hands its claim back through the error workflow, so a redelivery is processed again.
function failRequestBody(message) {
  return { reason: redactContactDetails(String(message || 'unknown error').replace(/\s+/g, ' ')).slice(0, 300) };
}
