// Vendor request bodies and queries. The n8n HTTP Request nodes own URLs, auth and retries;
// these functions only shape the payloads (approximating each vendor's documented shapes).
const CONTACT_SEARCH_PROPERTIES = ['email', 'phone', 'firstname', 'lastname', 'ridgeway_lead_status'];

// The email HubSpot stores. Off: the lead's own address. example_com (switched on in the rules sheet only if a live
// portal refuses .example addresses): <local>@<domain>.example becomes <local>+<domain>@example.com. example.com is
// reserved by RFC 2606, so the mapped address can never reach a real person; any other address is left alone.
function hubspotEmail(email, settings) {
  if (!email) return email;
  const mode = settings && settings.hubspot ? settings.hubspot.email_fallback : 'off';
  if (mode !== 'example_com') return email;
  const m = /^([^@\s]+)@([a-z0-9.-]+)\.example$/i.exec(email);
  return m ? `${m[1]}+${m[2].toLowerCase().replace(/\./g, '-')}@example.com` : email;
}

// One search matches email OR phone. HubSpot's search matches phone numbers on area code and local number and asks
// not to send the country code (search docs, "Limits"), so a +1 number is searched as typed and as its 10 digits.
function hubspotSearchBody(lead, settings) {
  const filterGroups = [];
  const email = hubspotEmail(lead.email, settings);
  if (email) filterGroups.push({ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] });
  if (lead.phone) {
    filterGroups.push({ filters: [{ propertyName: 'phone', operator: 'EQ', value: lead.phone }] });
    const national = /^\+1(\d{10})$/.exec(lead.phone);
    if (national) filterGroups.push({ filters: [{ propertyName: 'phone', operator: 'EQ', value: national[1] }] });
  }
  return { filterGroups, properties: CONTACT_SEARCH_PROPERTIES, limit: 5 };
}

function contactStatusTag(ctx) {
  if (ctx.path === 'out_of_area') return { status: 'out_of_area', tags: 'out-of-area' };
  if (ctx.path === 'needs_review') return { status: 'needs_review', tags: 'needs-review' };
  return { status: 'new_lead', tags: '' };
}

function hubspotContactProperties(ctx, existed) {
  const { lead } = ctx;
  const tag = contactStatusTag(ctx);
  const properties = {
    ridgeway_lead_status: tag.status,
    ridgeway_tags: tag.tags,
    ridgeway_lead_source: lead.source,
    // The customer's own words live in the CRM; Slack, ClickUp and Sheets get ids and links only.
    ridgeway_last_inquiry: lead.inquiry_text.slice(0, 2000),
    zip: lead.zip || '',
  };
  if (ctx.qualification) properties.ridgeway_pest_type = ctx.qualification.pest_type;
  if (lead.email) properties.email = hubspotEmail(lead.email, ctx.settings);
  if (lead.phone) properties.phone = lead.phone;
  if (!existed) {
    if (lead.first_name) properties.firstname = lead.first_name;
    if (lead.last_name) properties.lastname = lead.last_name;
    // The service address lives in the CRM too (Slack, ClickUp and Sheets still get the ZIP only).
    if (lead.street) properties.address = lead.street;
    if (lead.city) properties.city = lead.city;
    if (lead.state) properties.state = lead.state;
  }
  return properties;
}

function hubspotDealBody(ctx) {
  // A termite letter is named as what is sold (the Pricing row), not as the pest the model read.
  const sold = (ctx.service || ctx.qualification.pest_type).replace(/_/g, ' ').replace(/^wdo /, 'WDO ');
  const hubspot = ctx.settings.hubspot;
  return {
    properties: {
      dealname: `${ctx.lead.full_name || ctx.lead.phone || ctx.lead.email} - ${sold} (${ctx.branch.name})`,
      amount: String(ctx.estimated_value),
      pipeline: hubspot.pipeline_id,
      dealstage: hubspot.stages.new_lead,
      ridgeway_event_id: ctx.event_id,
    },
  };
}

// Redelivery guard on the HubSpot side: HubSpot does not honor Idempotency-Key, so the deal carries the event id in
// ridgeway_event_id, a unique-value property, and the workflow reads it directly by that value
// (GET /crm/v3/objects/deals/<event id>?idProperty=ridgeway_event_id) instead of searching, which can lag.
function hubspotDealLookupQuery() {
  return { idProperty: 'ridgeway_event_id', properties: 'dealname,dealstage,pipeline,ridgeway_event_id' };
}

