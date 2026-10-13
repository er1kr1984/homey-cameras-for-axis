'use strict';

// End to end: fake camera -> RTSP -> live relay -> WebRTC viewer (werift, like Homey's app).

const test = require('node:test');
const assert = require('node:assert');
const { RTCPeerConnection, RTCRtpCodecParameters, useOPUS } = require('werift');
const { FakeCamera, SERIAL } = require('./fake-camera');
const LiveRelay = require('../lib/live-relay');
const { RtspUpstream } = require('../lib/rtsp-upstream');

async function viewer(relay, camera) {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [new RTCRtpCodecParameters({
        mimeType: 'video/H264', clockRate: 90000, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }], parameters: 'packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1',
      })],
      audio: [useOPUS()],
    },
  });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.addTransceiver('video', { direction: 'recvonly' });
  const stats = { rtp: 0, sps: 0, idr: 0 };
  pc.onTrack.subscribe((t) => t.onReceiveRtp.subscribe((rtp) => {
    stats.rtp += 1;
    const n = rtp.payload[0] & 0x1f;
    if (n === 24) stats.sps += 1;
    if (n === 28 && (rtp.payload[1] & 0x1f) === 5 && (rtp.payload[1] & 0x80)) stats.idr += 1;
  }));
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, 300));
  const { viewer: v, answerSdp } = await relay.openViewer({
    camera, mode: 'low', viewerOfferSdp: pc.localDescription.sdp,
  });
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  return { pc, v, stats };
}

test('two viewers share one RTSP stream and both get decodable video', { timeout: 30000 }, async () => {
  const cam = await new FakeCamera().start();
  const relay = new LiveRelay({ openUpstream: (opts) => new RtspUpstream(opts) });
  const camera = {
    id: SERIAL, name: 'cam', host: '127.0.0.1', rtspPort: cam.rtspPort, username: 'homey', password: 'secret', resolutions: ['1280x720', '640x360'],
  };
  try {
    const a = await viewer(relay, camera);
    await new Promise((r) => setTimeout(r, 1500));
    const b = await viewer(relay, camera);
    await new Promise((r) => setTimeout(r, 2500));
    assert.strictEqual(relay.streams.size, 1, 'one camera stream for both viewers');
    assert.strictEqual(cam.rtspSessions.size, 1, 'one RTSP connection to the camera');
    for (const [name, s] of [['first', a.stats], ['second', b.stats]]) {
      assert.ok(s.rtp > 20, `${name} viewer got video (${s.rtp} packets)`);
      assert.ok(s.idr >= 1, `${name} viewer got a keyframe`);
      assert.ok(s.sps >= 1, `${name} viewer got SPS/PPS`);
    }
    await a.pc.close();
    await b.pc.close();
  } finally {
    relay.closeAll();
    await new Promise((r) => setTimeout(r, 300));
    await cam.stop();
  }
});
