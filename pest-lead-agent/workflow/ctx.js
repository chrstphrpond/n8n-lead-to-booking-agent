// Context plumbing between Code nodes. Each HTTP node replaces the item with the vendor
// response, so the next Code node re-loads the context from the named "Prepare" node.
function loadCtx($, names) {
  for (const name of names) {
    try {
      const item = $(name).first();
      if (item && item.json) return JSON.parse(JSON.stringify(item.json));
    } catch (error) {
      // node did not run on this path; try the next candidate
    }
  }
  throw new Error(`Context not found in any of: ${names.join(', ')}`);
}

function describeHttp(response) {
  if (!response || typeof response !== 'object') return { ok: false, error: 'empty response' };
  if (response.error) {
    const err = response.error;
    return { ok: false, error: String(typeof err === 'string' ? err : err.message || JSON.stringify(err)).slice(0, 300) };
  }
  return { ok: true, error: null };
}

function buildResult(ctx, status) {
  const rawQ = ctx.qualification || (ctx.ai && ctx.ai.qualification) || null;
  // Model-written text is redacted again here: the response must never carry contact details a model echoed.
  const q = rawQ ? { ...rawQ, summary: redactContactDetails(rawQ.summary), red_flags: (rawQ.red_flags || []).map(flag => redactContactDetails(flag)) } : null;
  return {
    status,
    event_id: ctx.event_id,
    branch: ctx.branch ? ctx.branch.id : null,
    pest_type: q ? q.pest_type : null,
    urgency: q ? q.urgency : null,
    slots: (ctx.slots || []).map(slot => ({ spot_id: slot.spot_id, date: slot.date, start: slot.start, end: slot.end, label: slot.label })),
    hubspot: { contact_id: (ctx.hubspot && ctx.hubspot.contact_id) || null, deal_id: (ctx.hubspot && ctx.hubspot.deal_id) || null, deal_reused: Boolean(ctx.hubspot && ctx.hubspot.deal_reused) },
    clickup_task_id: ctx.clickup_task_id || null,
    approval_required: Boolean(ctx.approval && ctx.approval.required),
    outreach: ctx.outreach || null,
    reason: ctx.ai && ctx.ai.reason ? redactContactDetails(ctx.ai.reason) : null,
    qualification: q,
    llm_model: ctx.ai ? ctx.ai.llm_model || null : null,
    warnings: ctx.warnings || [],
  };
}
