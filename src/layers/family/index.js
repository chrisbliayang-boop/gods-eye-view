import * as Cesium from 'cesium';
import {
  FAMILY_CAMERA_COUNTRIES,
  FAMILY_OVERLAY_SOURCE_ID,
  familyFlightLegs,
  familyLabel,
  isFamilyPointStale,
  planeLabel,
} from './model.js';
export * from './model.js';

const LIVE_COLOR = Cesium.Color.fromCssColorString('#2DD4BF');
const STALE_COLOR = Cesium.Color.fromCssColorString('#F59E0B');
const FLIGHT_COLOR = Cesium.Color.fromCssColorString('#93C5FD');
const FLIGHT_HEIGHT_M = 10_000;
const PLANE_COLOR = Cesium.Color.WHITE;
const CAMERA_COLOR = Cesium.Color.fromCssColorString('#F472B6');
const SPEED_CAMERA_COLOR = Cesium.Color.fromCssColorString('#FACC15');
/** Camera dots appear only once the view is closer than this (metres). */
const CAMERA_VISIBLE_M = 2_500_000;
const CAMERA_RETRY_MS = 10 * 60_000;

/** Read one person's trail from the local /api/family route. */
export function createFamilySource({
  personId,
  hours = 24,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(
        `/api/family/${encodeURIComponent(personId)}?hours=${hours}`,
        { signal },
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Family tracker HTTP ${response.status}`);
      return response.json();
    },
    /** Live aircraft for a booked leg that may be in the air, else []. */
    async getPlanes({ signal } = {}) {
      const response = await fetchImpl(
        `/api/family/${encodeURIComponent(personId)}/plane`,
        { signal },
      );
      if (!response.ok) return [];
      const body = await response.json();
      return Array.isArray(body?.planes) ? body.planes : [];
    },
    /** OSM-mapped camera locations in one country. */
    async getCameras(country, { signal } = {}) {
      const response = await fetchImpl(
        `/api/family/cameras/${encodeURIComponent(country)}`,
        { signal },
      );
      if (!response.ok) throw new Error(`Camera list HTTP ${response.status}`);
      const body = await response.json();
      return Array.isArray(body?.cameras) ? body.cameras : [];
    },
  };
}

/**
 * One family member who has agreed to share their location: a dot with
 * last-seen time and battery, their recent trail, their flight legs, their
 * plane while a booked leg is in the air, and OSM-mapped camera locations
 * (positions only, no feeds) in their destination country.
 * Local-only: it never enters share links or stored layer state.
 *
 * Opening the app with `?family=<id>` turns the layer on. Pair it with a
 * share-link hash (`#v=2&lat=..&lon=..`) to open the camera on them; turning
 * the layer on by hand flies the camera to their latest point.
 */
export function createFamilyLayer({
  overlayHost,
  personId = 'dad',
  source = createFamilySource({ personId }),
  location = globalThis.location,
} = {}) {
  if (!overlayHost) throw new TypeError('Family layer requires an overlay host');
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _focusPending = false;
  let _openedFromUrl = false;
  let _planes = [];
  let _cameras = [];
  let _camerasTriedAt = 0;

  function render(snapshot) {
    const now = Date.now();
    const entities = _dataSource.entities;
    entities.removeAll();
    const name = snapshot?.name || personId;
    const latest = snapshot?.latest ?? null;
    const overlayEntries = [];

    for (const leg of familyFlightLegs(snapshot?.flights)) {
      entities.add({
        id: `family:${personId}:flight:${leg.flight}`,
        polyline: {
          // At cruise height so terrain and photoreal tiles don't bury it.
          positions: Cesium.Cartesian3.fromDegreesArrayHeights([
            leg.from.lon, leg.from.lat, FLIGHT_HEIGHT_M,
            leg.to.lon, leg.to.lat, FLIGHT_HEIGHT_M,
          ]),
          arcType: Cesium.ArcType.GEODESIC,
          width: 3,
          material: new Cesium.PolylineDashMaterialProperty({
            color: FLIGHT_COLOR.withAlpha(0.8),
            dashLength: 16,
          }),
        },
        properties: { flight: leg.flight, depart: leg.depart },
      });
    }

    const trail = Array.isArray(snapshot?.trail) ? snapshot.trail : [];
    if (trail.length >= 2) {
      entities.add({
        id: `family:${personId}:trail`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(
            trail.flatMap((p) => [p.lon, p.lat]),
          ),
          width: 4,
          clampToGround: true,
          material: new Cesium.PolylineGlowMaterialProperty({
            color: LIVE_COLOR.withAlpha(0.85),
            glowPower: 0.2,
          }),
        },
      });
    }

    if (latest) {
      const stale = isFamilyPointStale(latest, now);
      const color = stale ? STALE_COLOR : LIVE_COLOR;
      const position = Cesium.Cartesian3.fromDegrees(latest.lon, latest.lat);
      entities.add({
        id: `family:${personId}:latest`,
        position,
        point: {
          pixelSize: 14,
          color,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: {
          battery: latest.battery,
          receivedAt: latest.receivedAt,
          connection: latest.connection,
        },
      });
      const { title, detail } = familyLabel(name, latest, now);
      overlayEntries.push({
        id: `${personId}:latest`,
        position,
        variant: 'label',
        // Plain labels draw one line, so name, age and battery share it.
        title: `${title} · ${detail}`,
        accent: color.toCssColorString(),
        priority: Number.MAX_SAFE_INTEGER,
        protected: true,
        collisionGroup: 'ambient-label',
        paintLane: 'ambient-label',
        interactive: false,
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 15,
        placement: 'above',
      });
      if (Number.isFinite(latest.accuracy) && latest.accuracy > 25) {
        entities.add({
          id: `family:${personId}:accuracy`,
          position,
          ellipse: {
            semiMajorAxis: latest.accuracy,
            semiMinorAxis: latest.accuracy,
            material: color.withAlpha(0.15),
            outline: true,
            outlineColor: color.withAlpha(0.6),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
        });
      }
    }
    for (const plane of _planes) {
      const position = Cesium.Cartesian3.fromDegrees(
        plane.lon,
        plane.lat,
        Number.isFinite(plane.altitudeFt) ? plane.altitudeFt * 0.3048 : 0,
      );
      entities.add({
        id: `family:${personId}:plane:${plane.callsign}`,
        position,
        point: {
          pixelSize: 13,
          color: PLANE_COLOR,
          outlineColor: FLIGHT_COLOR,
          outlineWidth: 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { flight: plane.flight, callsign: plane.callsign },
      });
      overlayEntries.push({
        id: `${personId}:plane:${plane.callsign}`,
        position,
        variant: 'label',
        title: planeLabel(plane),
        accent: FLIGHT_COLOR.toCssColorString(),
        priority: Number.MAX_SAFE_INTEGER - 1,
        protected: true,
        collisionGroup: 'ambient-label',
        paintLane: 'ambient-label',
        interactive: false,
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 15,
        placement: 'above',
      });
    }

    const cameraDisplay = new Cesium.DistanceDisplayCondition(0, CAMERA_VISIBLE_M);
    for (const camera of _cameras) {
      entities.add({
        id: `family:camera:${camera.id}`,
        position: Cesium.Cartesian3.fromDegrees(camera.lon, camera.lat),
        point: {
          pixelSize: 6,
          color: camera.type === 'speed' ? SPEED_CAMERA_COLOR : CAMERA_COLOR,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: cameraDisplay,
        },
        properties: { type: camera.type, kind: camera.kind, operator: camera.operator },
      });
    }

    _count = latest ? 1 : 0;
    if (_enabled)
      overlayHost.setEntries(FAMILY_OVERLAY_SOURCE_ID, overlayEntries, {
        moving: false,
      });
  }

  function focus(latest) {
    if (!_viewer || !latest) return;
    _viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(latest.lon, latest.lat, 1500),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-60), roll: 0 },
      duration: 2,
    });
  }

  return {
    id: 'family',
    name: 'Family',
    icon: '🧭',
    source: 'OwnTracks (local)',
    updateInterval: 30_000,

    init(viewer) {
      if (_viewer) throw new Error('Family layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('family');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(FAMILY_OVERLAY_SOURCE_ID, false);
    },

    attachDataManager(dataManager) {
      let requested = null;
      try {
        requested = new URLSearchParams(location?.search || '').get('family');
      } catch {
        requested = null;
      }
      if (requested !== personId) return;
      _openedFromUrl = true;
      // Registration is still being sealed; enable once startup moves on.
      setTimeout(() => {
        dataManager.setEnabled('family', true, { origin: 'user' });
      }, 0);
    },

    enable() {
      _enabled = true;
      // A URL-opened layer leaves the camera to the share-link hash, which
      // startup restores; flying here would race GEV's own startup flight.
      _focusPending = !_openedFromUrl;
      _openedFromUrl = false;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(FAMILY_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(FAMILY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FAMILY_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const [snapshot, planes] = await Promise.all([
          source.getSnapshot({ signal: request.signal }),
          // A plane lookup failure must not hide the person.
          source.getPlanes({ signal: request.signal }).catch(() => []),
        ]);
        if (
          !_cameras.length &&
          Date.now() - _camerasTriedAt > CAMERA_RETRY_MS
        ) {
          _camerasTriedAt = Date.now();
          const lists = await Promise.all(
            FAMILY_CAMERA_COUNTRIES.map((country) =>
              source.getCameras(country, { signal: request.signal }).catch(() => []),
            ),
          );
          _cameras = lists.flat();
        }
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _planes = planes;
        render(snapshot);
        if (_focusPending && snapshot?.latest) {
          _focusPending = false;
          focus(snapshot.latest);
        }
        _lastUpdate = Date.now();
        _lastError = snapshot ? null : 'Family tracker is not configured';
        return Boolean(snapshot);
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Family] Fetch error:', e);
        _lastError = e?.message || 'Family tracker unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      overlayHost.clearSource(FAMILY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FAMILY_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
}
