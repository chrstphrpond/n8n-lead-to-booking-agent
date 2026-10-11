// Customer drafts and internal notifications. Nothing here sends anything: email becomes a Gmail
// draft, SMS is only a proposal for a CSR, and Slack/ClickUp are internal. Internal messages carry
// HubSpot ids, links, first name and ZIP only (never full phone, email or address): n8n passes ids,
// the details stay in HubSpot.
const OFFICE_EMAIL = 'leads@ridgeway-pest.example';
// Channel names work against the mock; a real workspace takes channel ids (SLACK_LEADS_CHANNEL, SLACK_ALERTS_CHANNEL).
const SLACK_LEADS_CHANNEL = '#leads';
const SLACK_ALERTS_CHANNEL = '#automation-alerts';

// env is $env in a Code node. Unset or empty means the default channel names.
function slackChannels(env) {
  const pick = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  return { leads: pick(env && env.SLACK_LEADS_CHANNEL, SLACK_LEADS_CHANNEL), alerts: pick(env && env.SLACK_ALERTS_CHANNEL, SLACK_ALERTS_CHANNEL) };
}

function leadsChannel(ctx) {
  return (ctx.channels && ctx.channels.leads) || SLACK_LEADS_CHANNEL;
}

function branchLabel(branch) {
  return branch ? `${branch.name}, ${branch.state}` : 'no branch (outside service area)';
}

function leadRef(ctx) {
  return `${ctx.lead.first_name || 'Customer'}, ZIP ${ctx.lead.zip || 'unknown'}`;
}

// HubSpot record links: <hubspot_app_url from the rules sheet>/<object type id>/<record id>, where the base is
// https://<ui host>/contacts/<portal id>/record (0-1 contacts, 0-3 deals). The mock's sheet keeps the .example base.
function contactLink(settings, contactId) {
  return contactId ? `${settings.hubspot.app_url}/0-1/${contactId}` : null;
}

function dealLink(settings, dealId) {
  return dealId ? `${settings.hubspot.app_url}/0-3/${dealId}` : null;
}

function slotLines(slots) {
  return slots.map((slot, index) => `${index + 1}. ${slot.label}`);
}

function proposeSms(ctx) {
  const { lead, slots } = ctx;
  // lead.sms_consent is already normalized (normalize.js): true only for boolean true or the strings true, yes, checked, on.
  if (lead.sms_consent !== true) return { proposed: false, text: null, omitted_reason: 'no_sms_consent' };
  if (!lead.phone) return { proposed: false, text: null, omitted_reason: 'no_phone' };
  const name = lead.first_name ? `Hi ${lead.first_name}, ` : 'Hi, ';
  const body = slots.length
    ? `${name}this is Ridgeway Pest Control about your request. We can come ${slots[0].label}${slots.length > 1 ? ` or ${slots[1].label}` : ''}. Reply with the time that works.`
    : `${name}this is Ridgeway Pest Control about your request. One of our team will call you shortly to book a visit.`;
  return { proposed: true, text: `${body} Reply STOP to opt out.`, omitted_reason: null };
}

function buildEmailDraft(ctx) {
  const { lead, slots, approval } = ctx;
  if (!lead.email) return { to: null, subject: null, body: null, omitted_reason: 'no_email' };
  const greeting = lead.first_name ? `Hi ${lead.first_name},` : 'Hello,';
  const pest = ctx.qualification.pest_type.replace(/_/g, ' ');
  const lines = [greeting, '', `Thanks for contacting Ridgeway Pest Control about ${pest}.`];
  if (slots.length) {
    lines.push('', 'These times are open at your local branch:', ...slotLines(slots), '', 'Reply with the one you prefer and we will confirm it.');
  } else {
    lines.push('', 'One of our team will call you shortly to find a time that works.');
  }
  if (approval.required) lines.push('', 'A specialist will review your request first to make sure we send the right technician.');
  lines.push('', 'Ridgeway Pest Control', '(Demo draft: fictional company, not sent.)');
  return { to: lead.email, subject: 'Your Ridgeway Pest Control request', body: lines.join('\n'), omitted_reason: null };
}

