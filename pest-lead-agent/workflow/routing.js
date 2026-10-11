// Service area, pricing estimate, approval gate and urgency windows. (The HubSpot pipeline and stage ids are rows
// of the rules sheet's Settings tab: rules.js, parseHubspotSettings.)

function findBranch(serviceArea, zip) {
  if (!zip) return null;
  const branch = serviceArea.branches.find(candidate => candidate.zips.includes(zip));
  if (!branch) return null;
  return { id: branch.id, name: branch.name, state: branch.state, timezone: branch.timezone, fieldroutes_office_id: branch.fieldroutes_office_id };
}

// The Pricing row a lead is priced on. Normally its pest type; an inspection request whose own text asks for a
// termite letter (a WDO report for a real estate closing, words from the sheet's wdo_keywords) is priced on the
// wdo_letter row instead, whatever pest the model named. It reads the customer's text, not the model's labels.
function pricedService(qualification, inquiryText, settings) {
  if (qualification.service_interest !== 'inspection') return qualification.pest_type;
  // Whole words only, punctuation ignored: "WDO" and "termite letter" match, "wdo123" does not.
  const words = value => ` ${String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const text = words(inquiryText);
  const asked = (settings.wdo_keywords || []).some(keyword => words(keyword).trim() && text.includes(words(keyword)));
  return asked ? 'wdo_letter' : qualification.pest_type;
}

// pricing and settings come from the "Ridgeway ops rules" sheet (see rules.js). service is the Pricing row
// (pricedService); it defaults to the pest type.
function estimateDealValue(pricing, settings, qualification, service = qualification.pest_type) {
  const row = pricing.first_year_value[service];
  if (!row) throw new Error(`Pricing has no row for ${service}`);
  const base = row[qualification.service_interest];
  const commercial = qualification.property_type === 'commercial' ? settings.commercial_multiplier : 1;
  const rush = qualification.urgency === 'emergency' ? settings.emergency_surcharge : 0;
  return Math.round(base * commercial + rush);
}

// The approval list names Pricing rows: a termite job needs approval, a termite letter (wdo_letter) does not.
function decideApproval(qualification, estimatedValue, settings, service = qualification.pest_type) {
  const reasons = [];
  if (settings.approval_pest_types.includes(service)) reasons.push(`pest_type:${service}`);
  if (settings.commercial_requires_approval && qualification.property_type === 'commercial') reasons.push('commercial_property');
  if (estimatedValue >= settings.approval_value_threshold) reasons.push(`estimated_value>=${settings.approval_value_threshold}`);
  return { required: reasons.length > 0, reasons };
}

// Local dates in the branch time zone. How many days each urgency looks ahead (today's ops rules: emergency 1,
// high 3, normal 7) comes from the Settings tab of the rules sheet as windowDays.
function urgencyWindow(urgency, nowMs, timeZone, windowDays) {
  if (!windowDays || !Number.isInteger(windowDays[urgency])) throw new Error(`No urgency window configured for ${urgency}`);
  const startDate = localDateString(nowMs, timeZone);
  return { start_date: startDate, end_date: addDaysToDateString(startDate, windowDays[urgency]) };
}

// Picks the HubSpot contact to update. Email matches win over phone matches.
function pickContactMatch(results, lead) {
  if (!Array.isArray(results) || !results.length) return null;
  const byEmail = lead.email && results.find(item => item.properties && (item.properties.email || '').toLowerCase() === lead.email);
  if (byEmail) return byEmail;
  const byPhone = lead.phone && results.find(item => item.properties && item.properties.phone === lead.phone);
  return byPhone || results[0];
}

// A HubSpot read by a unique value (GET /crm/v3/objects/<type>/<value>?idProperty=...), made with n8n's "never error"
// and "full response" options so a 404 is an answer, not a failure n8n would retry three times. 200 means found,
// 404 means there is no such record; anything else (429, 5xx, 401) throws, so the run fails into the error workflow.
function readHubspotLookup(response) {
  const status = Number(response && response.statusCode);
  let body = response ? response.body : null;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (error) { body = null; } }
  if (status === 200 && body && body.id) return { status, found: true, record: body };
  if (status === 404) return { status, found: false, record: null };
  throw new Error(`HubSpot lookup answered ${status || 'with no status'}${body && body.message ? `: ${String(body.message).slice(0, 200)}` : ''}`);
}

// The deal an earlier attempt of the same event created, read by its unique ridgeway_event_id. A record that
// carries a different event id would mean the lookup is broken, so it throws instead of reusing the wrong deal.
function pickDealLookup(response, eventId) {
  const lookup = readHubspotLookup(response);
  if (lookup.found && !(lookup.record.properties && lookup.record.properties.ridgeway_event_id === eventId)) {
    throw new Error(`HubSpot returned deal ${lookup.record.id} for event ${eventId}, but it carries another ridgeway_event_id`);
  }
  return lookup;
}
