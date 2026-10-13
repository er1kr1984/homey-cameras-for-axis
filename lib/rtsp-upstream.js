'use strict';

// One camera stream at one quality level, read over RTSP, for the live relay.
//
// Quality levels map to a resolution the camera supports (from
// Properties.Image.Resolution): low <= 640 px wide, medium <= 1280, high <= 1920, at
// 15/15/25 fps. Many Axis cameras announce the H.264 parameter sets (SPS/PPS) only in
// the SDP; browsers need them in the stream before each keyframe, so they are inserted
// as a STAP-A packet in front of any keyframe that arrives without them.

const { RtpPacket } = require('werift');
const { RtspSession, streamUrl } = require('./rtsp');

const UPSTREAM_TIMEOUT_MS = 15000;

const LEVELS = {
  low: { maxWidth: 640, fps: 15 },
  medium: { maxWidth: 1280, fps: 15 },
  high: { maxWidth: 1920, fps: 25 },
};

function parseRes(r) {
  const m = /^(\d+)x(\d+)$/.exec(String(r).trim());
  return m ? { w: Number(m[1]), h: Number(m[2]), text: `${m[1]}x${m[2]}` } : null;
}

// The largest supported resolution no wider than the level allows, preferring the
// sensor's own aspect ratio (that of the largest resolution). null = camera default.
function pickResolution(resolutions, level) {
  const cap = (LEVELS[level] || LEVELS.medium).maxWidth;
  const all = (resolutions || []).map(parseRes).filter(Boolean).sort((a, b) => b.w * b.h - a.w * a.h);
  if (!all.length) return null;
  const aspect = all[0].w / all[0].h;
  const fits = all.filter((r) => r.w <= cap);
  if (!fits.length) return all[all.length - 1].text;
  const same = fits.filter((r) => Math.abs(r.w / r.h - aspect) < 0.02);
  return (same.length ? same : fits)[0].text;
}

function nalTypes(payload) {
  const type = payload[0] & 0x1f;
  if (type === 24) { // STAP-A
    const out = [];
    for (let o = 1; o + 2 < payload.length;) {
      const len = payload.readUInt16BE(o);
      out.push(payload[o + 2] & 0x1f);
      o += 2 + len;
    }
    return out;
  }
  if (type === 28) return (payload[1] & 0x80) ? [payload[1] & 0x1f] : []; // FU-A start
  return [type];
}

function stapA(nals) {
  const nri = Math.max(...nals.map((n) => n[0] & 0x60));
  const parts = [Buffer.from([0x18 | nri])];
  for (const n of nals) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(n.length);
    parts.push(len, n);
  }
  return Buffer.concat(parts);
}

class RtspUpstream {
  // camera: { id, name, host, rtspPort, username, password, resolutions }
  constructor({
    camera, profile, log, onPacket, onDead,
  }) {
    this.camera = camera;
    this.profile = profile;
    this.log = (...args) => log(`[${profile}]`, ...args);
    this.onPacket = onPacket;
    this.onDead = onDead;
    this.closed = false;
    this.packets = 0;
    this.lastSpsTimestamp = null;
  }

  async start() {
    const level = LEVELS[this.profile] || LEVELS.medium;
    const resolution = pickResolution(this.camera.resolutions, this.profile);
    const url = streamUrl(this.camera.host, this.camera.rtspPort, { resolution, fps: level.fps });
    let gotFirstPacket;
    const firstPacket = new Promise((resolve, reject) => {
      this.startTimer = setTimeout(() => reject(new Error('Timed out waiting for video from the camera')), UPSTREAM_TIMEOUT_MS);
      gotFirstPacket = () => { clearTimeout(this.startTimer); resolve(); };
    });
    firstPacket.catch(() => {});
    this.rtsp = new RtspSession({
      host: this.camera.host,
      port: this.camera.rtspPort,
      url,
      username: this.camera.username,
      password: this.camera.password,
      log: this.log,
      onRtp: (channel, buf) => {
        if (channel !== 0 || this.closed) return;
        let rtp;
        try {
          rtp = RtpPacket.deSerialize(buf);
        } catch (err) {
          return;
        }
        if (!rtp.payload || !rtp.payload.length) return;
        if (this.packets++ === 0) gotFirstPacket();
        this._onRtp(rtp);
      },
      onClose: (reason) => this._dead(`RTSP ${reason}`),
    });
    try {
      const sdp = await this.rtsp.start();
      this.parameterSets = sdp.parameterSets.filter((n) => [7, 8].includes(n[0] & 0x1f));
      this.log(`RTSP playing ${resolution || 'default resolution'} at ${level.fps} fps${sdp.profileLevelId ? `, H.264 ${sdp.profileLevelId}` : ''}`);
    } catch (err) {
      clearTimeout(this.startTimer);
      this.close();
      throw err;
    }
    await firstPacket;
  }

  _onRtp(rtp) {
    const types = nalTypes(rtp.payload);
    if (types.includes(7)) this.lastSpsTimestamp = rtp.header.timestamp;
    if (types.includes(5) && this.lastSpsTimestamp !== rtp.header.timestamp && this.parameterSets && this.parameterSets.length) {
      // Keyframe without SPS/PPS in front: insert them, same timestamp, no marker.
      const header = Object.assign(Object.create(Object.getPrototypeOf(rtp.header)), rtp.header);
      header.marker = false;
      header.csrc = rtp.header.csrc.slice();
      header.extensions = rtp.header.extensions.slice();
      this.lastSpsTimestamp = rtp.header.timestamp;
      this.onPacket(this, new RtpPacket(header, stapA(this.parameterSets)));
    }
    this.onPacket(this, rtp);
  }

  requestKeyframe() {
    if (this.rtsp) this.rtsp.requestKeyframe();
  }

  _dead(reason) {
    if (this.closed) return;
    this.log(`camera stream ended: ${reason}`);
    this.close();
    if (this.onDead) this.onDead(this);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.startTimer);
    if (this.rtsp) this.rtsp.close();
  }
}

module.exports = {
  RtspUpstream, pickResolution, nalTypes, stapA, LEVELS,
};
