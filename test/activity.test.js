'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Activity } = require('../lib/activity');

test('motion per hour: starts, seconds across hours, summary and chart', () => {
  let now = Date.parse('2026-10-14T05:59:00Z'); // 07:59 in Stockholm
  const a = new Activity({ now: () => now, timeZone: 'Europe/Stockholm' });
  a.start();
  a.start(); // already on: not counted again
  now += 120000; // until 08:01
  a.stop();
  now += 60000;
  a.start();
  now += 30000;
  a.stop();
  assert.deepStrictEqual(a.history, { '2026-10-14T07': { n: 1, s: 60 }, '2026-10-14T08': { n: 1, s: 90 } });
  const s = a.summary('today');
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.seconds, 150);
  assert.deepStrictEqual(s.busiest, { hour: '07', count: 1 });
  const day = a.series('day');
  assert.deepStrictEqual(day.totals, { motion: 2 });
  assert.deepStrictEqual(day.series.motion.slice(-2), [1, 1]);
  assert.strictEqual(day.usual, null);
});

test('unusual motion at a quiet hour, after a week', () => {
  const history = {};
  for (let d = 1; d <= 8; d++) history[`2026-10-${String(d).padStart(2, '0')}T12`] = { n: 4, s: 100 };
  let now = Date.parse('2026-10-09T01:00:00Z'); // 03:00 Stockholm
  const unusual = [];
  const a = new Activity({
    history, now: () => now, timeZone: 'Europe/Stockholm', onUnusual: (u) => unusual.push(u),
  });
  assert.strictEqual(a.usual('12'), 4);
  a.start();
  now += 1000;
  a.stop();
  assert.deepStrictEqual(unusual, [{ count: 1, usual: 0, hour: '03' }]);
  a.start();
  a.stop();
  assert.strictEqual(unusual.length, 1);
});
