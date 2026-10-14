'use strict';

// Live events over RTSP, for cameras without the WebSocket event stream (AXIS OS before
// 10.x). VAPIX "Video streaming", RTSP parameters:
//   rtsp://<camera>/axis-media/media.amp?video=0&audio=0&event=on&eventtopic=<filter>
// The camera then sends ONVIF metadata documents over RTP (one or more packets, the last
// with the marker bit), each holding events like
//   <wsnt:NotificationMessage><wsnt:Topic>tns1:VideoSource/MotionAlarm</wsnt:Topic>
//     <wsnt:Message><tt:Message UtcTime=".." PropertyOperation="Changed">
//       <tt:Source><tt:SimpleItem Name="Source" Value="0"/></tt:Source>
//       <tt:Data><tt:SimpleItem Name="State" Value="true"/></tt:Data> ...
// Same interface as EventStream: start(), stop(), 'connected', 'disconnected', 'event', 'error'.

const { EventEmitter } = require('node:events');
const { RtspSession } = require('./rtsp');
const { parseXml, findAll } = require('./xml');

const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const MAX_DOCUMENT = 512 * 1024;
const MAX_SAMPLES = 20; // diagnostic samples per stream (one per new mix of object types)

// Topic filter for the RTSP event stream: prefixes are onvif: / axis: here.
function rtspTopicFilter(topics) {
  return topics.map((t) => t.split('/').map((part) => part
    .replace(/^tns1:/, 'onvif:')
    .replace(/^tnsaxis:/, 'axis:')).join('/')).join('|');
}

// One metadata document -> [{ topic, time, source, key, data, operation }]
function parseMetadata(xml) {
  const out = [];
  let root;
  try {
    root = parseXml(xml);
  } catch (err) {
    return out;
  }
  for (const note of findAll(root, (n) => n.local === 'NotificationMessage')) {
    const topicNode = findAll(note, (n) => n.local === 'Topic')[0];
    const msg = findAll(note, (n) => n.local === 'Message' && n.attrs && (n.attrs.UtcTime || n.attrs.PropertyOperation !== undefined))[0]
      || findAll(note, (n) => n.local === 'Message').pop();
    if (!topicNode || !msg) continue;
    const items = (part) => {
      const out2 = {};
      const node = msg.children.find((c) => c.local === part);
      if (node) for (const si of findAll(node, (n) => n.local === 'SimpleItem')) out2[si.attrs.Name] = si.attrs.Value;
      return out2;
    };
    out.push({
      topic: topicNode.text.trim(),
      time: msg.attrs.UtcTime ? new Date(msg.attrs.UtcTime) : new Date(),
      source: items('Source'),
      key: items('Key'),
      data: items('Data'),
      operation: msg.attrs.PropertyOperation || null,
    });
  }
  return out;
}

