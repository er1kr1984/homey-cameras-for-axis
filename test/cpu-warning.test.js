'use strict';

const test = require('node:test');
const assert = require('node:assert');
const LiveRelay = require('../lib/live-relay');

function fakeStream(profile) {
  return {
    profile,
    closed: false,
    pending: false,
    switchProfile(p) { this.profile = p; return true; },
    close() { this.closed = true; },
  };
}

test('a Homey CPU warning steps every stream down, then closes them near the limit', () => {
  const relay = new LiveRelay({ openUpstream: () => null, log: () => {} });
  const a = fakeStream('medium');
  const b = fakeStream('high');
  relay.streams.set('a', a);
  relay.streams.set('b', b);
  relay.lastSetupAt = Date.now();
  relay.onCpuWarning(1, 5);
  assert.strictEqual(a.profile, 'medium', 'a warning while a viewer connects is ignored');
  relay.lastSetupAt = 0;
  relay.onCpuWarning(1, 5);
  assert.deepStrictEqual([a.profile, b.profile, a.closed], ['low', 'medium', false]);
  assert.ok(relay.lowUntil > Date.now());
  relay.onCpuWarning(2, 5);
  assert.ok(a.closed && b.closed);
  relay.closeAll();
});

test('an Auto stream goes up a level when Homey has room, not right after a warning', () => {
  const relay = new LiveRelay({ openUpstream: () => null, log: () => {} });
  const a = { ...fakeStream('low'), auto: true, viewers: new Set([1]) };
  relay.lowUntil = Date.now() + 60000;
  relay._stepUp([a], 5, Date.now());
  assert.strictEqual(a.profile, 'low', 'held low after a warning');
  relay.lowUntil = 0;
  relay._stepUp([a], 5, Date.now());
  assert.strictEqual(a.profile, 'medium');
  relay.lastSwitch = 0;
  relay._stepUp([a], 5, Date.now());
  assert.strictEqual(a.profile, 'medium', 'never above medium by itself');
  relay.closeAll();
});

test('a live view closes itself after the time limit', async () => {
  let closed = false;
  const v = new LiveRelay.ViewerSession({
    stream: { removeViewer() {} }, log: () => {}, maxMs: 50, onClose: () => { closed = true; },
  });
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(closed && v.closed);
});
