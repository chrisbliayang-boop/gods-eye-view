import test from 'node:test';
import assert from 'node:assert/strict';
import {
  familyFlightLegs,
  familyLabel,
  formatAgo,
  isFamilyPointStale,
} from './model.js';
import {
  parseFamilyTrail,
  publicFamilyPerson,
} from '../../../server/providers/family.js';

const NOW = Date.parse('2026-10-17T05:00:00Z');

test('labels show name, age and battery', () => {
  assert.equal(formatAgo(NOW - 20_000, NOW), 'just now');
  assert.equal(formatAgo(NOW - 12 * 60_000, NOW), '12 min ago');
  assert.equal(formatAgo(NOW - 3 * 3_600_000, NOW), '3 h ago');
  assert.deepEqual(
    familyLabel('Dad', { receivedAt: NOW - 5 * 60_000, battery: 53 }, NOW),
    { title: 'Dad', detail: '5 min ago · 53%' },
  );
  assert.deepEqual(familyLabel('Dad', null, NOW), {
    title: 'Dad',
    detail: 'no location yet',
  });
  assert.equal(isFamilyPointStale({ receivedAt: NOW - 3 * 3_600_000 }, NOW), true);
  assert.equal(isFamilyPointStale({ receivedAt: NOW - 60_000 }, NOW), false);
});

test('flight legs need both airports known', () => {
  const legs = familyFlightLegs([
    { flight: 'AA 3133', from: 'MSP', to: 'DFW' },
    { flight: 'XX 1', from: 'MSP', to: 'ZZZ' },
  ]);
  assert.deepEqual(legs.map((l) => l.flight), ['AA 3133']);
});

test('trail keeps the window, dedupes repeated fixes, keeps the latest', () => {
  const line = (lat, minutesAgo) =>
    JSON.stringify({
      lat,
      lon: -93,
      battery: 50,
      received_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
    });
  const text = [line(44.0, 3000), line(44.1, 30), line(44.1, 15), line(44.2, 1), 'not json'].join('\n');
  const { latest, trail } = parseFamilyTrail(text, NOW - 24 * 3_600_000);
  assert.equal(latest.lat, 44.2);
  assert.deepEqual(trail.map((p) => p.lat), [44.1, 44.2]);
  const old = parseFamilyTrail(line(44.0, 3000), NOW - 24 * 3_600_000);
  assert.equal(old.latest.lat, 44.0);
  assert.equal(old.trail.length, 0);
});

test('config view never exposes credentials', () => {
  const person = publicFamilyPerson(
    { people: [{ id: 'dad', name: 'Dad', password: 'secret', username: 'dad',
      flights: [{ flight: 'CX 653', from: 'HKG', to: 'BKK', depart: '2026-11-03 12:00' }] }] },
    'dad',
  );
  assert.equal(JSON.stringify(person).includes('secret'), false);
  assert.equal(person.name, 'Dad');
  assert.equal(person.flights[0].flight, 'CX 653');
});

test('plane label shows flight, altitude and speed', async () => {
  const { planeLabel } = await import('./model.js');
  assert.equal(
    planeLabel({ flight: 'CX 891', altitudeFt: 35000, groundSpeedKt: 488.6 }),
    'CX 891 · 35,000 ft · 489 kt',
  );
  assert.equal(planeLabel({ flight: 'CX 653', onGround: true }), 'CX 653 · on the ground');
});

