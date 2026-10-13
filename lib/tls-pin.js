'use strict';

// Certificate pinning for the cameras' self-signed HTTPS certificates.
//
// Axis devices ship with self-signed certificates, so normal certificate checks can't be
// used. The app remembers the certificate fingerprint when a camera is added (trust on
// first use) and refuses to talk to a device that presents a different one, so the login
// is never sent to another device that took over the address.

const https = require('node:https');
const tls = require('node:tls');
const { AxisError } = require('./errors');

// An https.Agent that only hands out connections whose certificate matches the pin.
// getPin() returns the stored fingerprint or null; with no pin yet, the first certificate
// seen is reported through onNewPin(fingerprint) and trusted.
class PinnedAgent extends https.Agent {
  constructor({ getPin, onNewPin, ...options }) {
    super({ keepAlive: true, maxSockets: 4, ...options, rejectUnauthorized: false });
    this.getPin = getPin;
    this.onNewPin = onNewPin;
  }

  createConnection(options, callback) {
    const socket = tls.connect({ ...options, servername: undefined, rejectUnauthorized: false });
    // Give up on a connection that never opens (no TLS handshake within the limit).
    const connectTimer = setTimeout(() => finish(new AxisError('unreachable', `No answer from ${options.host}`)), Number(options.timeout) || 10000);
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      if (err) {
        socket.destroy();
        callback(err);
      } else {
        callback(null, socket);
      }
    };
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const seen = cert && cert.fingerprint256;
      const pinned = this.getPin();
      if (!seen) return finish(new AxisError('unreachable', 'No certificate presented'));
      if (!pinned) {
        if (this.onNewPin) this.onNewPin(seen);
        return finish(null);
      }
      if (pinned !== seen) return finish(new AxisError('cert_changed', 'The camera\'s certificate changed'));
      return finish(null);
    });
    socket.once('error', (err) => finish(err));
    // Returning nothing: the request waits for the callback, so no data is sent before the check.
    return undefined;
  }
}

module.exports = { PinnedAgent };
