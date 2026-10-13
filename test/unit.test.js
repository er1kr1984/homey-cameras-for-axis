'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseChallenges, pickChallenge, DigestSession,
} = require('../lib/digest');
const events = require('../lib/events-map');
const { parseEventInstances } = require('../lib/vapix');
const { parseSdp } = require('../lib/rtsp');
const { pickResolution, nalTypes, stapA } = require('../lib/rtsp-upstream');
const { EVENT_INSTANCES, SPS, PPS } = require('./fake-camera');

test('digest: RFC 2617 example answer', () => {
  const [challenge] = parseChallenges('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  const d = new DigestSession(challenge, 'Mufasa', 'Circle Of Life');
  d.cnonce = '0a4f113b';
  const header = d.header('GET', '/dir/index.html');
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /nc=00000001/);
  assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
});

test('digest: several challenges, strongest wins, Basic only when allowed', () => {
  const values = [
    'Digest realm="AXIS_X", nonce="a", algorithm=MD5, qop="auth"',
    'Digest realm="AXIS_X", nonce="b", algorithm=SHA-256, qop="auth"',
    'Basic realm="AXIS_X"',
  ];
  const all = parseChallenges(values);
  assert.strictEqual(all.length, 3);
  assert.strictEqual(pickChallenge(all, true).params.algorithm, 'SHA-256');
  assert.strictEqual(pickChallenge([all[2]], false), null);
  assert.strictEqual(pickChallenge([all[2]], true).scheme, 'basic');
  // Two challenges joined in one header value.
  const joined = parseChallenges('Digest realm="r, x", nonce="n", qop="auth", Basic realm="r"');
  assert.deepStrictEqual(joined.map((c) => c.scheme), ['digest', 'basic']);
  assert.strictEqual(joined[0].params.realm, 'r, x');
});

test('events: topics are classified regardless of namespace prefix', () => {
  assert.strictEqual(events.classify('tns1:VideoSource/MotionAlarm'), 'motion');
  assert.strictEqual(events.classify('tnsaxis:CameraApplicationPlatform/VMD/Camera1Profile1'), 'motion');
  assert.strictEqual(events.classify('axis:CameraApplicationPlatform/VMD/Camera1ProfileANY'), 'motion');
  assert.strictEqual(events.classify('tnsaxis:CameraApplicationPlatform/ObjectAnalytics/Device1Scenario2'), 'analytics');
  assert.strictEqual(events.classify('tns1:VideoSource/tnsaxis:Tampering'), 'tampering');
  assert.strictEqual(events.classify('tns1:VideoSource/tnsaxis:DayNightVision'), 'daynight');
  assert.strictEqual(events.classify('tns1:Device/tnsaxis:IO/Port'), 'input');
  assert.strictEqual(events.classify('tns1:Device/tnsaxis:IO/VirtualInput'), 'input');
  assert.strictEqual(events.classify('tns1:AudioSource/tnsaxis:TriggerLevel'), 'audio');
  assert.strictEqual(events.classify('tns1:Device/tnsaxis:Status/SystemReady'), null);
  assert.strictEqual(events.classify('tnsaxis:CameraApplicationPlatform/ObjectAnalytics/xinternal_data'), null);
});

test('events: on/off values and source keys', () => {
  assert.strictEqual(events.stateOf({ data: { State: '1' } }), true);
  assert.strictEqual(events.stateOf({ data: { active: '0' } }), false);
  assert.strictEqual(events.stateOf({ data: { day: 'false' } }), false);
  assert.strictEqual(events.stateOf({ data: {} }), null);
  assert.strictEqual(events.sourceKey({ topic: 'tns1:Device/tnsaxis:IO/Port', source: { port: '1' } }), 'Device/IO/Port|port=1');
});

test('event instances: parsed from GetEventInstances and turned into one filter', () => {
  const list = parseEventInstances(EVENT_INSTANCES);
  const topics = list.map((i) => i.topic);
  assert.ok(topics.includes('tns1:VideoSource/MotionAlarm'));
  assert.ok(topics.includes('tns1:VideoSource/tnsaxis:Tampering'));
  assert.ok(topics.includes('tnsaxis:CameraApplicationPlatform/ObjectAnalytics/Device1Scenario1'));
  assert.ok(topics.includes('tns1:Device/tnsaxis:IO/Port'));
  const motion = list.find((i) => i.topic === 'tns1:VideoSource/MotionAlarm');
  assert.strictEqual(motion.stateful, true);
  assert.deepStrictEqual(motion.data, ['State']);
  assert.strictEqual(list.find((i) => i.topic.endsWith('Tampering')).stateful, false);
  assert.strictEqual(list.find((i) => i.topic.endsWith('Device1Scenario1')).name, 'Driveway');
  const filter = events.topicFilter(list);
  assert.ok(filter.includes('tns1:VideoSource/MotionAlarm'));
  assert.ok(!filter.includes('SystemReady'), 'topics the app does not use are left out');
  assert.deepStrictEqual(events.analyticsScenarios(list), [{ topic: 'CameraApplicationPlatform/ObjectAnalytics/Device1Scenario1', name: 'Driveway' }]);
});

test('sdp: control URLs and parameter sets', () => {
  const sdp = ['v=0', 'a=control:*', 'm=audio 0 RTP/AVP 97', 'a=control:stream=1', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000',
    `a=fmtp:96 packetization-mode=1;profile-level-id=4D0029;sprop-parameter-sets=${SPS.toString('base64')},${PPS.toString('base64')}`,
    'a=control:stream=0'].join('\r\n');
  const s = parseSdp(sdp, 'rtsp://cam/axis-media/media.amp?videocodec=h264/');
  assert.strictEqual(s.codec, 'H264');
  assert.strictEqual(s.payloadType, 96);
  assert.strictEqual(s.control, 'rtsp://cam/axis-media/media.amp?videocodec=h264/stream=0');
  assert.strictEqual(s.profileLevelId, '4d0029');
  assert.deepStrictEqual(s.parameterSets, [SPS, PPS]);
});

test('resolution: largest fitting the level, same aspect as the sensor', () => {
  const res = ['2592x1944', '1920x1080', '1280x960', '1280x720', '800x600', '640x480', '640x360'];
  assert.strictEqual(pickResolution(res, 'low'), '640x480');
  assert.strictEqual(pickResolution(res, 'medium'), '1280x960');
  assert.strictEqual(pickResolution(['1920x1080', '1280x720', '640x360'], 'high'), '1920x1080');
  assert.strictEqual(pickResolution([], 'low'), null);
  assert.strictEqual(pickResolution(['3840x2160'], 'low'), '3840x2160');
});

test('h264: NAL types and STAP-A packing', () => {
  const packed = stapA([SPS, PPS]);
  assert.strictEqual(packed[0] & 0x1f, 24);
  assert.deepStrictEqual(nalTypes(packed), [7, 8]);
  assert.deepStrictEqual(nalTypes(Buffer.from([0x7c, 0x85, 0])), [5]);
  assert.deepStrictEqual(nalTypes(Buffer.from([0x7c, 0x05, 0])), []);
  assert.deepStrictEqual(nalTypes(Buffer.from([0x41, 0])), [1]);
});