// One analytics scene description frame (ONVIF tt:Frame) ->
// { time, objects: [{ id, type, likelihood, colors: [name] }] }, or null.
// Object types are lower-case (human, face, vehicle, car, truck, bus, bike, ...).
function parseScene(xml) {
  let root;
  try {
    root = parseXml(xml);
  } catch (err) {
    return null;
  }
  const frames = findAll(root, (n) => n.local === 'Frame');
  if (!frames.length) return null;
  const frame = frames[frames.length - 1];
  const deleted = findAll(frame, (n) => n.local === 'Delete' && n.attrs.ObjectId).map((n) => n.attrs.ObjectId);
  // ONVIF shapes are in normalised coordinates (-1..1, y up), or in pixels with a
  // tt:Transformation (translate + scale) to get there.
  const tr = frame.children.find((c) => c.local === 'Transformation');
  const num = (n, k, d) => (n && n.attrs[k] !== undefined ? Number(n.attrs[k]) : d);
  const translate = tr && tr.children.find((c) => c.local === 'Translate');
  const scale = tr && tr.children.find((c) => c.local === 'Scale');
  const norm = (v, axis) => v * num(scale, axis, 1) + num(translate, axis, 0);
  const objects = frame.children.filter((c) => c.local === 'Object').map((obj) => {
    const types = findAll(obj, (n) => n.local === 'Type' && n.text)
      .map((t) => ({ type: t.text.trim().toLowerCase(), likelihood: Number(t.attrs.Likelihood) || 0 }))
      .sort((a, b) => b.likelihood - a.likelihood);
    const colors = findAll(obj, (n) => n.local === 'Color' && n.attrs.X !== undefined)
      .map((c) => colorName(Number(c.attrs.X), Number(c.attrs.Y), Number(c.attrs.Z), c.attrs.Colorspace || ''));
    const bb = findAll(obj, (n) => n.local === 'BoundingBox')[0];
    let box = null;
    if (bb) {
      const left = norm(num(bb, 'left', 0), 'x');
      const right = norm(num(bb, 'right', 0), 'x');
      const top = norm(num(bb, 'top', 0), 'y');
      const bottom = norm(num(bb, 'bottom', 0), 'y');
      // To 0..1 from the top-left corner, for drawing.
      const clamp = (v) => Math.max(0, Math.min(1, v));
      const x0 = clamp((Math.min(left, right) + 1) / 2);
      const x1 = clamp((Math.max(left, right) + 1) / 2);
      const y0 = clamp((1 - Math.max(top, bottom)) / 2);
      const y1 = clamp((1 - Math.min(top, bottom)) / 2);
      box = {
        x: x0, y: y0, w: x1 - x0, h: y1 - y0,
      };
    }
    // Object Analytics adds a small JPEG crop of the object (base64), now and then.
    const imageNode = findAll(obj, (n) => n.local === 'Image' && n.text && n.text.length > 100)[0];
    return {
      id: obj.attrs.ObjectId || null,
      image: imageNode ? imageNode.text.trim() : null,
      type: types.length ? types[0].type : null,
      likelihood: types.length ? types[0].likelihood : 0,
      colors: [...new Set(colors.filter(Boolean))],
      box,
    };
  });
  return {
    time: frame.attrs.UtcTime ? new Date(frame.attrs.UtcTime) : new Date(),
    source: frame.attrs.Source || null,
    objects,
    deleted,
  };
}

// A rough colour name for an ONVIF colour (YCbCr by default, or RGB).
function colorName(x, y, z, space) {
  let r;
  let g;
  let b;
  if (/RGB/i.test(space)) {
    [r, g, b] = [x, y, z];
  } else {
    r = x + 1.402 * (z - 128);
    g = x - 0.344136 * (y - 128) - 0.714136 * (z - 128);
    b = x + 1.772 * (y - 128);
  }
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  [r, g, b] = [r, g, b].map((v) => Math.max(0, Math.min(255, v)) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 0.12) return l > 0.8 ? 'white' : l < 0.2 ? 'black' : 'grey';
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return 'red';
  if (h < 45) return l < 0.35 ? 'brown' : 'orange';
  if (h < 70) return 'yellow';
  if (h < 170) return 'green';
  if (h < 260) return 'blue';
  if (h < 300) return 'purple';
  return 'pink';
}

class RtspEventStream extends EventEmitter {
  // camera: { host, rtspPort, username, password }; topics: GetEventInstances topics.
  // mode 'scene': the analytics scene description (objects in view) instead of events;
  // emits 'frame' instead of 'event'.
  constructor({
    camera, topics = [], log = () => {}, mode = 'events',
  }) {
    super();
    this.mode = mode;
    this.camera = camera;
    this.topics = topics;
    this.log = log;
    this.closed = false;
    this.connected = false;
    this.delay = RECONNECT_MIN_MS;
  }

  start() {
    this.closed = false;
    this._connect();
  }

