// Business rules live in a Google Sheet ("Ridgeway ops rules"), not in the workflow. n8n reads the rows
// with Sheets values.get and these functions turn them into lookup tables. A malformed sheet throws, so the
// run fails into the error workflow instead of routing on bad rules.
function sheetRows(response, tab) {
  if (!response || response.error || !Array.isArray(response.values) || !response.values.length) {
    throw new Error(`Ops rules sheet tab "${tab}" is missing or empty`);
  }
  return response.values;
}

function parseServiceArea(response) {
  const branches = sheetRows(response, 'Service area').map(([id, name, state, timezone, officeId, zips]) => {
    if (!id || !timezone || !Number.isInteger(Number(officeId)) || !zips) throw new Error(`Service area row for "${id}" is incomplete`);
    return { id, name, state, timezone, fieldroutes_office_id: Number(officeId), zips: String(zips).split(/[\s,]+/).filter(Boolean) };
  });
  return { branches };
}

function parsePricing(response) {
  const first_year_value = {};
  for (const [pest, inspection, oneTime, recurring] of sheetRows(response, 'Pricing')) {
    const values = { inspection: Number(inspection), one_time: Number(oneTime), recurring: Number(recurring) };
    if (!pest || Object.values(values).some(value => !Number.isFinite(value) || value < 0)) throw new Error(`Pricing row for "${pest}" is invalid`);
    first_year_value[pest] = values;
  }
  for (const pest of PEST_TYPES) if (!first_year_value[pest]) throw new Error(`Pricing has no row for ${pest}`);
  return { first_year_value };
}

function parseSettings(response) {
  const byKey = Object.fromEntries(sheetRows(response, 'Settings').map(([key, value]) => [key, value]));
  const settings = {
    commercial_multiplier: Number(byKey.commercial_multiplier),
    emergency_surcharge: Number(byKey.emergency_surcharge),
    approval_value_threshold: Number(byKey.approval_value_threshold),
    approval_pest_types: String(byKey.approval_pest_types || '').split(',').map(item => item.trim()).filter(Boolean),
    confidence_threshold: Number(byKey.confidence_threshold),
    urgency_window_days: {
      emergency: Number(byKey.urgency_window_days_emergency),
      high: Number(byKey.urgency_window_days_high),
      normal: Number(byKey.urgency_window_days_normal),
    },
    commercial_requires_approval: String(byKey.commercial_requires_approval).trim().toLowerCase() === 'true',
    wdo_keywords: String(byKey.wdo_keywords || '').split(',').map(item => item.trim()).filter(Boolean),
    callback_hours: {
      emergency: Number(byKey.callback_hours_emergency),
      high: Number(byKey.callback_hours_high),
      normal: Number(byKey.callback_hours_normal),
    },
  };
  for (const key of ['commercial_multiplier', 'emergency_surcharge', 'approval_value_threshold']) {
    if (!Number.isFinite(settings[key])) throw new Error(`Setting ${key} is missing or not a number`);
  }
  if (byKey.confidence_threshold === undefined || !(settings.confidence_threshold >= 0 && settings.confidence_threshold <= 1)) {
    throw new Error('Setting confidence_threshold is missing or not a number from 0 to 1');
  }
  for (const [urgency, days] of Object.entries(settings.urgency_window_days)) {
    if (!Number.isInteger(days) || days < 0 || days > 30) throw new Error(`Setting urgency_window_days_${urgency} is missing or not a whole number of days (0 to 30)`);
  }
  if (!['true', 'false'].includes(String(byKey.commercial_requires_approval).trim().toLowerCase())) {
    throw new Error('Setting commercial_requires_approval must be true or false');
  }
  for (const [urgency, hours] of Object.entries(settings.callback_hours)) {
    if (!(hours > 0 && hours <= 72)) throw new Error(`Setting callback_hours_${urgency} is missing or not a number of hours (above 0, at most 72)`);
  }
  settings.clickup_fields = parseClickupFields(byKey);
  settings.hubspot = parseHubspotSettings(byKey);
  return settings;
}

// The HubSpot deal pipeline and stage ids, the record-link base and the email fallback (Settings rows hubspot_*).
// A real portal generates pipeline and stage ids, so they are sheet rows: the mock's sheet keeps the invented
// ridgeway_* ids, and the live-HubSpot runner puts the ids scripts/hubspot-setup.mjs read back from the portal there.
const HUBSPOT_STAGE_KEYS = ['new_lead', 'needs_approval', 'approved', 'on_hold'];
const HUBSPOT_EMAIL_FALLBACKS = ['off', 'example_com'];

function parseHubspotSettings(byKey) {
  const text = key => String(byKey[key] === undefined ? '' : byKey[key]).trim();
  const id = key => {
    const value = text(key);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error(`Setting ${key} is missing or not a HubSpot id`);
    return value;
  };
  const stages = Object.fromEntries(HUBSPOT_STAGE_KEYS.map(stage => [stage, id(`hubspot_stage_${stage}`)]));
  if (new Set(Object.values(stages)).size !== HUBSPOT_STAGE_KEYS.length) throw new Error('Settings hubspot_stage_* must name four different stages');
  const appUrl = text('hubspot_app_url');
  // https://<ui host>/contacts/<portal id>/record; the record path adds /0-1/<contact id> or /0-3/<deal id>.
  if (!/^https:\/\/app(-[a-z0-9]+)?\.hubspot\.(com|example)\/contacts\/\d+\/record$/.test(appUrl)) throw new Error('Setting hubspot_app_url must look like https://app.hubspot.com/contacts/<portal id>/record');
  const fallback = text('hubspot_email_fallback') || 'off';
  if (!HUBSPOT_EMAIL_FALLBACKS.includes(fallback)) throw new Error(`Setting hubspot_email_fallback must be one of ${HUBSPOT_EMAIL_FALLBACKS.join(', ')}`);
  return { pipeline_id: id('hubspot_pipeline_id'), stages, app_url: appUrl, email_fallback: fallback };
}

// The ClickUp CSR Queue's custom field ids and drop-down option ids live in the sheet too (Settings rows
// clickup_field_<name> and clickup_options_<name> = "value=option id,..."), so a re-created field is a sheet edit.
function parseClickupFields(byKey) {
  const fieldId = name => {
    const id = String(byKey[`clickup_field_${name}`] || '').trim();
    if (!id) throw new Error(`Setting clickup_field_${name} is missing`);
    return id;
  };
  const options = (name, required) => {
    const map = {};
    for (const pair of String(byKey[`clickup_options_${name}`] || '').split(',').map(item => item.trim()).filter(Boolean)) {
      const [value, optionId] = pair.split('=').map(item => (item || '').trim());
      if (!value || !optionId) throw new Error(`Setting clickup_options_${name} has a malformed entry "${pair}"`);
      map[value] = optionId;
    }
    for (const value of required) if (!map[value]) throw new Error(`Setting clickup_options_${name} has no option for ${value}`);
    return map;
  };
  return {
    branch: { id: fieldId('branch'), options: options('branch', []) },
    pest: { id: fieldId('pest'), options: options('pest', PEST_TYPES) },
    urgency: { id: fieldId('urgency'), options: options('urgency', URGENCY_LEVELS) },
    deal_link: { id: fieldId('deal_link') },
    callback_by: { id: fieldId('callback_by') },
  };
}
