/**
 * Pure helpers for the Family layer: label text, staleness and the airport
 * table used to draw a person's flight legs. No Cesium imports, so the logic
 * is testable under plain node.
 */

export const FAMILY_OVERLAY_SOURCE_ID = 'family';

/** Points older than this are drawn as "last seen" instead of live. */
export const FAMILY_STALE_MS = 2 * 3_600_000;

/** Airports the tracker's flight legs refer to. Add codes as trips need. */
export const FAMILY_AIRPORTS = Object.freeze({
  MSP: Object.freeze({ lat: 44.8848, lon: -93.2223 }),
  DFW: Object.freeze({ lat: 32.8998, lon: -97.0403 }),
  HKG: Object.freeze({ lat: 22.308, lon: 113.9185 }),
  BKK: Object.freeze({ lat: 13.69, lon: 100.7501 }),
});

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function formatAgo(thenMs, nowMs) {
  const minutes = Math.max(0, Math.round((nowMs - thenMs) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Map label for a person's latest point: name, then age and battery. */
export function familyLabel(name, latest, nowMs) {
  if (!latest) return { title: name, detail: 'no location yet' };
  const parts = [formatAgo(latest.receivedAt, nowMs)];
  if (Number.isFinite(latest.battery))
    parts.push(`${latest.battery}%${latest.charging ? ' charging' : ''}`);
  return { title: name, detail: parts.join(' · ') };
}

export function isFamilyPointStale(latest, nowMs) {
  return !latest || nowMs - latest.receivedAt > FAMILY_STALE_MS;
}

/** Flight legs whose both airports are known, as from/to coordinates. */
export function familyFlightLegs(flights) {
  if (!Array.isArray(flights)) return [];
  const legs = [];
  for (const leg of flights) {
    const from = FAMILY_AIRPORTS[String(leg?.from ?? '').toUpperCase()];
    const to = FAMILY_AIRPORTS[String(leg?.to ?? '').toUpperCase()];
    if (!from || !to) continue;
    legs.push({ flight: String(leg.flight ?? ''), from, to, depart: leg.depart ?? null });
  }
  return legs;
}

/** Destination countries whose mapped camera locations the layer shows. */
export const FAMILY_CAMERA_COUNTRIES = Object.freeze(['TH']);

/** One-line label for a live plane: flight, altitude and speed. */
export function planeLabel(plane) {
  const parts = [plane.flight || plane.callsign || 'Flight'];
  if (plane.onGround) parts.push('on the ground');
  else if (Number.isFinite(plane.altitudeFt))
    parts.push(`${Math.round(plane.altitudeFt).toLocaleString('en-US')} ft`);
  if (Number.isFinite(plane.groundSpeedKt))
    parts.push(`${Math.round(plane.groundSpeedKt)} kt`);
  return parts.join(' · ');
}
