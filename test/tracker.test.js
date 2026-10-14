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

const { directionOf } = require('../lib/tracker');

const box = (x, y) => ({
  x, y, w: 0.1, h: 0.2,
});

test('direction, time in view and the heatmap of a person walking past', () => {
  let now = Date.parse('2026-10-14T08:00:00Z');
  const gone = [];
  const dwell = [];
  const tr = new Tracker({
    now: () => now, timeZone: 'Europe/Stockholm', onGone: (o) => gone.push(o), onDwell: (o) => dwell.push(o.minutes),
  });
  for (let i = 0; i <= 10; i++) {
    tr.addFrame({ objects: [{ id: '7', type: 'Human', likelihood: 0.8, box: box(0.1 + i * 0.07, 0.5) }] });
    now += 15000; // 2.5 minutes in view
  }
  tr.addFrame({ objects: [], deleted: ['7'] });
  assert.deepStrictEqual(dwell, [1, 2]);
  assert.strictEqual(gone.length, 1);
  assert.strictEqual(gone[0].direction, 'right');
  assert.strictEqual(gone[0].seconds, 150);
  const s = tr.summary('today');
  assert.deepStrictEqual(s.totals, { person: 1 });
  assert.deepStrictEqual(s.directions, { person: { right: 1 } });
  assert.deepStrictEqual(s.longest, { category: 'person', seconds: 150 });
  assert.deepStrictEqual(s.busiest, { hour: '10', count: 1 });
  const heat = tr.heatmap('people');
  assert.strictEqual(heat.cells.length, heat.w * heat.h);
  assert.ok(heat.cells.filter(Boolean).length >= 8, 'one cell per place passed');
  assert.ok(heat.cells.every((v) => v <= 1), 'standing still does not add up');
  assert.strictEqual(tr.heatmap('vehicles').cells.filter(Boolean).length, 0);
});

test('directions need real movement', () => {
  assert.strictEqual(directionOf({ x: 0.5, y: 0.5 }, { x: 0.55, y: 0.52 }), null);
  assert.strictEqual(directionOf({ x: 0.8, y: 0.5 }, { x: 0.2, y: 0.6 }), 'left');
  assert.strictEqual(directionOf({ x: 0.5, y: 0.2 }, { x: 0.55, y: 0.9 }), 'down');
  assert.strictEqual(directionOf({ x: 0.5, y: 0.9 }, { x: 0.5, y: 0.1 }), 'up');
});

test('unusual activity: only with a week of history, at quiet hours or clearly busier', () => {
  const day0 = Date.parse('2026-10-01T10:00:00Z'); // 12:00 in Stockholm
  const history = {};
  // Ten days with 2 people at 12:00 and nobody at 03:00.
  for (let d = 0; d < 10; d++) {
    const date = new Date(day0 + d * 86400000).toISOString().slice(0, 10);
    history[`${date}T12`] = { person: 2 };
  }
  let now = day0 + 10 * 86400000;
  const unusual = [];
  const tr = new Tracker({
    history, now: () => now, timeZone: 'Europe/Stockholm', onUnusual: (u) => unusual.push(u),
  });
  assert.strictEqual(tr.usual('12', 'people'), 2);
  assert.strictEqual(tr.usual('03', 'people'), 0);
  const person = (id) => {
    tr.addFrame({ objects: [{ id, type: 'Human', likelihood: 0.9 }] });
    tr.addFrame({ objects: [{ id, type: 'Human', likelihood: 0.9 }] });
  };
  for (let i = 0; i < 6; i++) person(`a${i}`);
  assert.strictEqual(unusual.length, 0, '6 is not clearly more than 2');
  person('a6');
  assert.deepStrictEqual(unusual, [{
    group: 'people', count: 7, usual: 2, hour: '12',
  }]);
  person('a7');
  assert.strictEqual(unusual.length, 1, 'once per hour');
  now = Date.parse('2026-10-11T01:30:00Z'); // 03:30 in Stockholm
  person('night');
  assert.strictEqual(unusual.length, 2);
  assert.strictEqual(unusual[1].hour, '03');
  const day = tr.series('day');
  assert.strictEqual(day.usual.length, 24);
  assert.strictEqual(day.usual[day.labels.indexOf('12:00')], 2);
  // Without a week of history nothing is unusual.
  const fresh = new Tracker({ now: () => now, timeZone: 'Europe/Stockholm', onUnusual: (u) => unusual.push(u) });
  fresh.addFrame({ objects: [{ id: 'x', type: 'Human', likelihood: 0.9 }] });
  fresh.addFrame({ objects: [{ id: 'x', type: 'Human', likelihood: 0.9 }] });
  assert.strictEqual(unusual.length, 2);
  assert.strictEqual(fresh.series('day').usual, null);
});

test('the close-up arriving after counting is passed on', () => {
  const images = [];
  const tr = new Tracker({ timeZone: 'UTC', onImage: (o) => images.push(o.id) });
  tr.addFrame({ objects: [{ id: '1', type: 'Car', likelihood: 0.9 }] });
  tr.addFrame({ objects: [{ id: '1', type: 'Car', likelihood: 0.9 }] });
  tr.addFrame({ objects: [{ id: '1', type: 'Car', likelihood: 0.9, image: '/9j/abc' }] });
  assert.deepStrictEqual(images, ['1']);
  assert.deepStrictEqual(tr.inView(), { car: 1 });
});
