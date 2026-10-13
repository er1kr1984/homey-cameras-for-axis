'use strict';

// Relays camera live video to WebRTC viewers (the Homey frontend).
//
// Per camera we hold ONE upstream stream from the camera (RTSP, see rtsp-upstream.js)
// and answer each viewer with its own peer connection (ViewerSession). H.264 RTP packets
// are forwarded untouched (no transcoding) to every viewer.
//
//   viewers --offer--> [ViewerSession]* <==RTP== [CameraStream] <==RTSP== camera

const crypto = require('node:crypto');
const {
  RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack, RtpPacket, useOPUS, usePCMU,
} = require('werift');
const quality = require('./quality');

const h264 = () => new RTCRtpCodecParameters({
  mimeType: 'video/H264',
  clockRate: 90000,
  rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }],
  parameters: 'packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1',
});

const ICE_GATHER_TIMEOUT_MS = 3000;
const UPSTREAM_TIMEOUT_MS = 15000;
const VIEWER_SILENCE_MS = 15000; // viewers send RTCP about every second
const UPSTREAM_LINGER_MS = 10000; // keep the camera stream open briefly for quick re-opens
const GOP_CACHE_MAX_BYTES = 2 * 1024 * 1024; // replay at most 2 MB to a new viewer
const STALL_MS = 10000; // no video this long after it started = restart the camera stream
const MAX_RESTARTS = 3; // give up (close) after this many restarts in a row without video
const BFRAME_HITS = 3; // backwards timestamps needed within BFRAME_WINDOW_MS to call it B-frames
const BFRAME_WINDOW_MS = 10000;
const BFRAME_EARLY_MS = 3000;
// Most camera streams the relay runs at once; Homey's CPU can't relay many more.
const MAX_STREAMS = Number(process.env.AXIS_MAX_STREAMS) || 6;

// Each viewer's sender rewrites the RTP header in place, so every viewer gets its own
// header object; the payload is shared (never modified).
function copyForViewer(rtp) {
  const h = Object.assign(Object.create(Object.getPrototypeOf(rtp.header)), rtp.header);
  h.csrc = rtp.header.csrc.slice();
  h.extensions = rtp.header.extensions.slice();
  return new RtpPacket(h, rtp.payload);
}

// Non-reference picture slices (nal_ref_idc 0): no other frame depends on them, so they
// can be dropped without breaking the stream. Cameras that use B-frames send them as
// such slices, and WebRTC players (phones, Homey) can't play B-frames.
function isNonReferenceSlice(payload) {
  if ((payload[0] & 0x60) !== 0) return false;
  const type = payload[0] & 0x1f;
  if (type === 1) return true;
  if (type === 28) return (payload[1] & 0x1f) === 1;
  return false;
}

// True when this RTP payload starts a keyframe: SPS (alone or in a STAP-A),
// or the first fragment of an IDR slice.
function startsKeyframe(payload) {
  const type = payload[0] & 0x1f;
  if (type === 7) return true;
  if (type === 5) return true;
  if (type === 24) {
    for (let o = 1; o + 2 < payload.length;) {
      const len = payload.readUInt16BE(o);
      if ((payload[o + 2] & 0x1f) === 7) return true;
      o += 2 + len;
    }
    return false;
  }
  if (type === 28) return (payload[1] & 0x80) !== 0 && (payload[1] & 0x1f) === 5;
  return false;
}

