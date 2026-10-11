// Approve / Hold from Slack ("Pest Lead Agent · Handle approval"). The Socket Mode relay (slack-relay/relay.mjs)
// forwards ids only: the action, the button value (the lead's event id), the user, the channel, the message ts, the
// action ts and the envelope's retry attempt. This module checks those ids, decides who may act, reads the event
// ledger's answer and words the outcome. The deal, the CSR task and the original message are looked up in the
// ledger by the event id; nothing a button says is trusted beyond that id.
const APPROVAL_ACTIONS = { approve_lead: 'approved', hold_lead: 'on_hold' };
const SLACK_ACTION_FIELDS = ['team_id', 'action_id', 'value', 'user_id', 'channel_id', 'message_ts', 'action_ts', 'retry_attempt'];
const SLACK_TS_PATTERN = /^\d{9,11}\.\d{1,6}$/;
const SLACK_USER_PATTERN = /^[UW][A-Z0-9]{2,30}$/;

function validateSlackAction(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { valid: false, errors: ['payload must be a JSON object'], action: null };
  const errors = [];
  const extra = Object.keys(payload).filter(key => !SLACK_ACTION_FIELDS.includes(key));
  if (extra.length) errors.push(`unexpected fields (the relay forwards ids only): ${extra.join(', ')}`);
  const text = key => (typeof payload[key] === 'string' ? payload[key] : '');
  if (!/^T[A-Z0-9]{2,30}$/.test(text('team_id'))) errors.push('team_id must be a Slack team id');
  if (!Object.prototype.hasOwnProperty.call(APPROVAL_ACTIONS, text('action_id'))) errors.push('action_id must be approve_lead or hold_lead');
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(text('value'))) errors.push("value must be the lead's event id");
  if (!SLACK_USER_PATTERN.test(text('user_id'))) errors.push('user_id must be a Slack user id');
  if (!/^[CGD][A-Z0-9]{2,30}$/.test(text('channel_id'))) errors.push('channel_id must be a Slack channel id');
  if (!SLACK_TS_PATTERN.test(text('message_ts'))) errors.push('message_ts must be a Slack message ts');
  if (!SLACK_TS_PATTERN.test(text('action_ts'))) errors.push('action_ts must be a Slack action ts');
  const retry = payload.retry_attempt;
  if (!(Number.isInteger(retry) && retry >= 0 && retry <= 10)) errors.push('retry_attempt must be a whole number from 0 to 10');
  if (errors.length) return { valid: false, errors, action: null };
  return {
    valid: true, errors: [],
    action: {
      team_id: payload.team_id, action_id: payload.action_id, decision: APPROVAL_ACTIONS[payload.action_id], event_id: payload.value,
      user_id: payload.user_id, channel_id: payload.channel_id, message_ts: payload.message_ts, action_ts: payload.action_ts, retry_attempt: retry,
    },
  };
}

// SLACK_APPROVER_IDS is a comma list of Slack user ids. Empty or unset means nobody may approve: fail closed.
function parseApproverIds(text) {
  return String(text || '').split(',').map(id => id.trim()).filter(id => SLACK_USER_PATTERN.test(id));
}

function isApprover(userId, approverIds) {
  return Array.isArray(approverIds) && approverIds.includes(userId);
}

function decisionClaimBody(action, runId) {
  return { run_id: String(runId), decision: action.decision, user_id: action.user_id, action_ts: action.action_ts };
}

// The ledger's answer to a decision claim. "claimed" carries the refs the lead's own run stored; "decided" and
// "in_flight" mean another click (or Slack's redelivery) got there first; "unknown_event" and
// "not_awaiting_approval" mean there is nothing to decide. Anything else throws, so the run fails into the error
// workflow instead of guessing.
function interpretDecisionClaim(response) {
  if (!response || typeof response !== 'object' || response.error) throw new Error('The event ledger did not answer the decision claim');
  if (response.outcome === 'claimed') {
    const refs = response.refs || {};
    if (!refs.deal_id || !refs.clickup_task_id) throw new Error('The event ledger holds no deal or CSR task for this lead');
    return { route: 'claimed', reason: null, refs };
  }
  if (response.outcome === 'decided') return { route: 'already_decided', reason: `already_${response.decision}`, refs: null };
  if (response.outcome === 'in_flight') return { route: 'already_decided', reason: 'decision_in_flight', refs: null };
  if (response.outcome === 'unknown_event' || response.outcome === 'not_awaiting_approval') return { route: 'not_awaiting', reason: response.outcome, refs: null };
  throw new Error(`The event ledger returned an unknown decision outcome: ${JSON.stringify(response.outcome)}`);
}

// Slack's action_ts is the click time; shown in the branch's own time zone ("Oct 12, 9:30 AM EDT").
function decisionTime(actionTs, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    .format(new Date(Math.round(Number(actionTs) * 1000)));
}

function decisionLine(action, timeZone) {
  const verb = action.decision === 'approved' ? 'Approved' : 'Put on hold';
  return `*${verb}* by <@${action.user_id}> at ${decisionTime(action.action_ts, timeZone)}`;
}

// chat.update of the original summary: the blocks the lead's run stored (without the buttons), then who decided
// and when. The buttons are gone, so the message cannot be decided twice from Slack.
function decidedMessage(refs, action) {
  const slack = refs.slack || {};
  const line = decisionLine(action, refs.timezone);
  const blocks = [...(Array.isArray(slack.blocks) ? slack.blocks : []), { type: 'section', text: { type: 'mrkdwn', text: line } }];
  return { channel: slack.channel || null, ts: slack.ts || null, text: `${slack.text || `Lead ${action.event_id}`}. ${line}`.slice(0, 3000), blocks };
}

function clickupDecisionComment(action, refs) {
  const when = decisionTime(action.action_ts, refs.timezone);
  const lines = action.decision === 'approved'
    ? [`Approved in Slack by user ${action.user_id} at ${when}.`, `HubSpot deal ${refs.deal_id} moved to Approved. Book the visit with the customer.`]
    : [`Put on hold in Slack by user ${action.user_id} at ${when}.`, `HubSpot deal ${refs.deal_id} moved to On hold. Do not book until a manager follows up.`];
  lines.push(`Event: ${action.event_id}`);
  return lines.join('\n');
}

// Only the person who clicked sees this; nothing else changes.
function approverOnlyNotice(action) {
  return { channel: action.channel_id, user: action.user_id, text: 'Only approvers can approve or hold a lead. Nothing was changed; ask a manager to decide.' };
}
