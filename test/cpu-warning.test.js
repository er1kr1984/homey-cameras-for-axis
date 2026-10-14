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
  relay.onCpuWarning(1, 5);
  assert.deepStrictEqual([a.profile, b.profile, a.closed], ['low', 'medium', false]);
  assert.ok(relay.lowUntil > Date.now());
  relay.onCpuWarning(2, 5);
  assert.ok(a.closed && b.closed);
  relay.closeAll();
});