  async _connect() {
    if (this.closed) return;
    const q = this.mode === 'scene'
      ? new URLSearchParams({ video: '0', audio: '0', event: 'off', analytics: 'polygon' })
      : new URLSearchParams({ video: '0', audio: '0', event: 'on' });
    // Some AXIS OS versions may refuse a long filter; then take all events.
    if (this.mode !== 'scene' && this.topics.length && !this.noFilter) q.set('eventtopic', rtspTopicFilter(this.topics));
    const port = this.camera.rtspPort || 554;
    const url = `rtsp://${this.camera.host}${port !== 554 ? `:${port}` : ''}/axis-media/media.amp?${q}`;
    let doc = [];
    let size = 0;
    const session = new RtspSession({
      host: this.camera.host,
      port,
      url,
      kind: 'application',
      username: this.camera.username,
      password: this.camera.password,
      log: this.log,
      onRtp: (channel, packet) => {
        if (channel !== 0 || packet.length < 12) return;
        const cc = packet[0] & 0x0f;
        const ext = packet[0] & 0x10;
        let offset = 12 + cc * 4;
        if (ext && packet.length >= offset + 4) offset += 4 + packet.readUInt16BE(offset + 2) * 4;
        const marker = (packet[1] & 0x80) !== 0;
        doc.push(packet.subarray(offset));
        size += packet.length - offset;
        if (size > MAX_DOCUMENT) {
          doc = [];
          size = 0;
          return;
        }
        if (!marker) return;
        const xml = Buffer.concat(doc).toString('utf8');
        doc = [];
        size = 0;
        if (this.mode === 'scene') {
          // Several frames a second: parse at most one per interval.
          const now = Date.now();
          if (!/<(\w+:)?Frame[\s>]/.test(xml)) return;
          // Object Analytics' own frames carry object types; the motion tracker's don't.
          // Once Object Analytics frames arrive, the others are skipped.
          const isAsd = /Source="AnalyticsSceneDescription"/.test(xml);
          if (isAsd) this.sawAsd = true;
          else if (this.sawAsd) return;
          if (now - (this.lastFrameAt || 0) < (this.frameIntervalMs || 1000)) return;
          this.lastFrameAt = now;
          // Diagnostics: one sample of each new mix of object types from each producer.
          const src = (/Frame[^>]*Source="([^"]+)"/.exec(xml) || [])[1] || '?';
          this.untypedSamples = this.untypedSamples || {};
          if (!this.firstFrameLogged) {
            this.firstFrameLogged = true;
            this.log(`first scene frame from ${src}: ${xml.slice(0, 600).replace(/\s+/g, ' ')}`);
          }
          if (!/<(\w+:)?Class>/.test(xml) && /<(\w+:)?Object[\s>]/.test(xml) && (this.untypedSamples[src] || 0) < 2) {
            this.untypedSamples[src] = (this.untypedSamples[src] || 0) + 1;
            this.log(`scene sample from ${src} (no object types): ${xml.slice(0, 2000).replace(/\s+/g, ' ')}`);
          }
          if (/<(\w+:)?Class>/.test(xml)) {
            const types = [...new Set([...xml.matchAll(/<(?:\w+:)?Type\b[^>]*>([^<]+)</g)].map((m) => m[1].trim()))].sort();
            const key = `${src}:${types.join(',')}`;
            this.samples = this.samples || new Set();
            if (!this.samples.has(key) && this.samples.size < MAX_SAMPLES) {
              this.samples.add(key);
              this.log(`scene sample from ${src} [${types.join(', ')}]: ${xml.replace(/<(\w+:)?Image>[^<]*<\/(\w+:)?Image>/g, '<Image/>').slice(0, 3000).replace(/\s+/g, ' ')}`);
            }
          }
          const frame = parseScene(xml);
          if (frame) this.emit('frame', frame);
          return;
        }
        for (const ev of parseMetadata(xml)) this.emit('event', ev);
      },
      onClose: (reason) => {
        if (this.session !== session) return;
        this.session = null;
        if (this.connected) {
          this.connected = false;
          this.emit('disconnected');
        }
        this._retry(`closed (${reason})`);
      },
    });
    this.session = session;
    try {
      await session.start();
      this.delay = RECONNECT_MIN_MS;
      this.connected = true;
      this.emit('connected');
    } catch (err) {
      if (this.session === session) this.session = null;
      session.close();
      if (!this.noFilter && this.topics.length && ['bad_response', 'not_supported'].includes(err.code)) {
        this.noFilter = true;
        this.log(`event filter refused (${err.message}); listening to all events`);
      }
      this._retry(err.message, err);
    }
  }

  _retry(reason, err) {
    if (this.closed) return;
    this.log(`${this.mode === 'scene' ? 'scene stream' : 'event stream (RTSP)'} ${reason}; retrying in ${Math.round(this.delay / 1000)} s`);
    if (err) this.emit('error', err);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._connect(), this.delay);
    this.delay = Math.min(this.delay * 2, RECONNECT_MAX_MS);
  }

  stop() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    if (this.session) {
      const s = this.session;
      this.session = null;
      s.close();
    }
  }
}

module.exports = {
  RtspEventStream, parseMetadata, rtspTopicFilter, parseScene, colorName,
};
