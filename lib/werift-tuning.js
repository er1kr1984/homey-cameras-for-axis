'use strict';

// Performance patches for werift, which runs every video packet through JavaScript.
// On Homey's small CPU these per-packet costs decide how much video the app can relay.
// Behaviour is unchanged (see test/werift-tuning.test.js):
//
// - SRTP: werift passes raw Buffer keys to crypto.createCipheriv/createHmac for every
//   packet, which makes Node rebuild a key object each time. Session keys are turned
//   into KeyObjects once (about 2x cheaper encryption).
// - RTP headers: werift parses header bits by converting each byte to a string of 0s
//   and 1s, and builds every header with 15 Object.defineProperty calls. Replaced by
//   plain bit arithmetic and ordinary property assignment.

const path = require('node:path');
const crypto = require('node:crypto');

const KEY_FIELDS = ['srtpSessionKey', 'srtcpSessionKey', 'srtpSessionAuthTag', 'srtcpSessionAuthTag'];

function toKeyObjects(cipher) {
  if (cipher._keyObjectsReady) return;
  for (const field of KEY_FIELDS) {
    if (Buffer.isBuffer(cipher[field])) cipher[field] = crypto.createSecretKey(cipher[field]);
  }
  cipher._keyObjectsReady = true;
}

function patchClass(Cls) {
  if (typeof Cls !== 'function') throw new Error('cipher class not found');
  if (Cls.prototype._tuned) return;
  for (const method of ['encryptRtp', 'decryptRtp', 'encryptRTCP', 'decryptRTCP']) {
    const original = Cls.prototype[method];
    if (typeof original !== 'function') continue;
    Cls.prototype[method] = function tuned(...args) {
      toKeyObjects(this);
      return original.apply(this, args);
    };
  }
  Cls.prototype._tuned = true;
}

function weriftRoot() {
  let root = path.dirname(require.resolve('werift'));
  while (path.basename(root) !== 'werift' && root !== path.dirname(root)) root = path.dirname(root);
  return root;
}

function patchGetBit(binary) {
  const original = binary.getBit;
  if (typeof original !== 'function') throw new Error('getBit not found');
  if (original._tuned) return;
  const fast = function getBit(bits, startIndex, length = 1) {
    if (bits > 255 || bits < 0 || startIndex + length > 8) return original(bits, startIndex, length);
    return (bits >> (8 - startIndex - length)) & ((1 << length) - 1);
  };
  fast._tuned = true;
  fast.original = original;
  binary.getBit = fast;
}

function patchRtpHeader(rtp) {
  const { RtpHeader, ExtensionProfiles } = rtp;
  if (typeof RtpHeader !== 'function' || typeof RtpHeader.deSerialize !== 'function'
    || typeof RtpHeader.prototype.serialize !== 'function' || !ExtensionProfiles) {
    throw new Error('RtpHeader layout changed');
  }
  if (RtpHeader._tuned) return;
  const originalDeSerialize = RtpHeader.deSerialize;
  const originalSerialize = RtpHeader.prototype.serialize;

  // Same fields, same order and same defaults as the RtpHeader constructor.
  const blank = () => {
    const h = Object.create(RtpHeader.prototype);
    h.version = 2;
    h.padding = false;
    h.paddingSize = 0;
    h.extension = false;
    h.marker = false;
    h.payloadOffset = 0;
    h.payloadType = 0;
    h.sequenceNumber = 0;
    h.timestamp = 0;
    h.ssrc = 0;
    h.csrcLength = 0;
    h.csrc = [];
    h.extensionProfile = ExtensionProfiles.OneByte;
    h.extensionLength = undefined;
    h.extensions = [];
    return h;
  };

  RtpHeader.deSerialize = function deSerialize(raw) {
    const b0 = raw[0];
    const h = blank();
    h.version = b0 >> 6;
    h.padding = (b0 & 0x20) !== 0;
    h.extension = (b0 & 0x10) !== 0;
    h.csrcLength = b0 & 0x0f;
    h.marker = (raw[1] & 0x80) !== 0;
    h.payloadType = raw[1] & 0x7f;
    h.sequenceNumber = raw.readUInt16BE(2);
    h.timestamp = raw.readUInt32BE(4);
    h.ssrc = raw.readUInt32BE(8);
    let offset = 12;
    for (let i = 0; i < h.csrcLength; i++) {
      h.csrc.push(raw.readUInt32BE(offset));
      offset += 4;
    }
    if (h.extension) {
      // Rare for our streams; keep werift's exact extension parsing.
      return originalDeSerialize.call(this, raw);
    }
    h.payloadOffset = offset;
    if (h.padding) h.paddingSize = raw[raw.length - 1];
    return h;
  };

  RtpHeader.prototype.serialize = function serialize(size) {
    if (this.extensions.length > 0 || this.extension) return originalSerialize.call(this, size);
    const buf = Buffer.alloc(size);
    buf[0] = ((this.version & 0x03) << 6) | (this.padding ? 0x20 : 0) | (this.csrc.length & 0x0f);
    buf[1] = (this.marker ? 0x80 : 0) | (this.payloadType & 0x7f);
    buf.writeUInt16BE(this.sequenceNumber, 2);
    buf.writeUInt32BE(this.timestamp, 4);
    buf.writeUInt32BE(this.ssrc, 8);
    let offset = 12;
    for (const csrc of this.csrc) {
      buf.writeUInt32BE(csrc, offset);
      offset += 4;
    }
    this.payloadOffset = offset;
    return buf;
  };

  RtpHeader._tuned = true;
  RtpHeader.originalDeSerialize = originalDeSerialize;
  RtpHeader.prototype.originalSerialize = originalSerialize;
}

// Applies each patch independently. A patch that no longer fits (e.g. after a werift
// upgrade) is skipped and reported; werift then simply runs its own, slower code.
// Returns the names of the patches that could not be applied.
function applyWeriftTuning() {
  const failed = [];
  const attempt = (name, fn) => {
    try {
      fn();
    } catch (err) {
      failed.push(`${name}: ${err.message}`);
    }
  };
  let root;
  attempt('locate werift', () => { root = weriftRoot(); });
  if (!root) return failed;
  // Deep paths are not in werift's package exports, so resolve them from its main entry.
  attempt('getBit', () => patchGetBit(require(path.join(root, 'lib', 'common', 'src', 'binary.js'))));
  attempt('RtpHeader', () => patchRtpHeader(require(path.join(root, 'lib', 'rtp', 'src', 'rtp', 'rtp.js'))));
  const dir = path.join(root, 'lib', 'rtp', 'src', 'srtp', 'cipher');
  attempt('SRTP GCM', () => patchClass(require(path.join(dir, 'gcm.js')).CipherAesGcm));
  attempt('SRTP CTR', () => patchClass(require(path.join(dir, 'ctr.js')).CipherAesCtr));
  return failed;
}

module.exports = { applyWeriftTuning, weriftRoot };
