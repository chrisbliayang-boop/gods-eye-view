import { readFile } from 'node:fs/promises';

/**
 * Public webcams around the part of the world on screen, from the Windy
 * Webcams API (v3 `nearby` search). Each has a current preview picture and
 * either a live player or the day's timelapse.
 *
 * The key is read from a JSON file named by FAMILY_WEBCAMS_KEY_FILE
 * (field `windy_key`), so the Where's Dad page and GEV share one key that
 * never reaches the browser. Without it the route reports `enabled: false`.
 */

export const FAMILY_WEBCAMS_KEY_FILE_ENV = 'FAMILY_WEBCAMS_KEY_FILE';
const WINDY_URL = 'https://api.windy.com/webcams/api/v3/webcams';
/** Free-tier preview links expire after about 10 minutes. */
const CACHE_MS = 9 * 60_000;
const CACHE_AREAS = 200;
const MAX_PER_VIEW = 100;
/** 250 km is Windy's largest `nearby` radius. */
export const WEBCAM_RADII_KM = Object.freeze([5, 15, 50, 150, 250]);

/**
 * Snap a view centre and radius to a coarse grid so nearby views share one
 * cached Windy call. Returns null for missing or out-of-range input.
 */
export function webcamViewArea(lat, lon, radiusKm) {
  lat = Number(lat);
  lon = Number(lon);
  radiusKm = Number(radiusKm);
  if (
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    !Number.isFinite(lon) ||
    Math.abs(lon) > 180 ||
    !Number.isFinite(radiusKm) ||
    radiusKm <= 0
  )
    return null;
  const radius = WEBCAM_RADII_KM.find((r) => radiusKm <= r) ?? WEBCAM_RADII_KM.at(-1);
  // About a quarter of the radius, in degrees.
  const step = Math.max(radius / 4 / 111, 0.05);
  const snap = (value) => Number((Math.round(value / step) * step).toFixed(3));
  return { lat: snap(lat), lon: snap(lon), radiusKm: radius };
}

/** Keep only what the map and the picture card need from one Windy webcam. */
export function normalizeWebcam(cam) {
  const lat = cam?.location?.latitude;
  const lon = cam?.location?.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const player = cam.player && typeof cam.player === 'object' ? cam.player : {};
  return {
    id: String(cam.webcamId ?? `${lat},${lon}`),
    lat,
    lon,
    title: typeof cam.title === 'string' && cam.title ? cam.title : 'Webcam',
    live: Boolean(player.live),
    image: cam.images?.current?.preview || null,
    watch: player.live || player.day || null,
    detail: cam.urls?.detail || null,
  };
}

export function createFamilyWebcamStore({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const cache = new Map();

  async function key() {
    const file = env[FAMILY_WEBCAMS_KEY_FILE_ENV];
    if (!file) return null;
    try {
      const value = JSON.parse(await readFile(file, 'utf8'))?.windy_key;
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  }

  async function fetchArea(apiKey, area) {
    const webcams = [];
    let offset = 0;
    while (offset < MAX_PER_VIEW) {
      const url = new URL(WINDY_URL);
      url.search = new URLSearchParams({
        nearby: `${area.lat},${area.lon},${area.radiusKm}`,
        limit: '50',
        offset: String(offset),
        include: 'location,images,player,urls',
      }).toString();
      const response = await fetchImpl(url, {
        headers: { 'x-windy-api-key': apiKey },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Windy HTTP ${response.status}`);
      const body = await response.json();
      const page = Array.isArray(body?.webcams) ? body.webcams : [];
      for (const cam of page) {
        const webcam = normalizeWebcam(cam);
        if (webcam) webcams.push(webcam);
      }
      offset += page.length;
      if (!page.length || offset >= (body?.total ?? 0)) break;
    }
    return webcams;
  }

  return {
    /** `{ enabled, webcams }` around one view; stale answers cover errors. */
    async get(lat, lon, radiusKm) {
      const apiKey = await key();
      if (!apiKey) return { enabled: false, webcams: [] };
      const area = webcamViewArea(lat, lon, radiusKm);
      if (!area) return { enabled: true, webcams: [] };
      const cacheKey = `${area.lat},${area.lon},${area.radiusKm}`;
      const cached = cache.get(cacheKey);
      if (cached && now() - cached.at < CACHE_MS) return { enabled: true, webcams: cached.webcams };
      try {
        const webcams = await fetchArea(apiKey, area);
        if (cache.size >= CACHE_AREAS) cache.clear();
        cache.set(cacheKey, { at: now(), webcams });
        return { enabled: true, webcams };
      } catch {
        return { enabled: true, webcams: cached?.webcams ?? [], error: 'Windy unavailable' };
      }
    },
  };
}
