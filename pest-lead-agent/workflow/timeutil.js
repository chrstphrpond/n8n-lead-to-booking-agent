// Time zone helpers. Branches live in different zones (Jacksonville and Savannah are Eastern,
// Mobile is Central), and FieldRoutes returns spot times as local wall-clock strings.
function tzOffsetMinutes(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = type => Number(parts.find(p => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60000);
}

function zonedToInstantMs(dateStr, timeStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm, ss] = (timeStr || '00:00:00').split(':').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, hh, mm, ss || 0);
  const firstGuess = asUtc - tzOffsetMinutes(asUtc, timeZone) * 60000;
  return asUtc - tzOffsetMinutes(firstGuess, timeZone) * 60000;
}

function localDateString(instantMs, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instantMs));
}

function addDaysToDateString(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function weekdayOfDateString(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function formatClock(timeStr) {
  const [hh, mm] = timeStr.split(':').map(Number);
  const suffix = hh >= 12 ? 'PM' : 'AM';
  return `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

function formatSlotLabel(dateStr, startStr, endStr) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
    .format(new Date(`${dateStr}T00:00:00Z`));
  return `${day}, ${formatClock(startStr)} to ${formatClock(endStr)}`;
}
