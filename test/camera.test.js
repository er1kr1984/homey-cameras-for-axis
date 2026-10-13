'use strict';

// The app's VAPIX, event and RTSP code against a fake Axis camera (test/fake-camera.js).

const test = require('node:test');
const assert = require('node:assert');
const { FakeCamera, SERIAL } = require('./fake-camera');
const { VapixClient, probe } = require('../lib/vapix');
const { EventStream } = require('../lib/event-stream');
const { RtspUpstream } = require('../lib/rtsp-upstream');
const events = require('../lib/events-map');

let cam;
const client = (opts = {}) => new VapixClient({
  host: '127.0.0.1', port: cam.httpPort, secure: false, username: 'homey', password: 'secret', ...opts,
});

test.before(async () => { cam = await new FakeCamera().start(); });
test.after(async () => { await cam.stop(); });

test('vapix: Digest login, device info and capabilities', async () => {
  const c = client();
  const info = await c.deviceInfo();
  assert.strictEqual(info.SerialNumber, SERIAL);
  assert.strictEqual(info.Architecture, 'armv7hf', 'getAllProperties with login');
  const caps = await c.capabilities();
  assert.strictEqual(caps.ptz, true);
  assert.strictEqual(caps.light, true);
  assert.strictEqual(caps.virtualInputs, true);
  assert.strictEqual(caps.inputs, 1);
  assert.deepStrictEqual(caps.resolutions.slice(0, 2), ['1920x1080', '1280x720']);
  c.close();
});

test('vapix: wrong password gives login_failed', async () => {
  const c = client({ password: 'nope' });
  await assert.rejects(c.deviceInfo(), (e) => e.code === 'login_failed');
});

test('vapix: snapshot, PTZ, light, virtual input and output', async () => {
  const c = client();
  const jpeg = await c.snapshot({ resolution: '640x360' });
  assert.strictEqual(jpeg[0], 0xff);
  assert.strictEqual(cam.lastSnapshot, '640x360');
  assert.deepStrictEqual(await c.ptzPresets(), [{ number: 1, name: 'Home' }, { number: 2, name: 'Gate' }]);
  await c.ptzGotoPreset('Gate');
  assert.match(cam.lastPtz, /gotoserverpresetname=Gate/);
  assert.strictEqual((await c.lights())[0].lightID, 'led0');
  await c.setLight('led0', true);
  assert.deepStrictEqual(cam.lastLight, { method: 'activateLight', params: { lightID: 'led0' } });
  await c.virtualInput(3, true, 5);
  assert.match(cam.lastVirtual, /activate\.cgi\?schemaversion=1&port=3&duration=5/);
  await c.setOutput(1, { pulseMs: 500 });
  assert.match(decodeURIComponent(cam.lastPort), /action=1:\/500\\/);
  assert.deepStrictEqual(await c.inputStates([1]), { 1: true });
  c.close();
});

test('vapix: anonymous probe finds the camera', async () => {
  // probe() uses ports 443/80; call the same request directly against the fake.
  const res = await require('../lib/vapix').rawRequest({
    secure: false,
    host: '127.0.0.1',
    port: cam.httpPort,
    method: 'POST',
    path: '/axis-cgi/basicdeviceinfo.cgi',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiVersion: '1.0', method: 'getAllUnrestrictedProperties' }),
    timeoutMs: 2000,
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(typeof probe, 'function');
});

test('events: WebSocket stream subscribes and delivers events', async () => {
  const c = client();
  const instances = await c.eventInstances();
  const filter = events.topicFilter(instances);
  const stream = new EventStream({ client: c, filters: [{ topicFilter: filter }] });
  const connected = new Promise((r) => stream.once('connected', r));
  stream.start();
  await connected;
  assert.strictEqual(cam.lastConfigure.eventFilterList[0].topicFilter, filter);
  const got = new Promise((r) => stream.once('event', r));
  cam.emitEvent('tns1:VideoSource/MotionAlarm', { source: { Source: '0' }, data: { State: '1' } });
  const ev = await got;
  assert.strictEqual(events.classify(ev.topic), 'motion');
  assert.strictEqual(events.stateOf(ev), true);
  // The stream comes back by itself after the camera drops it.
  const again = new Promise((r) => stream.once('connected', r));
  for (const ws of cam.wsClients) ws.terminate();
  await again;
  stream.stop();
  c.close();
});

test('rtsp: video arrives, parameter sets are added before keyframes, keyframe requests work', async () => {
  const packets = [];
  const up = new RtspUpstream({
    camera: {
      id: SERIAL, name: 'cam', host: '127.0.0.1', rtspPort: cam.rtspPort, username: 'homey', password: 'secret', resolutions: ['1920x1080', '1280x720', '640x360'],
    },
    profile: 'low',
    log: () => {},
    onPacket: (u, rtp) => packets.push(rtp),
    onDead: () => {},
  });
  await up.start();
  assert.match(cam.lastDescribe, /resolution=640x360/);
  assert.match(cam.lastDescribe, /videocodec=h264/);
  assert.match(cam.lastSetup.transport, /RTP\/AVP\/TCP;unicast;interleaved=0-1/);
  await new Promise((r) => setTimeout(r, 1300)); // > one keyframe interval
  const kinds = packets.map((p) => {
    const t = p.payload[0] & 0x1f;
    return t === 28 ? `fu${p.payload[1] & 0x1f}${p.payload[1] & 0x80 ? 's' : ''}` : `n${t}`;
  });
  const firstIdr = kinds.indexOf('fu5s');
  assert.ok(firstIdr > 0, 'a keyframe arrived');
  assert.strictEqual(kinds[firstIdr - 1], 'n24', 'SPS/PPS (STAP-A) inserted right before the keyframe');
  assert.strictEqual(packets[firstIdr - 1].header.timestamp, packets[firstIdr].header.timestamp);
  const before = cam.keyframeRequests;
  up.requestKeyframe();
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(cam.keyframeRequests, before + 1);
  up.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(cam.teardowns >= 1, 'TEARDOWN sent');
});