// Keeps a single H.264 payload type in the viewer's video section (plus its RTX), so the
// packets we forward are always labelled with a format the viewer will decode.
// Prefers packetization-mode=1 and the High profile cameras usually send.
function pickViewerH264(offerSdp) {
  const lines = offerSdp.split(/\r?\n/);
  const mIdx = lines.findIndex((l) => l.startsWith('m=video'));
  if (mIdx < 0) return { sdp: offerSdp, chosen: null };
  let end = lines.findIndex((l, i) => i > mIdx && l.startsWith('m='));
  if (end < 0) end = lines.length;
  const section = lines.slice(mIdx, end);
  const rtpmap = {};
  const fmtp = {};
  for (const l of section) {
    let m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(l);
    if (m) rtpmap[m[1]] = m[2].toUpperCase();
    m = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (m) fmtp[m[1]] = m[2];
  }
  const h264 = Object.keys(rtpmap).filter((pt) => rtpmap[pt] === 'H264');
  const score = (pt) => {
    const f = (fmtp[pt] || '').toLowerCase();
    let sc = 0;
    if (f.includes('packetization-mode=1')) sc += 10;
    if (/profile-level-id=64/.test(f)) sc += 3;
    else if (/profile-level-id=42e0/.test(f)) sc += 2;
    if (f.includes('level-asymmetry-allowed=1')) sc += 1;
    return sc;
  };
  const chosen = h264.sort((a, b) => score(b) - score(a))[0];
  if (!chosen) return { sdp: offerSdp, chosen: null, h264: [] };
  const rtx = Object.keys(fmtp).filter((pt) => rtpmap[pt] === 'RTX' && fmtp[pt].includes(`apt=${chosen}`));
  const keep = new Set([chosen, ...rtx]);
  const mParts = section[0].split(' ');
  section[0] = [...mParts.slice(0, 3), ...mParts.slice(3).filter((pt) => keep.has(pt))].join(' ');
  const filtered = section.filter((l) => {
    const m = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)/.exec(l);
    return !m || keep.has(m[1]);
  });
  const out = [...lines.slice(0, mIdx), ...filtered, ...lines.slice(end)].join('\r\n');
  return { sdp: out, chosen: `${chosen} ${fmtp[chosen] || ''}`, h264: h264.map((pt) => `${pt}:${fmtp[pt] || ''}`) };
}

function waitForIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

// One camera's live video, shared by any number of viewers. Can move to another
// quality level while viewers keep watching.
class CameraStream {
  constructor({
    openUpstream, camera, profile, auto, log, onClose, onProfileChanged, bframes = false, onBFrames,
  }) {
    this.openUpstream = openUpstream;
    this.camera = camera;
    this.profile = profile;
    this.auto = auto; // true when the quality may be changed automatically
    this.log = log;
    this.onClose = onClose;
    this.onProfileChanged = onProfileChanged;
    this.viewers = new Set();
    this.closed = false;
    this.packets = 0;
    this.sampleBytes = 0;
    // Packets since the latest keyframe, replayed to new viewers so their picture starts at once
    // (cameras send a keyframe only every few seconds).
    this.gop = [];
    this.gopBytes = 0;
    this.gopTimestamp = null;
    this.gopOverflow = true;
    // Forwarded packets get their own continuous numbering, so dropped packets
    // (B-frames) don't look like losses to viewers.
    this.outSeq = Math.floor(Math.random() * 65536);
    // Cameras already known to send B-frames drop them from the first packet.
    this.dropBFrames = bframes;
    this.onBFrames = onBFrames;
    this.backwardsAt = [];
    this.maxTimestamp = null;
    this.lastPacketAt = 0;
    this.restarts = 0;
    this.ready = this._startActive();
    // A stream that stops sending after it started (camera rebooted, network hiccup) is
    // restarted; viewers stay connected and pick up at the new stream's first keyframe.
    this.stallTimer = setInterval(() => this._checkStall(), 5000);
    this.ready.catch((err) => {
      this.log(`camera stream failed: ${err.message}`);
      this.close();
    });
    this.statsTimer = setInterval(() => {
      this.log(`${this.profile}: forwarded ${this.packets} packets to ${this.viewers.size} viewer(s)`);
    }, 60000);
  }

  _newUpstream(profile) {
    return this.openUpstream({
      camera: this.camera,
      profile,
      log: this.log,
      onPacket: (up, rtp) => this._onPacket(up, rtp),
      onDead: (up) => {
        if (up === this.active) this.close();
        if (up === this.pending) this.pending = null;
      },
    });
  }