function buildMimeRaw(email) {
  const message = [
    `From: Ridgeway Pest Control <${OFFICE_EMAIL}>`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    email.body,
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

// The CSR must never be told a draft exists when Gmail refused it.
function emailDraftLine(email) {
  if (email.draft_failed) return 'Email draft: FAILED, no draft was created (Gmail refused it). Write the email by hand.';
  if (email.omitted_reason) return `Email draft: not created (${email.omitted_reason})`;
  return 'Email draft: created in Gmail, not sent';
}

function csrTaskDescription(ctx) {
  const q = ctx.qualification;
  const lines = [
    `Lead: ${leadRef(ctx)}`,
    `Source: ${ctx.lead.source} | Event: ${ctx.event_id} | Received: ${ctx.received_at}`,
    `HubSpot contact (phone and email are here): ${contactLink(ctx.settings, ctx.hubspot.contact_id)}`,
    `HubSpot deal: ${dealLink(ctx.settings, ctx.hubspot.deal_id)} (${ctx.approval.required ? 'Needs approval' : 'New lead'}) | Estimated value: $${ctx.estimated_value}${ctx.service && ctx.service !== q.pest_type ? ` (priced as ${ctx.service.replace(/_/g, ' ')})` : ''}`,
    `Branch: ${branchLabel(ctx.branch)}`,
    `Pest: ${q.pest_type} | Urgency: ${q.urgency} | Property: ${q.property_type} | Interest: ${q.service_interest} | Confidence: ${q.confidence}`,
    `Summary: ${redactContactDetails(q.summary)}`,
    `Red flags: ${q.red_flags.length ? q.red_flags.map(flag => redactContactDetails(flag)).join(', ') : 'none'}`,
    ctx.approval.required ? `Approval needed because: ${ctx.approval.reasons.join(', ')}` : 'Approval: not required, slots auto-proposed',
    ctx.slots.length ? `Proposed slots:\n${slotLines(ctx.slots).join('\n')}` : 'Proposed slots: none (call the customer to book)',
    emailDraftLine(ctx.outreach.email),
    ctx.outreach.sms.proposed ? `Proposed SMS (customer opted in, not sent): ${ctx.outreach.sms.text}` : `SMS: not proposed (${ctx.outreach.sms.omitted_reason})`,
  ];
  return lines.join('\n');
}

function reviewTaskDescription(ctx) {
  const lines = [
    `Lead: ${leadRef(ctx)}`,
    `Source: ${ctx.lead.source} | Event: ${ctx.event_id}`,
    `HubSpot contact (phone, email and the original message are here): ${contactLink(ctx.settings, ctx.hubspot.contact_id)}`,
    `Why this needs a human: ${redactContactDetails(ctx.ai.reason)}`,
    ctx.ai.qualification ? `Model's best guess: ${ctx.ai.qualification.pest_type}, ${ctx.ai.qualification.urgency}, confidence ${ctx.ai.qualification.confidence}` : 'Model output was unusable.',
    'No deal and no appointment slot were created.',
  ];
  return lines.join('\n');
}

function serviceRequestTaskDescription(ctx) {
  const lines = [
    `Existing FieldRoutes customer #${ctx.fieldroutes.customer_id}: ${leadRef(ctx)}`,
    `Source: ${ctx.lead.source} | Event: ${ctx.event_id}`,
    `Branch: ${branchLabel(ctx.branch)}`,
    `Pest: ${ctx.qualification.pest_type} | Urgency: ${ctx.qualification.urgency}`,
    `Summary: ${redactContactDetails(ctx.qualification.summary)}`,
    'Handle as a service request on the existing account (contact details are on the FieldRoutes customer). No new HubSpot deal was created.',
  ];
  return lines.join('\n');
}

function callbackTaskDescription(ctx) {
  const lines = [
    'FieldRoutes availability was unavailable, so no slots were proposed. Call back to book.',
    `Lead: ${leadRef(ctx)}`,
    `HubSpot contact (phone and email are here): ${contactLink(ctx.settings, ctx.hubspot.contact_id)}`,
    `Branch: ${branchLabel(ctx.branch)} | Pest: ${ctx.qualification.pest_type} | Urgency: ${ctx.qualification.urgency}`,
    `HubSpot deal: ${dealLink(ctx.settings, ctx.hubspot.deal_id)}`,
  ];
  return lines.join('\n');
}

function slackSummary(ctx, status) {
  const q = ctx.qualification;
  const header = `New ${q.urgency} lead: ${q.pest_type.replace(/_/g, ' ')} (${branchLabel(ctx.branch)})`;
  const fields = [
    `*Lead*\n${leadRef(ctx)}`,
    `*Status*\n${status}`,
    `*Estimated value*\n$${ctx.estimated_value}`,
    `*Proposed slots*\n${ctx.slots.length ? slotLines(ctx.slots).join('\n') : 'none, callback task created'}`,
  ];
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: header.slice(0, 150) } },
    { type: 'section', text: { type: 'mrkdwn', text: redactContactDetails(q.summary) } },
    { type: 'section', fields: fields.map(text => ({ type: 'mrkdwn', text })) },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Event ${ctx.event_id} | <${contactLink(ctx.settings, ctx.hubspot.contact_id)}|HubSpot contact ${ctx.hubspot.contact_id}> | <${dealLink(ctx.settings, ctx.hubspot.deal_id)}|deal ${ctx.hubspot.deal_id}> | ClickUp ${ctx.clickup_task_id}` }] },
  ];
  if (ctx.approval.required) {
    // The button carries the lead's event id and nothing else: the approval workflow looks up the deal, the task and
    // this message in the event ledger by that id instead of trusting what a button says.
    const value = ctx.event_id;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Approval needed:* ${ctx.approval.reasons.join(', ')}` } });
    blocks.push({
      type: 'actions',
      block_id: `approval_${ctx.event_id}`.slice(0, 255),
      elements: [
        { type: 'button', action_id: 'approve_lead', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value },
        { type: 'button', action_id: 'hold_lead', text: { type: 'plain_text', text: 'Hold' }, value },
      ],
    });
  }
  return { channel: leadsChannel(ctx), text: header, blocks };
}

