import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Family tracker feed for the Family layer.
 *
 * A family member who has agreed to share their location runs OwnTracks,
 * which posts to a separate tracker service that appends one JSON point per
 * line to `<FAMILY_TRACKER_DIR>/<id>.jsonl`. This route reads that file
 * locally and returns the recent trail. Nothing is fetched from the network.
 *
 * `FAMILY_TRACKER_CONFIG` (optional) is the tracker's people file; only each
 * person's id, display name and flight legs are read from it, never any
 * credential. Without `FAMILY_TRACKER_DIR` the route answers 404, so the
 * layer is inert on installs that don't run the tracker.
 */

export const FAMILY_ROUTE = '/api/family';
export const FAMILY_TRACKER_DIR_ENV = 'FAMILY_TRACKER_DIR';
export const FAMILY_TRACKER_CONFIG_ENV = 'FAMILY_TRACKER_CONFIG';
export const FAMILY_DEFAULT_HOURS = 24;
export const FAMILY_MAX_HOURS = 24 * 30;
const MAX_TRAIL_POINTS = 2_000;
const PERSON_ID = /^[a-z0-9_-]{1,32}$/;

/** Keep only the fields the map needs from one stored point. */
export function normalizeFamilyPoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { lat, lon } = raw;
  if (
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    !Number.isFinite(lon) ||
    Math.abs(lon) > 180
  )
    return null;
  const receivedMs = Date.parse(raw.received_at);
  const reportedMs = Date.parse(raw.reported_at);
  if (!Number.isFinite(receivedMs)) return null;
  return {
    lat,
    lon,
    accuracy: Number.isFinite(raw.accuracy) ? raw.accuracy : null,
    battery: Number.isFinite(raw.battery) ? raw.battery : null,
    charging: raw.charging === true,
    speedKmh: Number.isFinite(raw.speed_kmh) ? raw.speed_kmh : null,
    connection: typeof raw.connection === 'string' ? raw.connection : null,
    receivedAt: receivedMs,
    reportedAt: Number.isFinite(reportedMs) ? reportedMs : receivedMs,
  };
}

/**
 * Parse a tracker .jsonl body into the trail since `sinceMs`, oldest first.
 * The newest point is always kept, even when it is older than the window,
 * so a quiet phone still shows where it was last seen.
 */
export function parseFamilyTrail(text, sinceMs) {
  const points = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let point;
    try {
      point = normalizeFamilyPoint(JSON.parse(line));
    } catch {
      continue;
    }
    if (point) points.push(point);
  }
  points.sort((a, b) => a.receivedAt - b.receivedAt);
  const latest = points.at(-1) ?? null;
  // Heartbeats resend the same fix; one trail vertex per distinct fix.
  const trail = [];
  for (const point of points) {
    if (point.receivedAt < sinceMs) continue;
    const last = trail.at(-1);
    if (last && last.lat === point.lat && last.lon === point.lon) continue;
    trail.push(point);
  }
  return { latest, trail: trail.slice(-MAX_TRAIL_POINTS) };
}

/** Public, credential-free view of one person from the tracker config. */
export function publicFamilyPerson(config, id) {
  const person = Array.isArray(config?.people)
    ? config.people.find((entry) => entry?.id === id)
    : null;
  const flights = Array.isArray(person?.flights)
    ? person.flights
        .filter((leg) => leg && typeof leg === 'object')
        .map((leg) => ({
          flight: String(leg.flight ?? ''),
          from: String(leg.from ?? ''),
          to: String(leg.to ?? ''),
          depart: leg.depart ? String(leg.depart) : null,
          arrive: leg.arrive ? String(leg.arrive) : null,
        }))
    : [];
  return {
    name: typeof person?.name === 'string' && person.name ? person.name : id,
    flights,
  };
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

export function familyTrackerProxy({ env = process.env, now = Date.now } = {}) {
  function install(middlewares) {
    middlewares.use(FAMILY_ROUTE, async (req, res) => {
      if (req.method !== 'GET') {
        send(res, 405, { error: 'Method Not Allowed' });
        return;
      }
      const dir = env[FAMILY_TRACKER_DIR_ENV];
      if (!dir) {
        send(res, 404, { error: 'Family tracker is not configured' });
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const id = url.pathname.replace(/^\/+|\/+$/g, '');
      if (!PERSON_ID.test(id)) {
        send(res, 400, { error: 'Invalid person id' });
        return;
      }
      const hoursParam = Number(url.searchParams.get('hours'));
      const hours =
        Number.isFinite(hoursParam) && hoursParam > 0
          ? Math.min(hoursParam, FAMILY_MAX_HOURS)
          : FAMILY_DEFAULT_HOURS;

      let text;
      try {
        text = await readFile(path.join(dir, `${id}.jsonl`), 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') {
          send(res, 404, { error: 'No points for this person yet' });
          return;
        }
        send(res, 500, { error: 'Family tracker file unreadable' });
        return;
      }

      let person = { name: id, flights: [] };
      const configPath = env[FAMILY_TRACKER_CONFIG_ENV];
      if (configPath) {
        try {
          person = publicFamilyPerson(
            JSON.parse(await readFile(configPath, 'utf8')),
            id,
          );
        } catch {
          // Name and flights are optional; the trail still renders.
        }
      }

      const { latest, trail } = parseFamilyTrail(
        text,
        now() - hours * 3_600_000,
      );
      send(res, 200, { id, ...person, hours, latest, trail });
    });
  }

  return {
    name: 'family-tracker',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
