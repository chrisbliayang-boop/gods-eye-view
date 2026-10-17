/**
 * Live aircraft for a family member's booked flight legs.
 *
 * A leg is only looked up while it could be in the air (a little before its
 * scheduled departure until a while after its scheduled arrival), so the
 * route makes no upstream calls on ordinary days. adsb.lol is keyed by the
 * ADS-B callsign, which uses the ICAO airline code; regional partners fly
 * some marketed numbers under their own code, so each airline has a short
 * candidate list.
 */

/** IANA zone for each airport's local schedule times. */
export const AIRPORT_TIME_ZONES = Object.freeze({
  MSP: 'America/Chicago',
  DFW: 'America/Chicago',
  HKG: 'Asia/Hong_Kong',
  BKK: 'Asia/Bangkok',
});

/** IATA marketing code -> ICAO callsign prefixes to try, mainline first. */
export const CALLSIGN_PREFIXES = Object.freeze({
  AA: Object.freeze(['AAL', 'ENY', 'SKW', 'RPA', 'PDT', 'JIA']),
  CX: Object.freeze(['CPA']),
});

// adsb.lol refuses generic agents; same identity as the /api/military proxy.
const ADSB_LOL_USER_AGENT = 'gods-eye-view-adsblol-proxy/1.0';
const EARLY_MS = 45 * 60_000;
const LATE_MS = 90 * 60_000;
/** A position older than this is not shown as live. */
const MAX_POSITION_AGE_S = 180;

function zoneOffsetMs(utcMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(utcMs))
      .map(({ type, value }) => [type, value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcMs;
}

/** "2026-11-01 18:48" at an airport -> epoch ms, or null. */
export function airportLocalToUtcMs(local, airport) {
  const timeZone = AIRPORT_TIME_ZONES[String(airport || '').toUpperCase()];
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(
    String(local || '').trim(),
  );
  if (!timeZone || !match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes settle the offset across a DST change.
  let utc = wall - zoneOffsetMs(wall, timeZone);
  utc = wall - zoneOffsetMs(utc, timeZone);
  return utc;
}

/** Legs that could be airborne at `nowMs`, with their UTC window. */
export function activeFlightLegs(flights, nowMs) {
  if (!Array.isArray(flights)) return [];
  const active = [];
  for (const leg of flights) {
    const departMs = airportLocalToUtcMs(leg?.depart, leg?.from);
    const arriveMs = airportLocalToUtcMs(leg?.arrive, leg?.to);
    if (departMs == null || arriveMs == null) continue;
    if (nowMs >= departMs - EARLY_MS && nowMs <= arriveMs + LATE_MS)
      active.push({ ...leg, departMs, arriveMs });
  }
  return active;
}

/** "AA 3133" -> ["AAL3133", "ENY3133", ...]. */
export function callsignCandidates(flight) {
  const match = /^([A-Z0-9]{2})\s*0*(\d{1,4})$/.exec(
    String(flight || '').toUpperCase().trim(),
  );
  if (!match) return [];
  const [, airline, number] = match;
  return (CALLSIGN_PREFIXES[airline] || []).map((prefix) => prefix + number);
}

/** Keep only the fields the map needs from one adsb.lol aircraft. */
export function normalizeLiveAircraft(ac, leg, callsign) {
  if (!ac || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) return null;
  const age = Number.isFinite(ac.seen_pos) ? ac.seen_pos : ac.seen;
  if (Number.isFinite(age) && age > MAX_POSITION_AGE_S) return null;
  return {
    flight: leg.flight,
    from: leg.from,
    to: leg.to,
    callsign,
    lat: ac.lat,
    lon: ac.lon,
    altitudeFt: Number.isFinite(ac.alt_baro) ? ac.alt_baro : null,
    onGround: ac.alt_baro === 'ground',
    groundSpeedKt: Number.isFinite(ac.gs) ? ac.gs : null,
    track: Number.isFinite(ac.track) ? ac.track : null,
    registration: typeof ac.r === 'string' ? ac.r : null,
    aircraftType: typeof ac.t === 'string' ? ac.t : null,
    positionAgeS: Number.isFinite(age) ? age : null,
  };
}

/** Find the live aircraft for each active leg (at most one per leg). */
export async function lookupFamilyPlanes(
  flights,
  { nowMs = Date.now(), fetchImpl = globalThis.fetch, signal } = {},
) {
  const planes = [];
  for (const leg of activeFlightLegs(flights, nowMs)) {
    for (const callsign of callsignCandidates(leg.flight)) {
      let payload;
      try {
        const response = await fetchImpl(
          `https://api.adsb.lol/v2/callsign/${callsign}`,
          {
            signal: signal ?? AbortSignal.timeout(10_000),
            headers: { 'User-Agent': ADSB_LOL_USER_AGENT },
          },
        );
        if (!response.ok) continue;
        payload = await response.json();
      } catch {
        continue;
      }
      const plane = (Array.isArray(payload?.ac) ? payload.ac : [])
        .map((ac) => normalizeLiveAircraft(ac, leg, callsign))
        .find(Boolean);
      if (plane) {
        planes.push(plane);
        break;
      }
    }
  }
  return planes;
}