  // A first attempt can fail (camera busy, network hiccup); retry once, keeping viewers attached.
  async _startActive() {
    this.lastSetupAt = Date.now();
    for (let attempt = 1; ; attempt++) {
      const up = this._newUpstream(this.profile);
      this.active = up;
      try {
        await up.start();
        this.log(`${this.profile}: first video packet from the camera`);
        return;
      } catch (err) {
        up.close();
        if (this.closed || attempt >= 2) throw err;
        this.log(`attempt ${attempt} failed (${err.message}), retrying`);
      }
    }
  }

  // Moves to another quality level (or, with `force`, restarts at the same one). The new
  // stream takes over at its first keyframe.
  switchProfile(profile, reason, force = false) {
    if (this.closed || this.pending || (profile === this.profile && !force)) return false;
    this.log(`${profile === this.profile ? 'restarting' : `switching ${this.profile} ->`} ${profile} (${reason})`);
    this.lastSetupAt = Date.now();
    const up = this._newUpstream(profile);
    this.pending = up;
    up.start().catch((err) => {
      this.log(`switch to ${profile} failed: ${err.message}`);
      up.close();
      if (this.pending === up) this.pending = null;
    });
    // Give up if the new stream never reaches a keyframe.
    clearTimeout(this.switchTimer);
    this.switchTimer = setTimeout(() => {
      if (this.pending === up) {
        this.log(`switch to ${profile} timed out`);
        up.close();
        this.pending = null;
      }
    }, UPSTREAM_TIMEOUT_MS + 10000);
    return true;
  }

  _checkStall() {
    if (this.closed || this.pending || !this.lastPacketAt) return;
    if (Date.now() - this.lastPacketAt < STALL_MS) return;
    if (this.restarts >= MAX_RESTARTS) {
      this.log(`no video after ${MAX_RESTARTS} restarts; closing`);
      this.close();
      return;
    }
    this.restarts++;
    this.lastPacketAt = Date.now(); // wait a full period before trying again
    this.switchProfile(this.profile, `no video for ${STALL_MS / 1000} s`, true);
  }

  _onPacket(up, rtp) {
    if (up === this.pending) {
      if (!startsKeyframe(rtp.payload)) return;
      // Hand over at the keyframe: viewers continue numbering from where they were.
      const old = this.active;
      this.active = up;
      this.pending = null;
      this.profile = up.profile;
      this.gop = [];
      this.gopBytes = 0;
      this.gopTimestamp = null;
      this.maxTimestamp = null;
      this.backwardsAt = [];
      for (const viewer of this.viewers) viewer.sourceChanged(rtp.header);
      if (old) old.close();
      this.log(`now streaming ${this.profile}`);
      if (this.onProfileChanged) this.onProfileChanged(this, this.profile);
    }
    if (up !== this.active) return;
    if (!this.firstPacketAt) this.firstPacketAt = Date.now();
    this.lastPacketAt = Date.now();
    this.restarts = 0;
    this.sampleBytes += rtp.payload.length;
    // B-frames show up as timestamps going backwards (frames sent before earlier ones).
    // Several within a short window, so one reordered packet doesn't trigger it.
    const ts = rtp.header.timestamp;
    if (this.maxTimestamp === null || ((ts - this.maxTimestamp) | 0) > 0) this.maxTimestamp = ts;
    else if (((ts - this.maxTimestamp) | 0) < 0 && !this.dropBFrames) {
      const now = Date.now();
      this.backwardsAt = this.backwardsAt.filter((t) => now - t < BFRAME_WINDOW_MS);
      this.backwardsAt.push(now);
      // In the first seconds of a stream one backwards timestamp is enough (network
      // reordering is unlikely then, and every B-frame let through upsets the viewer).
      const early = now - this.firstPacketAt < BFRAME_EARLY_MS;
      if (early || this.backwardsAt.length >= BFRAME_HITS) {
        this.dropBFrames = true;
        // New viewers must not get the B-frames already cached either.
        this.gop = this.gop.filter((p) => !isNonReferenceSlice(p.payload));
        this.gopBytes = this.gop.reduce((n, p) => n + p.payload.length, 0);
        this.log('camera sends B-frames; dropping them so phones can play the video (lower frame rate)');
        if (this.onBFrames) this.onBFrames(this.camera.id);
      }
    }
    if (this.dropBFrames && isNonReferenceSlice(rtp.payload)) return;
    rtp.header.sequenceNumber = this.outSeq;
    this.outSeq = (this.outSeq + 1) & 0xffff;
    this.packets++;
    this._forward(rtp);
  }

