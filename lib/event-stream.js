'use strict';

// Live events from one camera over VAPIX "Event streaming over WebSocket":
//   1. GET /axis-cgi/wssession.cgi (with login) gives a token valid for 15 seconds,
//   2. connect wss://<camera>/vapix/ws-data-stream?wssession=<token>&sources=events,
//   3. send events:configure with the topics we want,
//   4. receive events:notify messages.
// Reconnects by itself with a growing delay; emits 'event', 'connected', 'disconnected'.

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const PING_MS = 30000; // a dead connection shows up within two pings

class EventStream extends EventEmitter {
  // client: VapixClient; filters: [{ topicFilter, contentFilter? }]
  constructor({ client, filters, log = () => {} }) {
    super();
    this.client = client;
    this.filters = filters;
    this.log = log;
    this.closed = false;
    this.delay = RECONNECT_MIN_MS;
    this.connected = false;
  }

  start() {
    this.closed = false;
    this._connect();
  }

  async _connect() {
    if (this.closed) return;
    let token;
    try {
      token = await this.client.wsSessionToken();
    } catch (err) {
      this._retry(`event session: ${err.message}`, err);
      return;
    }
    if (this.closed) return;
    const scheme = this.client.secure ? 'wss' : 'ws';
    const url = `${scheme}://${this.client.host}:${this.client.port}/vapix/ws-data-stream?wssession=${encodeURIComponent(token)}&sources=events`;
    const ws = new WebSocket(url, {
      rejectUnauthorized: false,
      // Same certificate check as the HTTPS requests.
      checkServerIdentity: () => undefined,
      handshakeTimeout: 10000,
    });
    this.ws = ws;
    let alive = true;
    ws.on('upgrade', (res) => {
      const cert = res.socket && res.socket.getPeerCertificate && res.socket.getPeerCertificate();
      if (this.client.secure && this.client.pin && cert && cert.fingerprint256 && cert.fingerprint256 !== this.client.pin) {
        ws.terminate();
        this._retry('certificate changed', Object.assign(new Error('The camera\'s certificate changed'), { code: 'cert_changed' }));
      }
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({
        apiVersion: '1.0', context: 'homey', method: 'events:configure', params: { eventFilterList: this.filters },
      }));
      this.pingTimer = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, PING_MS);
    });
    ws.on('pong', () => { alive = true; });
    ws.on('message', (raw) => {
      alive = true;
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch (err) {
        return;
      }
      if (msg.method === 'events:configure') {
        if (msg.error) {
          this.log(`event subscription refused: ${msg.error.message || msg.error.code}`);
          this.emit('error', Object.assign(new Error(msg.error.message || 'Event subscription refused'), { code: 'not_supported' }));
          return;
        }
        this.delay = RECONNECT_MIN_MS;
        this.connected = true;
        this.emit('connected');
        return;
      }
      if (msg.method === 'events:notify' && msg.params && msg.params.notification) {
        const event = parseNotification(msg.params.notification);
        if (event) this.emit('event', event);
      }
    });
    ws.on('close', (code) => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.connected) {
        this.connected = false;
        this.emit('disconnected');
      }
      this._retry(`closed (${code})`);
    });
    ws.on('error', (err) => {
      // 'close' follows; just remember why.
      this.lastError = err.message;
    });
  }

  _retry(reason, err) {
    if (this.closed) return;
    this.log(`event stream ${reason}${this.lastError ? ` (${this.lastError})` : ''}; retrying in ${Math.round(this.delay / 1000)} s`);
    this.lastError = null;
    if (err) this.emit('error', err);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._connect(), this.delay);
    this.delay = Math.min(this.delay * 2, RECONNECT_MAX_MS);
  }

  stop() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.terminate();
    }
  }
}

// events:notify notification -> { topic, time, source, key, data }
function parseNotification(n) {
  if (!n || !n.topic) return null;
  const message = n.message || {};
  return {
    topic: n.topic,
    time: n.timestamp ? new Date(n.timestamp) : new Date(),
    source: message.source || {},
    key: message.key || {},
    data: message.data || {},
  };
}

module.exports = { EventStream, parseNotification };
