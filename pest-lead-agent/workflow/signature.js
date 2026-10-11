// HMAC-SHA256 over `${timestamp}.${raw body}`, compared in constant time. The timestamp header makes a
// captured request useless after a few minutes: older than 300 s or more than 60 s in the future is rejected.
const SIGNATURE_HEADER = 'x-ridgeway-signature';
const TIMESTAMP_HEADER = 'x-ridgeway-timestamp';
const MAX_TIMESTAMP_AGE_SECONDS = 300;
const MAX_TIMESTAMP_FUTURE_SECONDS = 60;
const nodeCrypto = require('crypto');

// rawBody is the exact bytes the sender posted (a Buffer); it is hashed as is, never re-serialized.
function computeSignature(secret, timestamp, rawBody) {
  const hmac = nodeCrypto.createHmac('sha256', secret);
  hmac.update(`${timestamp}.`);
  hmac.update(rawBody);
  return hmac.digest('hex');
}

// nowMs is the workflow clock (real time, or the fixed test clock). Returns { ok, reason }.
function verifySignature(secret, rawBody, signatureHeader, timestampHeader, nowMs) {
  if (!secret || typeof signatureHeader !== 'string' || !signatureHeader) return { ok: false, reason: 'missing_signature' };
  if (!rawBody || !rawBody.length) return { ok: false, reason: 'missing_raw_body' };
  if (typeof timestampHeader !== 'string' || !timestampHeader.trim()) return { ok: false, reason: 'missing_timestamp' };
  const timestamp = timestampHeader.trim();
  if (!/^\d{9,11}$/.test(timestamp)) return { ok: false, reason: 'malformed_timestamp' };
  const supplied = signatureHeader.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(supplied)) return { ok: false, reason: 'malformed_signature' };
  const expected = Buffer.from(computeSignature(secret, timestamp, rawBody), 'hex');
  const actual = Buffer.from(supplied, 'hex');
  if (expected.length !== actual.length || !nodeCrypto.timingSafeEqual(expected, actual)) return { ok: false, reason: 'signature_mismatch' };
  // Only an authentic request learns why it was refused on timing grounds.
  const ageSeconds = nowMs / 1000 - Number(timestamp);
  if (ageSeconds > MAX_TIMESTAMP_AGE_SECONDS) return { ok: false, reason: 'stale_timestamp' };
  if (ageSeconds < -MAX_TIMESTAMP_FUTURE_SECONDS) return { ok: false, reason: 'future_timestamp' };
  return { ok: true, reason: null };
}

// "now" is real time unless the runner sets RIDGEWAY_TEST_MODE=true and sends x-ridgeway-test-now.
function resolveClock(headers, testMode) {
  const requested = headers && headers['x-ridgeway-test-now'];
  if (testMode === true || testMode === 'true') {
    const parsed = requested ? new Date(requested) : null;
    if (parsed && !Number.isNaN(parsed.getTime())) return { nowMs: parsed.getTime(), fixed: true };
  }
  return { nowMs: Date.now(), fixed: false };
}