function slackOutOfArea(ctx) {
  const text = `Out-of-area lead (ZIP ${ctx.lead.zip || 'unknown'}): ${ctx.qualification.pest_type.replace(/_/g, ' ')}. <${contactLink(ctx.settings, ctx.hubspot.contact_id)}|HubSpot contact ${ctx.hubspot.contact_id}> tagged out-of-area; no deal created.`;
  return { channel: leadsChannel(ctx), text };
}

function slackReview(ctx) {
  const reason = redactContactDetails(ctx.ai.reason);
  const text = `Lead needs review (${reason}). ClickUp task ${ctx.clickup_task_id}, <${contactLink(ctx.settings, ctx.hubspot.contact_id)}|HubSpot contact ${ctx.hubspot.contact_id}>; no deal or slot.`;
  return {
    channel: leadsChannel(ctx),
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*Needs review*\n${reason}\nTask: ${ctx.clickup_task_id}` } }],
  };
}

function slackServiceRequest(ctx) {
  const text = `Existing customer #${ctx.fieldroutes.customer_id} (${leadRef(ctx)}) wrote in about ${ctx.qualification.pest_type.replace(/_/g, ' ')} (${branchLabel(ctx.branch)}). ClickUp task ${ctx.clickup_task_id}; no new deal.`;
  return { channel: leadsChannel(ctx), text };
}

function slackFieldRoutesWarning(ctx) {
  const text = `FieldRoutes availability search failed for ${branchLabel(ctx.branch)}: no slots proposed for deal ${ctx.hubspot.deal_id}. Callback task ${ctx.callback_task_id || 'not created'}.`;
  return { channel: leadsChannel(ctx), text };
}

// Error-handler workflow: a short, PII-free description of a failed execution. eventId comes from the event
// ledger (the run that failed claimed it); it is an opaque id, not customer data.
function describeFailure(errorEvent, nowIso, eventId = null, alertsChannel = SLACK_ALERTS_CHANNEL) {
  const execution = (errorEvent && errorEvent.execution) || {};
  const workflow = (errorEvent && errorEvent.workflow) || {};
  const node = execution.lastNodeExecuted || 'unknown node';
  const message = redactContactDetails(String((execution.error && execution.error.message) || 'unknown error').replace(/\s+/g, ' ')).slice(0, 300);
  const event = eventId ? `, event ${eventId}` : '';
  const text = `Workflow "${workflow.name || 'unknown'}" failed at "${node}" (execution ${execution.id || 'n/a'}${event}): ${message}`;
  return {
    slack: { channel: alertsChannel, text },
    sheet: { values: [[nowIso, workflow.name || '', String(execution.id || ''), node, message, eventId || '']] },
  };
}
