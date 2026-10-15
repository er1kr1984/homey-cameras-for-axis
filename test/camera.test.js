'use strict';

// The app's VAPIX, event and RTSP code against a fake Axis camera (test/fake-camera.js).

const test = require('node:test');
const assert = require('node:assert');
const { FakeCamera, SERIAL } = require('./fake-camera');
const { VapixClient, probe } = require('../lib/vapix');
const { EventStream } = require('../lib/event-stream');
const { RtspUpstream } = require('../lib/rtsp-upstream');
const events = require('../lib/events-map');
const { RtspEventStream } = require('../lib/rtsp-events');

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
  assert.match(cam.lastDescribe, /videobitratemode=mbr&videomaxbitrate=500/);
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

test('events over RTSP (AXIS OS 9): metadata documents across packets become events', async () => {
  const topics = events.usedTopics(await client().eventInstances());
  const stream = new RtspEventStream({
    camera: { host: '127.0.0.1', rtspPort: cam.rtspPort, username: 'homey', password: 'secret' }, topics,
  });
  const got = [];
  stream.on('event', (e) => got.push(e));
  const connected = new Promise((r) => stream.once('connected', r));
  stream.start();
  await connected;
  assert.match(decodeURIComponent(cam.lastEventDescribe), /video=0&audio=0&event=on&eventtopic=onvif:VideoSource\/MotionAlarm\|/);
  assert.match(decodeURIComponent(cam.lastEventDescribe), /axis:CameraApplicationPlatform\/ObjectAnalytics\/Device1Scenario1/);
  await new Promise((r) => setTimeout(r, 200));
  cam.emitMetadata('tns1:VideoSource/MotionAlarm', { Source: '0' }, { State: 'true' });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].operation, 'Initialized');
  assert.strictEqual(events.stateOf(got[0]), false);
  assert.strictEqual(got[1].topic, 'tns1:VideoSource/MotionAlarm');
  assert.strictEqual(events.classify(got[1].topic), 'motion');
  assert.strictEqual(events.stateOf(got[1]), true);
  assert.deepStrictEqual(got[1].source, { Source: '0' });
  stream.stop();
});

test('rtsp: a camera that refuses the bitrate cap streams without it', async () => {
  cam.refuseBitrateCap = /videomaxbitrate/;
  const camera = {
    id: 'OLDCAM', name: 'cam', host: '127.0.0.1', rtspPort: cam.rtspPort, username: 'homey', password: 'secret', resolutions: ['640x360'],
  };
  const up = new RtspUpstream({
    camera, profile: 'low', log: () => {}, onPacket: () => {}, onDead: () => assert.fail('not dead'),
  });
  await up.start();
  assert.doesNotMatch(cam.lastDescribe, /videomaxbitrate/);
  up.close();
  cam.refuseBitrateCap = null;
});

test('vapix: privacy mode, sound clips, siren, restart, text, temperature, memory card, Object Analytics', async () => {
  const c = client();
  assert.strictEqual(await c.privacyMode(), false);
  await c.setPrivacyMode(true);
  assert.match(cam.lastMask, /action=add&name=Homey\+privacy\+mode&width=100\.0&height=100\.0&center=50\.0%2C50\.0/);
  assert.strictEqual(await c.privacyMode(), true);
  await c.setPrivacyMode(false);
  assert.match(cam.lastMask, /action=remove/);
  assert.strictEqual(await c.privacyMode(), false);

  assert.deepStrictEqual(await c.mediaClips(), [{ id: 0, name: 'Warning' }, { id: 1, name: 'Dog barking' }]);
  await c.playClip(1, { volume: 60 });
  assert.strictEqual(cam.lastClip, '?action=play&clip=1&volume=60');

  assert.deepStrictEqual((await c.sirenProfiles()).map((p) => p.name), ['Profile 1', 'Profile 2']);
  await c.startSiren('Profile 1');
  assert.deepStrictEqual(cam.lastSiren, { method: 'start', params: { profile: 'Profile 1' } });
  await c.stopSiren();
  assert.deepStrictEqual(cam.lastSiren.params, { all: ['siren', 'light'] });

  await c.restart();
  assert.strictEqual(cam.lastFirmware, 'reboot');

  assert.strictEqual(await c.showText('Away mode', { position: 'bottomLeft' }), 7);
  assert.strictEqual(cam.lastOverlay.method, 'addText');
  assert.strictEqual(cam.lastOverlay.params.text, 'Away mode');
  await c.showText('Home', { id: 7 });
  assert.deepStrictEqual(cam.lastOverlay, { method: 'setText', params: { identity: 7, text: 'Home', position: 'topLeft' } });
  await c.showText('Old camera', { dynamic: false });
  assert.deepStrictEqual(cam.lastParamUpdate, { 'Image.I0.Text.TextEnabled': 'yes', 'Image.I0.Text.String': 'Old camera' });
  const own = await c.textSettings();
  assert.deepStrictEqual(own, { enabled: 'yes', string: 'Garage' });
  await c.restoreTextSettings(own);
  assert.deepStrictEqual(cam.lastParamUpdate, { 'Image.I0.Text.TextEnabled': 'yes', 'Image.I0.Text.String': 'Garage' });

  const t = await c.temperatures();
  assert.deepStrictEqual(t.sensors.map((x) => [x.name, x.celsius]), [['Main', 43.5], ['CPU', 50.44]]);
  assert.deepStrictEqual(t.heaters, [{ id: 0, running: true }]);
  const [sd] = await c.disks();
  assert.deepStrictEqual([sd.id, sd.status, sd.totalKB, sd.freeKB], ['SD_DISK', 'OK', 31154688, 7788672]);

  assert.strictEqual((await c.aoa('getAccumulatedCounts', { scenario: 3 })).total, 7);
  assert.deepStrictEqual(cam.lastAoa.params, { scenario: 3 });
  const [producer] = await c.metadataProducers();
  assert.strictEqual(producer.name, 'AnalyticsSceneDescription');
  await c.enableMetadataProducer('AnalyticsSceneDescription');
  assert.deepStrictEqual(cam.lastProducers.params, { producers: [{ name: 'AnalyticsSceneDescription', videochannels: [{ channel: 1, enabled: true }] }] });
  c.close();
});