  _forward(rtp) {
    if (startsKeyframe(rtp.payload) && rtp.header.timestamp !== this.gopTimestamp) {
      this.gop = [];
      this.gopBytes = 0;
      this.gopTimestamp = rtp.header.timestamp;
      this.gopOverflow = false;
    }
    if (!this.gopOverflow) {
      if (this.gopBytes + rtp.payload.length <= GOP_CACHE_MAX_BYTES) {
        this.gop.push(rtp);
        this.gopBytes += rtp.payload.length;
      } else {
        this.gop = [];
        this.gopBytes = 0;
        this.gopOverflow = true;
      }
    }
    for (const viewer of this.viewers) {
      try {
        viewer.track.writeRtp(copyForViewer(rtp));
      } catch (err) {
        this.log(`dropping viewer after write error: ${err.message}`);
        viewer.close();
      }
    }
  }

  // kbit/s received from the camera since the last call.
  takeKbps(elapsedMs) {
    const kbps = (this.sampleBytes * 8) / elapsedMs;
    this.sampleBytes = 0;
    return kbps;
  }

  // Called once the viewer's connection is up: replay the current GOP, then go live.
  addViewer(viewer) {
    clearTimeout(this.lingerTimer);
    this.lastSetupAt = Date.now();
    if (!this.gopOverflow) {
      for (const rtp of this.gop) viewer.track.writeRtp(copyForViewer(rtp));
    }
    this.viewers.add(viewer);
    this.log(`viewer joined (${this.viewers.size} watching, replayed ${this.gopOverflow ? 0 : this.gop.length} cached packets)`);
    this.requestKeyframe();
  }

  reserve() {
    clearTimeout(this.lingerTimer);
  }

  removeViewer(viewer) {
    this.viewers.delete(viewer);
    if (this.viewers.size === 0 && !this.closed) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = setTimeout(() => {
        if (this.viewers.size === 0) this.close();
      }, UPSTREAM_LINGER_MS);
    }
  }

  requestKeyframe() {
    if (this.active) this.active.requestKeyframe();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.statsTimer);
    clearInterval(this.stallTimer);
    clearTimeout(this.lingerTimer);
    clearTimeout(this.switchTimer);
    this.gop = [];
    this.log(`camera stream closed after ${this.packets} packets`);
    if (this.active) this.active.close();
    if (this.pending) this.pending.close();
    for (const viewer of [...this.viewers]) viewer.close();
    if (this.onClose) this.onClose(this);
  }
}

// One viewer (e.g. a phone) watching a CameraStream.
class ViewerSession {
  constructor({ stream, log, onClose }) {
    this.id = crypto.randomUUID();
    this.stream = stream;
    this.log = log;
    this.onClose = onClose;
    this.closed = false;
    this.lastHeard = Date.now();
    this.track = new MediaStreamTrack({ kind: 'video' });
  }

