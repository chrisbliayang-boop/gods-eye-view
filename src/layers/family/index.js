import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
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
const LIVE_WEBCAM_COLOR = Cesium.Color.fromCssColorString('#EF4444');
const SNAPSHOT_WEBCAM_COLOR = Cesium.Color.fromCssColorString('#A78BFA');
const WEBCAM_PREFIX = 'family:webcam:';
/** Webcams load only when the view's half-diagonal is at most this (km). */
const WEBCAM_MAX_VIEW_KM = 300;
const WEBCAM_DEBOUNCE_MS = 800;
/** Free-tier Windy previews expire after about 10 minutes. */
const WEBCAM_REFRESH_MS = 9 * 60_000;

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
    /** Windy webcams around a view centre: `{ enabled, webcams }`. */
    async getWebcams(lat, lon, radiusKm, { signal } = {}) {
      const query = new URLSearchParams({
        lat: lat.toFixed(4),
        lon: lon.toFixed(4),
        r: String(Math.ceil(radiusKm)),
      });
      const response = await fetchImpl(`/api/family/webcams?${query}`, { signal });
      if (!response.ok) return { enabled: false, webcams: [] };
      const body = await response.json();
      return {
        enabled: Boolean(body?.enabled),
        webcams: Array.isArray(body?.webcams) ? body.webcams : [],
      };
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
 * plane while a booked leg is in the air, OSM-mapped camera locations
 * (positions only, no feeds) in their destination country, and public Windy
 * webcams around whatever is on screen (click one for its picture).
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
  picking = null,
  doc = globalThis.document,
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
  let _snapshot = null;
  let _webcams = [];
  let _webcamRequest = null;
  let _webcamTimer = null;
  let _webcamRefresh = null;
  let _removeMoveEnd = null;
  let _clickHandler = null;
  let _card = null;

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

    for (const cam of _webcams) {
      entities.add({
        id: `${WEBCAM_PREFIX}${cam.id}`,
        position: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat),
        point: {
          pixelSize: 10,
          color: cam.live ? LIVE_WEBCAM_COLOR : SNAPSHOT_WEBCAM_COLOR,
          outlineColor: Cesium.Color.WHITE.withAlpha(0.9),
          outlineWidth: 1.5,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
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

  /** Centre and half-diagonal (km) of what is on screen, or null. */
  function viewArea() {
    const rect = _viewer?.camera.computeViewRectangle();
    if (!rect) return null;
    const centre = Cesium.Rectangle.center(rect);
    const corner = Cesium.Rectangle.northeast(rect);
    const km =
      Cesium.Cartesian3.distance(
        Cesium.Cartographic.toCartesian(centre),
        Cesium.Cartographic.toCartesian(corner),
      ) / 1000;
    return {
      lat: Cesium.Math.toDegrees(centre.latitude),
      lon: Cesium.Math.toDegrees(centre.longitude),
      km,
    };
  }

  async function loadWebcams() {
    if (!_enabled || !_viewer || _card) return;
    _webcamRequest?.abort();
    const area = viewArea();
    if (!area || area.km > WEBCAM_MAX_VIEW_KM) {
      if (_webcams.length) {
        _webcams = [];
        render(_snapshot);
      }
      return;
    }
    const request = new AbortController();
    _webcamRequest = request;
    try {
      const { webcams } = await source.getWebcams(area.lat, area.lon, area.km, {
        signal: request.signal,
      });
      if (request.signal.aborted || !_enabled || _card) return;
      _webcams = webcams;
      render(_snapshot);
    } catch {
      // Webcams are extras; a failed lookup leaves the last set showing.
    } finally {
      if (_webcamRequest === request) _webcamRequest = null;
    }
  }

  function scheduleWebcams() {
    clearTimeout(_webcamTimer);
    _webcamTimer = setTimeout(loadWebcams, WEBCAM_DEBOUNCE_MS);
  }

  function closeCard() {
    _card?.remove();
    _card = null;
  }

  /** A small picture card for one webcam, built without innerHTML. */
  function openCard(cam) {
    closeCard();
    if (!doc?.body) return;
    const el = (tag, style, text) => {
      const node = doc.createElement(tag);
      if (style) node.style.cssText = style;
      if (text) node.textContent = text;
      return node;
    };
    const card = el('div',
      'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:60;' +
      'width:min(340px,calc(100vw - 32px));padding:12px;border-radius:12px;' +
      'background:rgba(8,14,20,.92);border:1px solid rgba(147,197,253,.35);' +
      'color:#e7eef3;font:13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', cam.title);
    const head = el('div', 'display:flex;gap:8px;align-items:start;justify-content:space-between;');
    const swatch = cam.live ? '#EF4444' : '#A78BFA';
    const title = el('strong', `border-left:3px solid ${swatch};padding-left:8px;line-height:1.3;`, cam.title);
    const close = el('button',
      'background:none;border:0;color:#93a4b2;font-size:18px;cursor:pointer;line-height:1;', '×');
    close.setAttribute('aria-label', 'Close webcam');
    close.addEventListener('click', closeCard);
    head.append(title, close);
    card.append(head);
    if (cam.image) {
      const img = el('img', 'display:block;width:100%;margin-top:8px;border-radius:8px;');
      img.src = cam.image;
      img.alt = cam.title;
      img.referrerPolicy = 'origin';
      card.append(img);
    }
    const foot = el('div', 'display:flex;justify-content:space-between;gap:8px;margin-top:8px;');
    const link = el('a', 'color:#93c5fd;', cam.live ? 'Watch live ↗' : "See today's pictures ↗");
    link.href = cam.watch || cam.detail || 'https://www.windy.com/webcams';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const credit = el('a', 'color:#93a4b2;', 'via Windy.com');
    credit.href = 'https://www.windy.com/webcams';
    credit.target = '_blank';
    credit.rel = 'noopener noreferrer';
    foot.append(link, credit);
    card.append(foot);
    doc.body.append(card);
    _card = card;
  }

  function installWebcamInteraction() {
    if (!_viewer || _clickHandler) return;
    picking?.registerPickOwner('family', (id) => String(id).startsWith('family:'));
    _removeMoveEnd = _viewer.camera.moveEnd.addEventListener(scheduleWebcams);
    _webcamRefresh = setInterval(loadWebcams, WEBCAM_REFRESH_MS);
    _clickHandler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!isPointerFree() || !_enabled) return;
      const picked = _viewer.scene.pick(click.position);
      const id = picked?.id?.id;
      if (typeof id !== 'string' || !id.startsWith(WEBCAM_PREFIX)) return;
      const cam = _webcams.find((w) => `${WEBCAM_PREFIX}${w.id}` === id);
      if (cam) openCard(cam);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeWebcamInteraction() {
    _removeMoveEnd?.();
    _removeMoveEnd = null;
    clearTimeout(_webcamTimer);
    clearInterval(_webcamRefresh);
    _webcamRefresh = null;
    _webcamRequest?.abort();
    _webcamRequest = null;
    _clickHandler?.destroy();
    _clickHandler = null;
    picking?.unregisterPickOwner('family');
    closeCard();
    _webcams = [];
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
      installWebcamInteraction();
      scheduleWebcams();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      removeWebcamInteraction();
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
        _snapshot = snapshot;
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
      removeWebcamInteraction();
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
