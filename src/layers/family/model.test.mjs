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
