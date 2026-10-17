import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Camera locations in a family member's destination country, from
 * OpenStreetMap (`man_made=surveillance`, ODbL). These are mapped camera
 * positions only, not viewable feeds. The country set is small and changes
 * slowly, so one Overpass query is cached on disk for a week.
 */

export const FAMILY_CAMERAS_OVERPASS_ENV = 'FAMILY_CAMERAS_OVERPASS';
/**
 * Tried in order; override with a comma-separated FAMILY_CAMERAS_OVERPASS.
 * overpass-api.de is deliberately absent: it refuses this host, and a
 * refusal is respected, not retried.
 */
export const DEFAULT_CAMERAS_OVERPASS = Object.freeze([
  'https://overpass.private.coffee/api/interpreter',
]);
export const FAMILY_CAMERA_COUNTRIES = Object.freeze(['TH']);
const CACHE_TTL_MS = 7 * 86_400_000;
const CACHE_DIR = path.join(process.cwd(), '.gev-cache', 'family');
const USER_AGENT =
  'gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)';

export function camerasQuery(country) {
  return (
    `[out:json][timeout:180];` +
    `area["ISO3166-1"="${country}"][admin_level=2]->.c;` +
    `node["man_made"="surveillance"](area.c);out;`
  );
}

/** Overpass nodes -> plain camera records. */
export function normalizeCameraNodes(payload) {
  if (!Array.isArray(payload?.elements)) return null;
  const cameras = [];
  for (const node of payload.elements) {
    if (node?.type !== 'node') continue;
    if (!Number.isFinite(node.lat) || !Number.isFinite(node.lon)) continue;
    const tags = node.tags && typeof node.tags === 'object' ? node.tags : {};
    cameras.push({
      id: node.id,
      lat: node.lat,
      lon: node.lon,
      kind: tags['surveillance:type'] || null,
      zone: tags['surveillance:zone'] || null,
      operator: tags.operator || null,
    });
  }
  return cameras;
}

/** Fetch (or reuse the cached) camera list for one country. */
export function createFamilyCameraStore({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheDir = CACHE_DIR,
} = {}) {
  const memory = new Map();
  const inFlight = new Map();

  async function load(country) {
    const cached = memory.get(country);
    if (cached && now() - cached.at < CACHE_TTL_MS) return cached;
    const file = path.join(cacheDir, `cameras-${country}.json`);
    let stale = cached ?? null;
    try {
      const disk = JSON.parse(await readFile(file, 'utf8'));
      if (Array.isArray(disk?.cameras)) {
        stale = disk;
        if (now() - disk.at < CACHE_TTL_MS) {
          memory.set(country, disk);
          return disk;
        }
      }
    } catch {
      // No disk copy yet.
    }
    try {
      const upstreams = env[FAMILY_CAMERAS_OVERPASS_ENV]
        ? env[FAMILY_CAMERAS_OVERPASS_ENV].split(',').map((u) => u.trim()).filter(Boolean)
        : DEFAULT_CAMERAS_OVERPASS;
      let cameras = null;
      let lastError = null;
      for (const upstream of upstreams) {
        try {
          const response = await fetchImpl(upstream, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': USER_AGENT,
            },
            body: new URLSearchParams({ data: camerasQuery(country) }).toString(),
            signal: AbortSignal.timeout(200_000),
          });
          if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
          cameras = normalizeCameraNodes(await response.json());
          if (!cameras) throw new Error('Malformed Overpass response');
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!cameras) throw lastError ?? new Error('No Overpass upstream');
      const fresh = { at: now(), country, cameras };
      memory.set(country, fresh);
      await mkdir(cacheDir, { recursive: true });
      await writeFile(file, JSON.stringify(fresh));
      return fresh;
    } catch (error) {
      if (stale) return stale;
      throw error;
    }
  }

  return {
    get(country) {
      if (!inFlight.has(country))
        inFlight.set(
          country,
          load(country).finally(() => inFlight.delete(country)),
        );
      return inFlight.get(country);
    },
  };
}
