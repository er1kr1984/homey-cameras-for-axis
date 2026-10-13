'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Tracker, categoryOf } = require('../lib/tracker');

test('categories from the camera\'s object types', () => {
  assert.strictEqual(categoryOf('Human'), 'person');
  assert.strictEqual(categoryOf('Car'), 'car');
  assert.strictEqual(categoryOf('Truck'), 'truck');
  assert.strictEqual(categoryOf('Bus'), 'bus');
  assert.strictEqual(categoryOf('Bike'), 'bicycle');
  assert.strictEqual(categoryOf('Bicycle'), 'bicycle');
  assert.strictEqual(categoryOf('MotorCycle'), 'motorcycle');
  assert.strictEqual(categoryOf('Vehicle'), 'vehicle');
  assert.strictEqual(categoryOf('Face'), null);
  assert.strictEqual(categoryOf('LicensePlate'), null);
});

test('each object counted once, only after a confident classification in 2 frames', () => {
  let now = Date.parse('2026-10-13T10:15:00Z');
  const counted = [];
  const tr = new Tracker({ now: () => now, timeZone: 'Europe/Stockholm', onCounted: (o) => counted.push(o) });
  tr.addFrame({ objects: [{ id: '1', type: null, likelihood: 0, colors: [] }] }); // tracked, not yet classified
  tr.addFrame({ objects: [{ id: '1', type: 'Human', likelihood: 0.3, colors: [] }] }); // not confident
  assert.strictEqual(counted.length, 0);
  tr.addFrame({ objects: [{ id: '1', type: 'Human', likelihood: 0.9, colors: ['red'] }] });
  tr.addFrame({ objects: [{ id: '1', type: 'Human', likelihood: 0.9, colors: [] }, { id: '2', type: 'Car', likelihood: 0.8, colors: ['white'] }] });
  assert.deepStrictEqual(counted.map((o) => o.category), ['person']);
  assert.deepStrictEqual(counted[0].colors, ['red']);
  for (let i = 0; i < 5; i++) tr.addFrame({ objects: [{ id: '1', type: 'Human', likelihood: 0.9 }, { id: '2', type: 'Car', likelihood: 0.8 }] });
  assert.deepStrictEqual(counted.map((o) => o.category), ['person', 'car'], 'no double counting');
  // The camera deletes the car; a new car with a new id is counted again.
  tr.addFrame({ objects: [], deleted: ['2'] });
  now += 3600000;
  tr.addFrame({ objects: [{ id: '3', type: 'Car', likelihood: 0.8 }] });
  tr.addFrame({ objects: [{ id: '3', type: 'Car', likelihood: 0.8 }] });
  assert.deepStrictEqual(tr.today(), { person: 1, car: 2 });
  const day = tr.series('day');
  assert.strictEqual(day.labels.length, 24);
  assert.strictEqual(day.labels[23], '13:00', 'local Stockholm hour (UTC+2)');
  assert.deepStrictEqual(day.series.car.slice(-2), [1, 1]);
  assert.deepStrictEqual(day.totals, { person: 1, car: 2 });
  assert.ok(!day.series.truck, 'categories never seen are left out');
  const week = tr.series('week');
  assert.strictEqual(week.labels.length, 7);
  assert.deepStrictEqual(week.series.person.slice(-1), [1]);
});