test('vapix: privacy mode on cameras without privacymask.cgi uses the mask parameters', async () => {
  cam.noPrivacyCgi = true;
  const c = client();
  try {
    assert.strictEqual(await c.privacyMode(), false);
    await c.setPrivacyMode(true, '1920x1080');
    assert.deepStrictEqual(cam.maskParams, {
      'Image.I0.Overlay.MaskWindows.M0.Enabled': 'yes',
      'Image.I0.Overlay.MaskWindows.M0.XPos': '0',
      'Image.I0.Overlay.MaskWindows.M0.YPos': '0',
      'Image.I0.Overlay.MaskWindows.M0.Width': '1920',
      'Image.I0.Overlay.MaskWindows.M0.Height': '1080',
      'Image.I0.Overlay.MaskWindows.M0.Name': 'Homey privacy mode',
    });
    assert.strictEqual(await c.privacyMode(), true);
    await c.setPrivacyMode(false);
    assert.deepStrictEqual(cam.lastParamUpdate, { 'Image.I0.Overlay.MaskWindows.M0.Enabled': 'no' });
  } finally {
    cam.noPrivacyCgi = false;
    c.close();
  }
});

test('vapix: power use (Power settings API) and recorder PoE ports (NVR PoE API)', async () => {
  const c = client();
  assert.deepStrictEqual(await c.powerStatus(), {
    current: 6.2, average: 5.9, max: null, poeClass: 4, requested: 12.95,
  });
  assert.strictEqual(cam.lastPower, 'getPowerStatus');
  const ports = await c.poePorts();
  assert.deepStrictEqual(ports.map((p) => [p.port, p.connected, p.watts, p.status]), [[1, true, 3.4, 'Connected - PoE'], [2, false, 0, 'Disconnected']]);
  assert.strictEqual(await c.poeLimit(), 65);
  c.close();
});

test('vapix: identify tells a wrong password from too few rights', async () => {
  await assert.rejects(client({ password: 'nope' }).identify(), (e) => e.code === 'login_failed');
  cam.viewerOnly = true;
  try {
    const c = client();
    await assert.rejects(c.deviceInfo(), (e) => e.code === 'login_failed');
    const info = await c.identify();
    assert.strictEqual(info.limitedRights, true);
    assert.strictEqual(info.ProdType, 'Network Camera');
    const caps = await c.capabilities();
    assert.strictEqual(caps.propsRead, false, 'unread properties are not "no image"');
    c.close();
  } finally {
    cam.viewerOnly = false;
  }
});

test('vapix: after a confirmed wrong password nothing is sent until the lock ends', async () => {
  const c = client({ password: 'nope' });
  await assert.rejects(c.identify(), (e) => e.code === 'login_failed');
  assert.ok(c.isLocked());
  const before = cam.calls.length;
  await assert.rejects(c.deviceInfo(), (e) => e.code === 'login_failed');
  await assert.rejects(c.identify(), (e) => e.code === 'login_failed');
  assert.strictEqual(cam.calls.length, before, 'no requests while locked');
  c.lockedUntil = 0;
  await assert.rejects(c.deviceInfo(), (e) => e.code === 'login_failed');
  assert.ok(cam.calls.length > before, 'tries again after the lock');
  c.close();
});

test('vapix: too few rights does not lock the client', async () => {
  cam.viewerOnly = true;
  try {
    const c = client();
    await c.identify();
    assert.ok(!c.isLocked());
    c.close();
  } finally {
    cam.viewerOnly = false;
  }
});

test('vapix: probe and client on a custom port', async () => {
  const r = await probe('127.0.0.1', 2000, cam.httpPort);
  assert.ok(r && r.info.SerialNumber === SERIAL && r.secure === false);
});