// After a contact create was refused (an email that already exists, HubSpot's search had not caught up): read the
// contact by its email, a unique identifier (GET /crm/v3/objects/contacts/<email>?idProperty=email).
function hubspotContactLookupQuery() {
  return { idProperty: 'email', properties: 'email,phone,firstname,lastname,ridgeway_lead_status' };
}

function hubspotDealStageBody(settings) {
  return { properties: { dealstage: settings.hubspot.stages.needs_approval } };
}

// Move the deal to Needs approval only when approval is required and the deal is new, or a reused one still in New
// lead (an earlier attempt that did not get that far). A reused deal that is already Needs approval, Approved or On
// hold keeps its stage, so a redelivery or a re-run of the day never undoes a manager's decision.
function needsApprovalMove(ctx) {
  if (!ctx.approval || !ctx.approval.required) return false;
  if (!ctx.hubspot || !ctx.hubspot.deal_reused) return true;
  return !ctx.hubspot.deal_stage || ctx.hubspot.deal_stage === ctx.settings.hubspot.stages.new_lead;
}

// Approve / Hold from Slack: decision is "approved" or "on_hold"; the stage ids come from the rules sheet.
function hubspotDecisionStageBody(decision, settings) {
  if (!['approved', 'on_hold'].includes(decision)) throw new Error(`Unknown approval decision ${decision}`);
  return { properties: { dealstage: settings.hubspot.stages[decision] } };
}

function fieldRoutesCustomerQuery(ctx) {
  const query = { includeData: '1' };
  if (ctx.lead.phone) query.phone = ctx.lead.phone.replace(/^\+1/, '');
  else query.email = ctx.lead.email;
  return query;
}

function fieldRoutesSpotQuery(ctx) {
  return {
    officeIDs: JSON.stringify([ctx.branch.fieldroutes_office_id]),
    dateStart: ctx.window.start_date,
    dateEnd: ctx.window.end_date,
  };
}

const CLICKUP_PRIORITY = { emergency: 1, high: 2, normal: 3 };

function clickupTaskBody({ name, description, urgency, tags, custom_fields }) {
  const body = { name, description, priority: CLICKUP_PRIORITY[urgency] || 3, tags };
  if (Array.isArray(custom_fields) && custom_fields.length) body.custom_fields = custom_fields;
  return body;
}

// ClickUp v2 custom_fields on task create: [{ id, value }]. Field and option ids come from the Settings tab of the
// rules sheet (rules.js). Values are option ids, the HubSpot deal link and a callback deadline (Unix ms, from the
// sheet's callback hours for the urgency); never contact details. A value the workflow does not know is left out.
function clickupCustomFields(ctx, urgency) {
  const fields = ctx.settings && ctx.settings.clickup_fields;
  if (!fields) return [];
  const out = [];
  const option = (field, value) => { if (value && field.options[value]) out.push({ id: field.id, value: field.options[value] }); };
  option(fields.branch, ctx.branch && ctx.branch.id);
  option(fields.pest, ctx.qualification && ctx.qualification.pest_type);
  option(fields.urgency, urgency);
  const dealId = ctx.hubspot && ctx.hubspot.deal_id;
  if (dealId) out.push({ id: fields.deal_link.id, value: dealLink(ctx.settings, dealId) });
  const hours = ctx.settings.callback_hours && ctx.settings.callback_hours[urgency];
  if (hours && Number.isFinite(ctx.now_ms)) out.push({ id: fields.callback_by.id, value: ctx.now_ms + hours * 3600000 });
  return out;
}

function clickupCommentBody(text) {
  return { comment_text: text, notify_all: false };
}

function gmailDraftBody(raw) {
  return { message: { raw } };
}

// Google Sheets: speed-to-lead row.
function sheetsSpeedRow(ctx, finishedAtIso, status) {
  const q = ctx.qualification || (ctx.ai && ctx.ai.qualification);
  return {
    values: [[
      ctx.event_id, ctx.received_at, finishedAtIso, ctx.lead.source, ctx.branch ? ctx.branch.id : '',
      q ? q.pest_type : '', q ? q.urgency : '', status,
    ]],
  };
}