  // Takes the viewer's SDP offer and returns a complete (non-trickle) SDP answer.
  async answer(viewerOfferSdp) {
    // The viewer may also offer audio; accept the codecs so negotiation succeeds,
    // then mark audio inactive (live video is video only here).
    const pc = new RTCPeerConnection({ codecs: { video: [h264()], audio: [useOPUS(), usePCMU()] } });
    this.pc = pc;
    const t0 = Date.now();
    const kinds = {};
    for (const m of viewerOfferSdp.matchAll(/a=candidate:\S+ \d+ (\w+) \d+ (\S+) \d+ typ (\w+)/g)) {
      const k = `${m[1].toLowerCase()}/${m[3]}${m[2].endsWith('.local') ? '(mdns)' : ''}`;
      kinds[k] = (kinds[k] || 0) + 1;
    }
    this.log(`viewer offer candidates: ${JSON.stringify(kinds)}`);
    pc.iceConnectionStateChange.subscribe((state) => this.log(`viewer ICE ${state} after ${Date.now() - t0} ms`));
    pc.connectionStateChange.subscribe((state) => {
      this.log(`viewer ${state} after ${Date.now() - t0} ms`);
      if (state === 'connected' && !this.closed && !this.joined) {
        this.joined = true;
        this.stream.addViewer(this);
      }
      if (state === 'failed' || state === 'closed') this.close();
    });

    const picked = pickViewerH264(viewerOfferSdp);
    this.log(`viewer H.264: ${picked.chosen}`);
    await pc.setRemoteDescription({ type: 'offer', sdp: picked.sdp });
    for (const t of pc.getTransceivers()) {
      if (t.kind === 'audio') t.setDirection('inactive');
    }
    const transceiver = pc.getTransceivers().find((t) => t.kind === 'video');
    if (!transceiver) throw new Error('Viewer offer has no video');
    transceiver.setDirection('sendonly');
    transceiver.sender.replaceTrack(this.track);
    this.sender = transceiver.sender;
    transceiver.sender.onRtcp.subscribe((rtcp) => {
      this.lastHeard = Date.now();
      // Viewer asks for a keyframe (PLI) -> ask the camera for one.
      if (rtcp.type === 206 && rtcp.feedback && rtcp.feedback.count === 1) this.stream.requestKeyframe();
    });

    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIceGathering(pc, ICE_GATHER_TIMEOUT_MS);

    // Close viewers that silently went away (app closed, phone locked, network lost).
    this.lastHeard = Date.now();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastHeard > VIEWER_SILENCE_MS) {
        this.log('viewer silent, closing');
        this.close();
      }
    }, 5000);

    // Keep the camera stream from lingering-closing while this viewer connects.
    this.stream.reserve();
    return pc.localDescription.sdp;
  }

  keepAlive() {
    this.lastHeard = Date.now();
  }

  // The camera stream moved to another upstream. Sequence numbers already continue
  // (the camera stream renumbers packets); continue the timestamps from where this
  // viewer was, one frame interval later.
  sourceChanged(header) {
    const sender = this.sender;
    if (!sender || sender.timestamp === undefined) return;
    sender.timestampOffset = (sender.timestamp + 3000 - header.timestamp) >>> 0;
    sender.rtpCache = [];
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    this.stream.removeViewer(this);
    if (this.pc) this.pc.close().catch(() => {});
    if (this.onClose) this.onClose(this);
  }
}

// Keeps one CameraStream per camera, hands out viewer sessions and steps quality
// down when the app uses too much CPU.
class LiveRelay {
  // openUpstream({ camera, profile, log, onPacket, onDead }) starts one camera stream.
  // knownBFrames: ids of cameras known to send B-frames (onBFrames adds one).
  constructor({
    openUpstream, log = () => {}, onProfileLearned, knownBFrames = [], onBFrames,
  }) {
    this.openUpstream = openUpstream;
    this.knownBFrames = new Set(knownBFrames);
    this.onBFrames = onBFrames;
    this.log = log;
    this.onProfileLearned = onProfileLearned;
    this.streams = new Map(); // key: camera id
    this.cpuSamples = [];
    this.lastSwitch = 0;
    this.lastStatus = 0;
    this.lastSampleAt = Date.now();
    this.lastSetupAt = 0;
    this.cpu = new quality.CpuMonitor({ onSample: (pct) => this._onCpuSample(pct) });
  }

