'use strict';

// A small RTSP client for Axis cameras (VAPIX "Video streaming", RTSP section):
//   DESCRIBE rtsp://<camera>/axis-media/media.amp?videocodec=h264&...  (Digest login)
//   SETUP    <video control> Transport: RTP/AVP/TCP;unicast;interleaved=0-1
//   PLAY
// RTP then arrives on the same TCP connection, framed as '$' <channel> <length> <packet>.
// Keep-alive with GET_PARAMETER; a keyframe is requested with SET_PARAMETER Renew-Stream.

const net = require('node:net');
const { parseChallenges, pickChallenge, DigestSession } = require('./digest');
const { AxisError } = require('./errors');

const TIMEOUT_MS = 10000;
const MAX_BUFFER = 4 * 1024 * 1024;

// The parts of the SDP we need: the video track's control URL, payload type and the
// H.264 parameter sets (SPS/PPS) the camera may only announce here.
function parseSdp(sdp, baseUrl) {
  const lines = sdp.split(/\r?\n/);
  let sessionControl = null;
  let video = null;
  let inVideo = false;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      inVideo = line.startsWith('m=video');
      if (inVideo && !video) video = { payloadType: Number(line.split(' ')[3]), control: null, codec: null, fmtp: '' };
      else if (inVideo) inVideo = false; // only the first video track
      continue;
    }
    const control = /^a=control:(.*)$/.exec(line);
    if (control) {
      if (inVideo) video.control = control[1].trim();
      else if (!video) sessionControl = control[1].trim();
    }
    if (!inVideo) continue;
    const rtpmap = /^a=rtpmap:(\d+) ([^/]+)\/(\d+)/.exec(line);
    if (rtpmap && Number(rtpmap[1]) === video.payloadType) video.codec = rtpmap[2].toUpperCase();
    const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (fmtp && Number(fmtp[1]) === video.payloadType) video.fmtp = fmtp[2];
  }
  if (!video) return null;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const resolve = (c) => {
    if (!c || c === '*') return baseUrl;
    if (/^rtsp:\/\//i.test(c)) return c;
    return base + c.replace(/^\//, '');
  };
  const sprop = /sprop-parameter-sets=([^;\s]+)/.exec(video.fmtp);
  const parameterSets = sprop ? sprop[1].split(',').filter(Boolean).map((s) => Buffer.from(s, 'base64')) : [];
  const profile = /profile-level-id=([0-9a-fA-F]{6})/.exec(video.fmtp);
  return {
    control: resolve(video.control),
    sessionControl: sessionControl ? resolve(sessionControl) : baseUrl,
    payloadType: video.payloadType,
    codec: video.codec,
    parameterSets,
    profileLevelId: profile ? profile[1].toLowerCase() : null,
  };
}

class RtspSession {
  // url: full rtsp:// URL without credentials. onRtp(channel, packet) for every
  // interleaved packet; onClose(reason) once.
  constructor({
    host, port = 554, url, username, password, log = () => {}, onRtp, onClose,
  }) {
    this.host = host;
    this.port = port;
    this.url = url;
    this.username = username;
    this.password = password;
    this.log = log;
    this.onRtp = onRtp;
    this.onClose = onClose;
    this.cseq = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.digest = null;
    this.session = null;
  }

  async start() {
    await this._connect();
    const described = await this._request('DESCRIBE', this.url, { Accept: 'application/sdp' });
    const base = described.headers['content-base'] || described.headers['content-location'] || this.url;
    this.sdp = parseSdp(described.body.toString('utf8'), base);
    if (!this.sdp) throw new AxisError('not_supported', 'The camera offered no video');
    if (this.sdp.codec !== 'H264') throw new AxisError('not_supported', `The camera sent ${this.sdp.codec || 'unknown'} video, not H.264`);
    const setup = await this._request('SETUP', this.sdp.control, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
    const sessionHeader = setup.headers.session || '';
    this.session = sessionHeader.split(';')[0].trim();
    const timeout = /timeout=(\d+)/.exec(sessionHeader);
    const keepAliveMs = Math.max(5, Math.min(Number(timeout ? timeout[1] : 60), 120)) * 500;
    await this._request('PLAY', this.sdp.sessionControl, { Range: 'npt=0.000-' });
    this.keepAlive = setInterval(() => {
      this._request('GET_PARAMETER', this.sdp.sessionControl).catch((err) => this.log(`RTSP keep-alive failed: ${err.message}`));
    }, keepAliveMs);
    return this.sdp;
  }

  // Ask the camera for a keyframe now (VAPIX: SET_PARAMETER with Renew-Stream: yes).
  requestKeyframe() {
    if (this.closed || !this.session) return;
    this._request('SET_PARAMETER', this.sdp.sessionControl, { 'Content-Type': 'text/parameters' }, 'Renew-Stream: yes\r\n')
      .catch((err) => this.log(`keyframe request failed: ${err.message}`));
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setNoDelay(true);
      socket.setTimeout(TIMEOUT_MS);
      socket.once('connect', () => {
        socket.setTimeout(0);
        resolve();
      });
      socket.on('timeout', () => socket.destroy(new AxisError('unreachable', `No answer from ${this.host}:${this.port}`)));
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (err) => {
        if (!this.connectedOnce) reject(new AxisError('unreachable', err.message));
        this._end(err.message);
      });
      socket.on('close', () => this._end('connection closed'));
      socket.once('connect', () => { this.connectedOnce = true; });
    });
  }

  _send(method, url, headers, body) {
    this.cseq += 1;
    const lines = [`${method} ${url} RTSP/1.0`, `CSeq: ${this.cseq}`, 'User-Agent: Homey'];
    if (this.session) lines.push(`Session: ${this.session}`);
    if (this.digest) lines.push(`Authorization: ${this.digest.header(method, url)}`);
    for (const [k, v] of Object.entries(headers || {})) lines.push(`${k}: ${v}`);
    if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    const cseq = this.cseq;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cseq);
        reject(new AxisError('unreachable', `${method}: no answer`));
      }, TIMEOUT_MS);
      this.pending.set(cseq, { resolve, reject, timer });
    });
    this.socket.write(`${lines.join('\r\n')}\r\n\r\n${body || ''}`);
    return promise;
  }

  async _request(method, url, headers, body) {
    let res = await this._send(method, url, headers, body);
    if (res.status === 401) {
      const values = [].concat(res.headers['www-authenticate'] || []);
      const challenge = pickChallenge(parseChallenges(values), false);
      if (!challenge) throw new AxisError('login_failed', 'The camera asks for an unsupported RTSP login');
      this.digest = new DigestSession(challenge, this.username, this.password);
      res = await this._send(method, url, headers, body);
    }
    if (res.status === 401) throw new AxisError('login_failed', 'Username or password not accepted for video');
    if (res.status === 403) throw new AxisError('forbidden', 'This user may not watch video');
    if (res.status === 404) throw new AxisError('not_supported', 'The camera has no such video stream');
    if (res.status === 454) throw new AxisError('unreachable', 'The video session ended');
    if (res.status < 200 || res.status >= 300) throw new AxisError('bad_response', `${method}: RTSP ${res.status} ${res.reason}`);
    return res;
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > MAX_BUFFER) {
      this._end('too much unread data');
      return;
    }
    for (;;) {
      if (!this.buffer.length) return;
      if (this.buffer[0] === 0x24) { // '$' interleaved binary packet
        if (this.buffer.length < 4) return;
        const len = this.buffer.readUInt16BE(2);
        if (this.buffer.length < 4 + len) return;
        const channel = this.buffer[1];
        const packet = this.buffer.subarray(4, 4 + len);
        this.buffer = this.buffer.subarray(4 + len);
        if (this.onRtp) this.onRtp(channel, packet);
        continue;
      }
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        // Not a response start and no '$': skip garbage up to the next '$' or 'RTSP/'.
        if (this.buffer.length > 8 && !this.buffer.subarray(0, 5).equals(Buffer.from('RTSP/'))) {
          const next = this.buffer.indexOf(0x24, 1);
          this.buffer = next > 0 ? this.buffer.subarray(next) : Buffer.alloc(0);
          continue;
        }
        return;
      }
      const head = this.buffer.subarray(0, end).toString('latin1');
      const headers = {};
      const lines = head.split('\r\n');
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        if (headers[k] === undefined) headers[k] = v;
        else headers[k] = [].concat(headers[k], v);
      }
      const length = Number(headers['content-length'] || 0);
      if (this.buffer.length < end + 4 + length) return;
      const body = this.buffer.subarray(end + 4, end + 4 + length);
      this.buffer = this.buffer.subarray(end + 4 + length);
      const status = /^RTSP\/1\.0 (\d+) ?(.*)$/.exec(lines[0]);
      if (!status) continue; // a request from the camera (e.g. ANNOUNCE): ignore
      const cseq = Number(headers.cseq);
      const waiter = this.pending.get(cseq);
      if (waiter) {
        this.pending.delete(cseq);
        clearTimeout(waiter.timer);
        waiter.resolve({
          status: Number(status[1]), reason: status[2], headers, body,
        });
      }
    }
  }

  _end(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    for (const w of this.pending.values()) {
      clearTimeout(w.timer);
      w.reject(new AxisError('unreachable', reason));
    }
    this.pending.clear();
    if (this.socket && !this.socket.destroyed) {
      // end() lets a just-written TEARDOWN go out; destroy shortly after regardless.
      const socket = this.socket;
      socket.end();
      setTimeout(() => socket.destroy(), 500).unref();
    }
    if (this.onClose) this.onClose(reason);
  }

  close() {
    if (this.closed) return;
    if (this.session && this.socket && !this.socket.destroyed) {
      // Best effort: tell the camera the session is over.
      this._send('TEARDOWN', this.sdp.sessionControl).catch(() => {});
    }
    this._end('closed');
  }
}

// rtsp://host:port/axis-media/media.amp with the stream options.
function streamUrl(host, port, { resolution, fps, extra } = {}) {
  const q = new URLSearchParams({ videocodec: 'h264', audio: '0' });
  if (resolution) q.set('resolution', resolution);
  if (fps) q.set('fps', String(fps));
  for (const [k, v] of Object.entries(extra || {})) q.set(k, String(v));
  return `rtsp://${host}${port && port !== 554 ? `:${port}` : ''}/axis-media/media.amp?${q}`;
}

module.exports = { RtspSession, parseSdp, streamUrl };