test('flight windows use each airport\'s local time, across the US DST change', async () => {
  const { airportLocalToUtcMs, activeFlightLegs, callsignCandidates } = await import(
    '../../../server/providers/family/plane.js'
  );
  assert.equal(
    new Date(airportLocalToUtcMs('2026-11-01 18:48', 'MSP')).toISOString(),
    '2026-11-02T00:48:00.000Z',
  );
  assert.equal(
    new Date(airportLocalToUtcMs('2026-11-03 06:15', 'HKG')).toISOString(),
    '2026-11-02T22:15:00.000Z',
  );
  const legs = [
    { flight: 'CX 891', from: 'DFW', to: 'HKG', depart: '2026-11-01 23:30', arrive: '2026-11-03 06:15' },
  ];
  assert.equal(activeFlightLegs(legs, Date.parse('2026-11-02T12:00:00Z')).length, 1);
  assert.equal(activeFlightLegs(legs, Date.parse('2026-10-20T12:00:00Z')).length, 0);
  assert.deepEqual(callsignCandidates('CX 891'), ['CPA891']);
  assert.equal(callsignCandidates('AA 3133')[0], 'AAL3133');
});

test('camera nodes keep position and type only', async () => {
  const { normalizeCameraNodes } = await import('../../../server/providers/family/cameras.js');
  assert.deepEqual(
    normalizeCameraNodes({
      elements: [
        { type: 'node', id: 1, lat: 13.7, lon: 100.5, tags: { 'surveillance:type': 'camera', name: 'x' } },
        { type: 'node', id: 3, lat: 13.8, lon: 100.6, tags: { highway: 'speed_camera' } },
        { type: 'way', id: 2 },
      ],
    }),
    [
      { id: 1, type: 'security', lat: 13.7, lon: 100.5, kind: 'camera', zone: null, operator: null },
      { id: 3, type: 'speed', lat: 13.8, lon: 100.6, kind: null, zone: null, operator: null },
    ],
  );
  assert.equal(normalizeCameraNodes({}), null);
});

test('webcam view areas snap so nearby views share a call', async () => {
  const { webcamViewArea } = await import('../../../server/providers/family/webcams.js');
  const a = webcamViewArea(13.7462, 100.5347, 12);
  assert.equal(a.radiusKm, 15);
  assert.deepEqual(webcamViewArea(13.747, 100.535, 11), a);
  assert.equal(webcamViewArea(95, 0, 5), null);
  assert.equal(webcamViewArea(1, 1, 0), null);
  assert.equal(webcamViewArea('x', 1, 5), null);
  assert.equal(webcamViewArea(1, 1, 9_999).radiusKm, 250);
});

test('webcams: live vs snapshot, key from file, cached per area', async () => {
  const { createFamilyWebcamStore, normalizeWebcam } = await import(
    '../../../server/providers/family/webcams.js'
  );
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  assert.equal(normalizeWebcam({ location: {} }), null);

  const off = createFamilyWebcamStore({ env: {}, fetchImpl: () => assert.fail('no call') });
  assert.deepEqual(await off.get(1, 2, 3), { enabled: false, webcams: [] });

  const dir = await mkdtemp(path.join(tmpdir(), 'gev-webcams-'));
  const keyFile = path.join(dir, 'key.json');
  await writeFile(keyFile, JSON.stringify({ windy_key: 'k', links: [] }));
  const calls = [];
  const store = createFamilyWebcamStore({
    env: { FAMILY_WEBCAMS_KEY_FILE: keyFile },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), key: init.headers['x-windy-api-key'] });
      return new Response(JSON.stringify({ total: 2, webcams: [
        { webcamId: 7, title: 'Beach', location: { latitude: 12.9, longitude: 100.8 },
          player: { live: 'https://w/live' }, images: { current: { preview: 'https://i/p.jpg' } } },
        { webcamId: 8, title: 'Temple', location: { latitude: 18.8, longitude: 98.9 },
          player: { day: 'https://w/day' } },
      ] }));
    },
  });
  const first = await store.get(13.7462, 100.5347, 12);
  await store.get(13.747, 100.535, 11);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'k');
  assert.match(calls[0].url, /nearby=13\.\d+%2C100\.\d+%2C15/);
  assert.deepEqual(
    first.webcams.map((w) => [w.id, w.live, w.watch]),
    [['7', true, 'https://w/live'], ['8', false, 'https://w/day']],
  );
});
