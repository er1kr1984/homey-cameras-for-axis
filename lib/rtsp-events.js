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

class RtspEventStream extends EventEmitter {
  // camera: { host, rtspPort, username, password }; topics: GetEventInstances topics.
  constructor({ camera, topics, log = () => {} }) {
    super();
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
    const q = new URLSearchParams({ video: '0', audio: '0', event: 'on' });
    // Some AXIS OS versions may refuse a long filter; then take all events.
    if (this.topics.length && !this.noFilter) q.set('eventtopic', rtspTopicFilter(this.topics));
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
    this.log(`event stream (RTSP) ${reason}; retrying in ${Math.round(this.delay / 1000)} s`);
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

module.exports = { RtspEventStream, parseMetadata, rtspTopicFilter };