  // mode: 'auto' or a fixed profile. startProfile: where an auto stream begins.
  async openViewer({
    camera, mode = 'auto', startProfile = 'medium', viewerOfferSdp, onClose,
  }) {
    const auto = mode === 'auto';
    const profile = auto ? startProfile : mode;
    this.lastSetupAt = Date.now();
    // A camera has ONE stream. A viewer that asks for another quality joins the running
    // stream instead of restarting it (restarting would cut off everyone else watching).
    let stream = this.streams.get(camera.id);
    if (stream && !stream.closed && (stream.auto !== auto || (!auto && stream.profile !== profile))) {
      this.log(`[${camera.name}] joining the running ${stream.profile} stream (asked for ${mode})`);
    }
    if (!stream || stream.closed) {
      const running = [...this.streams.values()].filter((s) => !s.closed).length;
      if (running >= MAX_STREAMS) {
        const err = new Error(`Too many live streams at once (${MAX_STREAMS})`);
        err.code = 'too_many_streams';
        throw err;
      }
      const key = camera.id;
      stream = new CameraStream({
        openUpstream: this.openUpstream,
        camera,
        profile,
        auto,
        log: (...args) => this.log(`[${camera.name}]`, ...args),
        onClose: (s) => { if (this.streams.get(key) === s) this.streams.delete(key); },
        onProfileChanged: (s, p) => { if (s.auto && this.onProfileLearned) this.onProfileLearned(camera.id, p); },
        bframes: this.knownBFrames.has(camera.id),
        onBFrames: (id) => {
          if (this.knownBFrames.has(id)) return;
          this.knownBFrames.add(id);
          if (this.onBFrames) this.onBFrames(id);
        },
      });
      this.streams.set(key, stream);
    }
    const viewer = new ViewerSession({
      stream,
      log: (...args) => this.log(`[${camera.name}]`, ...args),
      onClose,
    });
    try {
      return { viewer, answerSdp: await viewer.answer(viewerOfferSdp) };
    } catch (err) {
      viewer.close();
      throw err;
    }
  }

  _onCpuSample(percent) {
    const now = Date.now();
    const elapsed = now - this.lastSampleAt;
    this.lastSampleAt = now;
    const streams = [...this.streams.values()].filter((s) => !s.closed);
    const rates = new Map(streams.map((s) => [s, s.takeKbps(elapsed)]));
    this.cpuSamples.push(percent);
    if (this.cpuSamples.length > quality.SAMPLES_TO_ACT) this.cpuSamples.shift();
    const avg = this.cpuSamples.reduce((a, b) => a + b, 0) / this.cpuSamples.length;
    if (!streams.length) return;

    if (now - this.lastStatus > 60000) {
      this.lastStatus = now;
      this.log(`CPU ${Math.round(avg)}%; ${streams.map((s) => `${s.camera.name}: ${s.profile}${s.auto ? ' (auto)' : ''} ${Math.round(rates.get(s))} kbit/s`).join(', ')}`);
    }
    const settling = Math.max(this.lastSetupAt, ...streams.map((s) => s.lastSetupAt || 0));
    if (now - settling < quality.SETUP_GRACE_MS) {
      // Readings from a stream start are not representative; start counting afresh.
      this.cpuSamples = [];
      return;
    }
    if (now - this.lastSwitch < quality.SWITCH_COOLDOWN_MS || this.cpuSamples.length < quality.SAMPLES_TO_ACT) return;

    const critical = avg > quality.CPU_CRITICAL;
    if (!critical && avg <= quality.CPU_HIGH) return;
    // Prefer streams someone is watching, then the heaviest.
    const candidates = streams
      .filter((s) => !s.pending && quality.lower(s.profile) && (s.auto || critical))
      .sort((a, b) => (b.viewers.size > 0) - (a.viewers.size > 0) || rates.get(b) - rates.get(a));
    const target = candidates[0];
    if (!target) return;
    if (target.switchProfile(quality.lower(target.profile), `CPU ${Math.round(avg)}%${critical ? ', critical' : ''}`)) {
      this.lastSwitch = now;
      this.cpuSamples = [];
    }
  }

  closeCamera(id) {
    const stream = this.streams.get(id);
    if (stream) stream.close();
  }

  closeAll() {
    for (const stream of [...this.streams.values()]) stream.close();
    this.cpu.stop();
  }
}

module.exports = LiveRelay;
module.exports.pickViewerH264 = pickViewerH264;
module.exports.isNonReferenceSlice = isNonReferenceSlice;
module.exports.startsKeyframe = startsKeyframe;
module.exports.MAX_STREAMS = MAX_STREAMS;
