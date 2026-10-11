// Turns FieldRoutes spot-search results into at most three proposed appointment slots.
const MAX_PROPOSED_SLOTS = 3;
const MIN_LEAD_MINUTES = 60;

function pickSlots(spots, { nowMs, timeZone, window, urgency }) {
  if (!Array.isArray(spots)) return [];
  const candidates = spots
    .filter(spot => spot && spot.date && spot.start && spot.end && spot.date >= window.start_date && spot.date <= window.end_date)
    .map(spot => ({ spot, startMs: zonedToInstantMs(spot.date, spot.start, timeZone) }))
    .filter(item => item.startMs >= nowMs + MIN_LEAD_MINUTES * 60000)
    .sort((a, b) => a.startMs - b.startMs);
  // Several technicians can be free in the same window; the customer is offered each window once.
  const seenWindows = new Set();
  const windows = candidates.filter(item => {
    const key = `${item.spot.date} ${item.spot.start} ${item.spot.end}`;
    if (seenWindows.has(key)) return false;
    seenWindows.add(key);
    return true;
  });

  let chosen;
  if (urgency === 'normal') {
    // Spread across different days first so the customer sees real choice, then fill with remaining earliest slots.
    const firstPerDay = [];
    const seenDays = new Set();
    for (const item of windows) {
      if (!seenDays.has(item.spot.date)) { seenDays.add(item.spot.date); firstPerDay.push(item); }
    }
    const rest = windows.filter(item => !firstPerDay.includes(item));
    chosen = [...firstPerDay, ...rest].slice(0, MAX_PROPOSED_SLOTS).sort((a, b) => a.startMs - b.startMs);
  } else {
    chosen = windows.slice(0, MAX_PROPOSED_SLOTS);
  }
  return chosen.map(({ spot, startMs }) => ({
    spot_id: String(spot.spotID),
    date: spot.date,
    start: spot.start,
    end: spot.end,
    starts_at: new Date(startMs).toISOString(),
    label: formatSlotLabel(spot.date, spot.start, spot.end),
  }));
}
